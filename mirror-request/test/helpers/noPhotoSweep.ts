/**
 * The stand-in for `LocalStore.getJobsAwaitingNoPhotoClose()` (07-04) in the
 * mocked `LocalStore` objects the QueueService suite builds.
 *
 * `QueueService.tick()` sweeps for no-photo candidates on every interval, so
 * every mocked store the service is constructed with must carry this surface
 * — exactly as they all had to gain the pending-print registry's four
 * accessors in 07-03.
 *
 * It returns an empty candidate list on purpose. None of the suites that
 * spread this stub exercises the sweep: they predate it and test dispatch,
 * countdown, recovery, retry and release-timer behaviour instead, and a stub
 * that invented candidates would inject a job-status write into tests that
 * never asked for one. The sweep's real behaviour is pinned in two dedicated
 * places, neither of which uses this stub:
 *
 *   - test/queue-no-photo-outcome.test.ts models all four predicates at the
 *     service seam, including the stray-session_end regression case.
 *   - test/local-store-persistence.test.ts proves the SQL itself against a
 *     real temp-file database.
 *
 * It lives in one shared file rather than being re-typed into sixteen store
 * literals for the reason the pendingPrintRegistry helper gives: a hand-copied
 * stub is a chance for a mock to drift away from the real signature, at which
 * point a test passes against a store shape the database does not have.
 */
export const NO_PHOTO_SWEEP_STUB = {
  getJobsAwaitingNoPhotoClose: (_cutoff: number, _currentJobId?: string): string[] => [],
};
