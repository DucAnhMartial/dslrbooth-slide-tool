import logger from '../logging/logger';
import type { WaitRange } from './estimateWaitMs';

/**
 * D-11's closed vocabulary. These six values are the ENTIRE guest-facing status
 * language. `dispatched`, `in_progress`, `stall_reason`, `retries`,
 * `ack_error_message` and `TIMEOUT_RESET` are operator words from Phases 2-4
 * and none of them may cross this boundary.
 *
 * The union is derived from the array rather than declared twice, so the
 * runtime list a table-driven test iterates and the compile-time type the
 * router is checked against cannot drift apart.
 */
export const GUEST_STATUSES = [
  'waiting',
  'your_turn',
  'in_session',
  'finished_photo_sent',
  'finished_photo_pending',
  'see_staff',
] as const;

export type GuestStatus = typeof GUEST_STATUSES[number];

/**
 * D-12: the photo state is stated separately and honestly rather than folded
 * into the status word. A guest whose session finished but whose photo is
 * still being retried has genuinely finished; conflating the two would either
 * hide a real failure or invent one.
 *
 * Exported as an array for the same reason GUEST_STATUSES is: the vocabulary
 * test iterates the real runtime list rather than a copy of it, so the two
 * cannot drift apart.
 */
export const PHOTO_DELIVERY_STATES = ['sent', 'pending', 'failed'] as const;

export type PhotoDelivery = typeof PHOTO_DELIVERY_STATES[number];

/**
 * The complete `/status/:jobId` response contract. Exactly eight keys, with
 * `waitEstimate` optional — D-05 made structural: when the booth cannot serve,
 * the key is ABSENT rather than present and null, because an absent key cannot
 * be misread as a zero-minute promise.
 */
export interface GuestStatusResponse {
  jobId: string;
  queuePosition: number | null;
  queueLength: number;
  guestName: string | null;
  status: GuestStatus;
  photoDelivery: PhotoDelivery;
  boothPaused: boolean;
  waitEstimate?: WaitRange;
}

/**
 * The six real internal job statuses, transcribed from the comment at
 * types.ts:16 and confirmed against their only writers in localStore.ts
 * (`completeJob` writes 'completed', `failJob` writes 'failed',
 * `requeueWithRetry`/`requeueNoRetry` write 'queued', `updateJobStatus` writes
 * 'dispatched' and 'in_progress', and `closeJobNoPhoto` writes 'no_photo').
 * `QueueJob.status` is typed as a bare `string`, so this list is what gives
 * the mapping below something exhaustive to be checked against.
 *
 * The type is DERIVED from the array rather than declared beside it, which
 * makes the array the vocabulary test iterates and the type STATUS_MAP is
 * keyed by one single source. Adding a seventh member here without adding a
 * mapping below is a compile error — which is precisely the property D-12
 * asks for, and precisely what a `default:` arm would destroy. This is not a
 * theoretical claim: adding 'no_photo' below produced exactly that error
 * (TS2741) before its STATUS_MAP entry was written.
 *
 * A note on 'no_photo' for whoever adds the seventh: `in_progress` was this
 * list's only multi-token value before it, so 'no_photo' is the second. It is
 * also a noun phrase where the other two terminal statuses ('completed',
 * 'failed') are past participles — a real if small inconsistency, accepted
 * knowingly because the alternatives were worse. 'no_print' would name the
 * anchor rather than the outcome and reads as a printer fault in a room where
 * printing is a physical event; a blame-carrying single participle would
 * fight D-03, which exists because this outcome is nobody's fault.
 */
export const KNOWN_JOB_STATUSES = [
  'queued',
  'dispatched',
  'in_progress',
  'completed',
  'failed',
  'no_photo',
] as const;

export type InternalJobStatus = typeof KNOWN_JOB_STATUSES[number];

export interface GuestStatusInput {
  jobStatus: string;
  announced: boolean;
  photoDelivery: PhotoDelivery;
}

/**
 * A `Record` keyed by the full internal union, NOT a switch with a default.
 * The difference is the point: adding a sixth internal status to
 * `InternalJobStatus` without adding a mapping here is a TypeScript error,
 * whereas a `default:` arm would silently absorb it. D-12 requires the mapping
 * be exhaustive — an unmapped internal state is a defect, not a default.
 */
const STATUS_MAP: Record<InternalJobStatus, (input: GuestStatusInput) => GuestStatus> = {
  queued: ({ announced }) => (announced ? 'your_turn' : 'waiting'),
  dispatched: () => 'your_turn',
  in_progress: () => 'in_session',
  completed: ({ photoDelivery }) =>
    photoDelivery === 'sent' ? 'finished_photo_sent' : 'finished_photo_pending',
  // D-12: a job that exhausted Phase 2's retry budget must not leave the guest
  // polling a queue position forever. It resolves to "please see staff".
  failed: () => 'see_staff',
  // Phase 7 D-10: the session ended with no print composite ever seen. This
  // returns the SAME guest word as `failed` deliberately — from the guest's
  // side the required action is identical: go find a person. A seventh guest
  // word would name the situation without telling them what to do, so the
  // closed six-word vocabulary Phase 5 established (D-11) is NOT reopened.
  // The operator-side distinction is carried by the internal status itself,
  // which is persisted, and by the guest's separate `photoDelivery` field.
  //
  // Do not replace this Record with a switch, and do not add a fall-through
  // arm to it. The exhaustiveness of this mapping is the entire mechanism
  // D-09 chose a status over a reason column for: adding a member to
  // KNOWN_JOB_STATUSES without adding a line here is a compile error
  // (TS2741, observed while this very entry was being added), whereas a
  // fall-through would absorb the next new status in silence.
  no_photo: () => 'see_staff',
};

export function toGuestStatus(input: GuestStatusInput): GuestStatus {
  const resolve = STATUS_MAP[input.jobStatus as InternalJobStatus];

  if (!resolve) {
    // Loud in the operator's log, quiet on the guest's phone. Returning a 500
    // here would punish a guest who did nothing wrong for a defect that is
    // entirely ours; returning 'see_staff' routes them to a human, which is
    // the correct real-world action for a state the system cannot explain.
    logger.error(`Unmapped internal job status "${input.jobStatus}" reached the guest status boundary`);
    return 'see_staff';
  }

  return resolve(input);
}

/**
 * Phase 4's notification_record status, translated to the guest's vocabulary.
 * Everything that is neither delivered nor terminally failed — including a
 * missing record entirely — is honestly still pending.
 *
 * `jobStatus` is optional so that every existing single-argument call site
 * keeps compiling AND keeps its exact previous result; omitting it is
 * indistinguishable from the Phase 4 one-argument function.
 *
 * THE ORDER OF THESE FOUR LINES IS LOAD-BEARING — do not reorder them.
 * D-11 requires that a print arriving after a job was already closed as
 * `no_photo` is still delivered to the guest; once it HAS been delivered, the
 * guest's photo state must read 'sent', not 'failed'. So the notification's
 * own terminal verdicts are consulted FIRST, and the outcome word only decides
 * the case where the notification has nothing to say. Hoisting the jobStatus
 * check above the 'delivered' check would tell a guest holding their photo
 * that it failed.
 */
export function toPhotoDelivery(notificationStatus?: string, jobStatus?: string): PhotoDelivery {
  if (notificationStatus === 'delivered') return 'sent';
  if (notificationStatus === 'failed') return 'failed';
  // No photo was ever produced, so 'pending' would be a promise the system
  // already knows it cannot keep.
  if (jobStatus === 'no_photo') return 'failed';
  return 'pending';
}
