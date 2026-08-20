import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../src/logging/logger';
import {
  GUEST_STATUSES,
  KNOWN_JOB_STATUSES,
  PHOTO_DELIVERY_STATES,
  toGuestStatus,
  toPhotoDelivery,
  type GuestStatus,
  type PhotoDelivery,
} from '../src/status/guestStatus';

/**
 * Pure unit test: no DB, no server, no store. The subject is D-11's closed
 * vocabulary and D-12's exhaustiveness requirement, both of which live entirely
 * in guestStatus.ts.
 *
 * The cross-product below is built by iterating the arrays the IMPLEMENTATION
 * exports, never by copying their contents into this file. That is the whole
 * point: a copy would let the test and the mapping drift apart silently, and
 * the drift would surface as a guest being shown an operator word.
 */

const ANNOUNCED_VALUES = [false, true] as const;

// The expected guest word for every one of the 36 combinations, written out as
// literal data rather than recomputed from a rule. A rule here would be a
// second implementation of the mapping, and two copies of a rule agree with
// each other even when both are wrong.
const EXPECTED: Record<string, GuestStatus> = {
  // A guest still in line who has not been called: waiting, regardless of what
  // their (not yet taken) photo is doing.
  'queued|sent|false': 'waiting',
  'queued|pending|false': 'waiting',
  'queued|failed|false': 'waiting',
  // The announcement is what turns waiting into "go now".
  'queued|sent|true': 'your_turn',
  'queued|pending|true': 'your_turn',
  'queued|failed|true': 'your_turn',

  // Dispatched means the command is already at the booth — the guest should be
  // walking to it whether or not the countdown is still on screen.
  'dispatched|sent|false': 'your_turn',
  'dispatched|pending|false': 'your_turn',
  'dispatched|failed|false': 'your_turn',
  'dispatched|sent|true': 'your_turn',
  'dispatched|pending|true': 'your_turn',
  'dispatched|failed|true': 'your_turn',

  'in_progress|sent|false': 'in_session',
  'in_progress|pending|false': 'in_session',
  'in_progress|failed|false': 'in_session',
  'in_progress|sent|true': 'in_session',
  'in_progress|pending|true': 'in_session',
  'in_progress|failed|true': 'in_session',

  // D-12: a completed session is FINISHED. The photo's fate is carried by the
  // separate photoDelivery field, not by inventing a seventh status word — and
  // a photo that terminally failed still reads as "pending" here because the
  // honest detail belongs in the field that exists to state it.
  'completed|sent|false': 'finished_photo_sent',
  'completed|pending|false': 'finished_photo_pending',
  'completed|failed|false': 'finished_photo_pending',
  'completed|sent|true': 'finished_photo_sent',
  'completed|pending|true': 'finished_photo_pending',
  'completed|failed|true': 'finished_photo_pending',

  // D-12's headline case: a job that exhausted Phase 2's retry budget must
  // never leave a guest polling a queue position for a job that will not run.
  'failed|sent|false': 'see_staff',
  'failed|pending|false': 'see_staff',
  'failed|failed|false': 'see_staff',
  'failed|sent|true': 'see_staff',
  'failed|pending|true': 'see_staff',
  'failed|failed|true': 'see_staff',

  // Phase 7 D-09/D-10: the session ended with no print composite ever seen.
  // It resolves to the SAME guest word as 'failed' on all six rows, because
  // from the guest's side the required action is identical — go find a person.
  // The operator-side distinction is carried by the internal status itself,
  // not by a seventh guest word; the guest's photo state is carried by the
  // separate photoDelivery field, which is why all three photo values appear
  // here and none of them changes the answer.
  'no_photo|sent|false': 'see_staff',
  'no_photo|pending|false': 'see_staff',
  'no_photo|failed|false': 'see_staff',
  'no_photo|sent|true': 'see_staff',
  'no_photo|pending|true': 'see_staff',
  'no_photo|failed|true': 'see_staff',
};

interface Combination {
  jobStatus: string;
  photoDelivery: PhotoDelivery;
  announced: boolean;
  key: string;
}

function crossProduct(): Combination[] {
  const combos: Combination[] = [];
  for (const jobStatus of KNOWN_JOB_STATUSES) {
    for (const photoDelivery of PHOTO_DELIVERY_STATES) {
      for (const announced of ANNOUNCED_VALUES) {
        combos.push({
          jobStatus,
          photoDelivery,
          announced,
          key: `${jobStatus}|${photoDelivery}|${announced}`,
        });
      }
    }
  }
  return combos;
}

describe('D-11/D-12 — the guest-facing vocabulary is exhaustive and closed', () => {
  describe('the full cross-product of internal states', () => {
    it('is exactly 6 job statuses x 3 photo states x 2 announced values = 36 combinations', () => {
      const combos = crossProduct();

      // Asserted against the product of the implementation's own array lengths
      // AND against the literal 36 measured when D-09's sixth status landed.
      // The first catches a future narrowing of either array; the second
      // catches both arrays being changed together in a way that quietly
      // shrinks coverage.
      expect(KNOWN_JOB_STATUSES.length).toBe(6);
      expect(PHOTO_DELIVERY_STATES.length).toBe(3);
      expect(combos).toHaveLength(
        KNOWN_JOB_STATUSES.length * PHOTO_DELIVERY_STATES.length * ANNOUNCED_VALUES.length,
      );
      expect(combos).toHaveLength(36);

      // Every combination is distinct — a duplicated key would let the count
      // be right while a real combination went untested.
      expect(new Set(combos.map((c) => c.key)).size).toBe(36);
    });

    it('resolves every one of the 36 combinations to one of the six guest words', () => {
      const combos = crossProduct();
      let iterations = 0;

      for (const combo of combos) {
        const result = toGuestStatus({
          jobStatus: combo.jobStatus,
          announced: combo.announced,
          photoDelivery: combo.photoDelivery,
        });

        expect(GUEST_STATUSES, `combination ${combo.key} escaped the closed vocabulary`)
          .toContain(result);
        iterations += 1;
      }

      // The iteration counts itself: a future narrowing of either exported
      // array cannot silently shrink this test's coverage to a passing subset.
      expect(iterations).toBe(36);
    });

    it('resolves every one of the 36 combinations to the exact expected word', () => {
      const combos = crossProduct();

      // The literal table and the generated cross-product must cover exactly
      // the same key set, in both directions. This is what stops the table
      // above from drifting away from the implementation's arrays.
      expect(combos.map((c) => c.key).sort()).toEqual(Object.keys(EXPECTED).sort());

      for (const combo of combos) {
        const result = toGuestStatus({
          jobStatus: combo.jobStatus,
          announced: combo.announced,
          photoDelivery: combo.photoDelivery,
        });

        expect(result, `combination ${combo.key}`).toBe(EXPECTED[combo.key]);
      }
    });

    it('never returns an internal operator word for any of the 36 combinations', () => {
      const combos = crossProduct();

      for (const combo of combos) {
        const result: string = toGuestStatus({
          jobStatus: combo.jobStatus,
          announced: combo.announced,
          photoDelivery: combo.photoDelivery,
        });

        // Asserted against KNOWN_JOB_STATUSES itself rather than a hand-typed
        // list, so the forbidden set and the real internal set cannot drift.
        expect(KNOWN_JOB_STATUSES as readonly string[], `combination ${combo.key}`)
          .not.toContain(result);

        // Stronger than equality: an internal word must not appear even as a
        // substring of a guest word.
        for (const internal of KNOWN_JOB_STATUSES) {
          expect(result, `combination ${combo.key} contains "${internal}"`)
            .not.toContain(internal);
        }
      }
    });
  });

  describe('D-12 — the fault states specifically', () => {
    it('resolves failed to see_staff for all three photo states and both announced values', () => {
      let rows = 0;

      for (const photoDelivery of PHOTO_DELIVERY_STATES) {
        for (const announced of ANNOUNCED_VALUES) {
          const result = toGuestStatus({ jobStatus: 'failed', announced, photoDelivery });
          expect(result).toBe('see_staff');
          rows += 1;
        }
      }

      // A guest whose job exhausted the retry budget is never told to keep
      // waiting, and never handed a queue position — 'waiting' and 'your_turn'
      // are unreachable from 'failed' on every one of these rows.
      expect(rows).toBe(6);
    });

    it('resolves a completed session to finished even when the photo terminally failed', () => {
      expect(toGuestStatus({ jobStatus: 'completed', announced: false, photoDelivery: 'failed' }))
        .toBe('finished_photo_pending');
      expect(toGuestStatus({ jobStatus: 'completed', announced: false, photoDelivery: 'pending' }))
        .toBe('finished_photo_pending');
      expect(toGuestStatus({ jobStatus: 'completed', announced: false, photoDelivery: 'sent' }))
        .toBe('finished_photo_sent');
    });

    it('turns waiting into your_turn on the announcement and not before', () => {
      expect(toGuestStatus({ jobStatus: 'queued', announced: false, photoDelivery: 'pending' }))
        .toBe('waiting');
      expect(toGuestStatus({ jobStatus: 'queued', announced: true, photoDelivery: 'pending' }))
        .toBe('your_turn');
    });
  });

  describe('closedness of the guest vocabulary', () => {
    it('has exactly six guest-facing words and no seventh', () => {
      expect(GUEST_STATUSES).toHaveLength(6);
      expect([...GUEST_STATUSES].sort()).toEqual([
        'finished_photo_pending',
        'finished_photo_sent',
        'in_session',
        'see_staff',
        'waiting',
        'your_turn',
      ]);
    });

    it('lists the six real internal job statuses and the three photo-delivery states', () => {
      expect([...KNOWN_JOB_STATUSES].sort()).toEqual([
        'completed',
        'dispatched',
        'failed',
        'in_progress',
        'no_photo',
        'queued',
      ]);
      expect([...PHOTO_DELIVERY_STATES].sort()).toEqual(['failed', 'pending', 'sent']);
    });
  });

  describe('an unmapped internal state is loud, not silent', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(logger, 'error');
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it('returns see_staff and logs exactly one error naming the offending value', () => {
      const result = toGuestStatus({
        jobStatus: 'stalled',
        announced: false,
        photoDelivery: 'pending',
      });

      // The guest is routed to a human, which is the correct real-world action
      // for a state the system cannot explain — not a 500 that punishes them
      // for a defect that is entirely ours.
      expect(result).toBe('see_staff');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('stalled');
    });

    it('is loud for an empty status too, and still returns a guest word', () => {
      const result = toGuestStatus({ jobStatus: '', announced: true, photoDelivery: 'sent' });

      expect(GUEST_STATUSES).toContain(result);
      expect(result).toBe('see_staff');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('does not log for any of the 36 mapped combinations', () => {
      for (const combo of crossProduct()) {
        toGuestStatus({
          jobStatus: combo.jobStatus,
          announced: combo.announced,
          photoDelivery: combo.photoDelivery,
        });
      }

      // Loudness that fired on healthy states would train an operator to
      // ignore the one line that matters.
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('toPhotoDelivery — Phase 4 notification status to guest vocabulary', () => {
    it('maps delivered to sent and failed to failed', () => {
      expect(toPhotoDelivery('delivered')).toBe('sent');
      expect(toPhotoDelivery('failed')).toBe('failed');
    });

    it('maps every not-yet-terminal state, a missing record, and an unknown string to pending', () => {
      expect(toPhotoDelivery('pending')).toBe('pending');
      expect(toPhotoDelivery('retrying')).toBe('pending');
      expect(toPhotoDelivery('sending')).toBe('pending');
      expect(toPhotoDelivery(undefined)).toBe('pending');
      // An unrecognised value is honestly "not yet delivered" rather than a
      // fabricated success or a fabricated failure.
      expect(toPhotoDelivery('some_status_phase_4_has_not_invented_yet')).toBe('pending');
    });

    it('only ever returns a member of PHOTO_DELIVERY_STATES', () => {
      const inputs = ['delivered', 'failed', 'pending', 'retrying', 'sending', '', undefined];

      for (const input of inputs) {
        expect(PHOTO_DELIVERY_STATES as readonly string[]).toContain(toPhotoDelivery(input));
      }
    });
  });

  describe('toPhotoDelivery — the optional jobStatus argument (D-09/D-10/D-11)', () => {
    it('reports a no_photo session with no notification record as a failed photo', () => {
      // The honest answer for a session that produced nothing: there is no
      // photo coming, so 'pending' would be a promise the system cannot keep.
      expect(toPhotoDelivery(undefined, 'no_photo')).toBe('failed');
    });

    it('lets a genuinely delivered photo outrank the no_photo outcome (D-11)', () => {
      // D-11: a print that arrives after the job was closed as no-photo is
      // still delivered. Once it HAS been delivered the guest's photo state
      // must read 'sent' — the outcome word describes the session, not the
      // photo's eventual fate. This is why the delivered check runs first.
      expect(toPhotoDelivery('delivered', 'no_photo')).toBe('sent');
    });

    it('reports a terminally failed notification as failed regardless of the outcome word', () => {
      expect(toPhotoDelivery('failed', 'no_photo')).toBe('failed');
      expect(toPhotoDelivery('failed', 'completed')).toBe('failed');
    });

    it('leaves every non-no_photo job status to the notification status alone', () => {
      // The second argument must change the answer for exactly one job status.
      // Any other status keeps the Phase 4 behaviour byte-for-byte.
      for (const jobStatus of KNOWN_JOB_STATUSES) {
        if (jobStatus === 'no_photo') continue;

        expect(toPhotoDelivery(undefined, jobStatus), `jobStatus ${jobStatus}`).toBe('pending');
        expect(toPhotoDelivery('sending', jobStatus), `jobStatus ${jobStatus}`).toBe('pending');
        expect(toPhotoDelivery('delivered', jobStatus), `jobStatus ${jobStatus}`).toBe('sent');
      }
    });

    it('keeps every single-argument call site meaning exactly what it meant before', () => {
      // The parameter is optional precisely so that the existing call sites and
      // their tests keep compiling AND keep their result. Omitting it must be
      // indistinguishable from Phase 4's one-argument function.
      expect(toPhotoDelivery('delivered')).toBe('sent');
      expect(toPhotoDelivery('failed')).toBe('failed');
      expect(toPhotoDelivery('pending')).toBe('pending');
      expect(toPhotoDelivery(undefined)).toBe('pending');
      expect(toPhotoDelivery(undefined, undefined)).toBe('pending');
    });

    it('only ever returns a member of PHOTO_DELIVERY_STATES on the two-argument path', () => {
      for (const notificationStatus of ['delivered', 'failed', 'sending', '', undefined]) {
        for (const jobStatus of [...KNOWN_JOB_STATUSES, 'some_future_status', '', undefined]) {
          expect(PHOTO_DELIVERY_STATES as readonly string[])
            .toContain(toPhotoDelivery(notificationStatus, jobStatus));
        }
      }
    });
  });
});
