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
 */
export type PhotoDelivery = 'sent' | 'pending' | 'failed';

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
 * The five real internal job statuses, transcribed from the comment at
 * types.ts:16. `QueueJob.status` is typed as a bare `string`, so this union is
 * what gives the mapping below something exhaustive to be checked against.
 */
type InternalJobStatus = 'queued' | 'dispatched' | 'in_progress' | 'completed' | 'failed';

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
 */
export function toPhotoDelivery(notificationStatus?: string): PhotoDelivery {
  if (notificationStatus === 'delivered') return 'sent';
  if (notificationStatus === 'failed') return 'failed';
  return 'pending';
}
