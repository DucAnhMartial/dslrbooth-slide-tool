/**
 * An in-memory stand-in for the `pending_print` table's four accessors
 * (07-03-PLAN.md Task 1), for the mocked `LocalStore` objects the QueueService
 * suite builds.
 *
 * It lives in one shared file rather than being re-typed into each test's
 * `buildStore()` on purpose: the three-status semantics are the thing under
 * test, and five hand-copied maps would be five chances for a mock to drift
 * away from the SQL it is standing in for — at which point a test would pass
 * against semantics the database does not have. The real SQL is proved
 * separately, against a real temp-file database, in
 * test/local-store-persistence.test.ts.
 *
 * The semantics mirrored here, each pinned by a case in that file:
 *   - open   — first write wins; a second open for the same jobId returns
 *              false and mutates nothing (ON CONFLICT DO NOTHING).
 *   - get    — returns the row whatever its status, so the caller keeps all
 *              three answers: 'awaiting', 'expired', and "no row at all".
 *   - resolve— succeeds from 'awaiting' or 'expired' (D-11), never from
 *              'resolved' (no second notification for one job).
 *   - expire — returns only 'awaiting' rows already at or past expires_at,
 *              marks exactly those, and never returns one twice. Expired rows
 *              are marked, never deleted.
 */

export type PendingPrintStatus = 'awaiting' | 'resolved' | 'expired';

export interface PendingPrintRow {
  jobId: string;
  compositePath: string;
  status: PendingPrintStatus;
  openedAt: number;
  expiresAt: number;
}

export interface PendingPrintRegistry {
  openPendingPrint(entry: { jobId: string; compositePath: string; openedAt: number; expiresAt: number }): boolean;
  getPendingPrint(jobId: string): PendingPrintRow | undefined;
  resolvePendingPrint(jobId: string, resolvedAt: number): boolean;
  expirePendingPrints(now: number): Array<{ jobId: string; compositePath: string }>;
}

export function createPendingPrintRegistry(seed: PendingPrintRow[] = []): {
  registry: PendingPrintRegistry;
  rows: Map<string, PendingPrintRow>;
} {
  const rows = new Map<string, PendingPrintRow>();
  for (const row of seed) rows.set(row.jobId, { ...row });

  const registry: PendingPrintRegistry = {
    openPendingPrint(entry) {
      if (rows.has(entry.jobId)) return false;
      rows.set(entry.jobId, {
        jobId: entry.jobId,
        compositePath: entry.compositePath,
        status: 'awaiting',
        openedAt: entry.openedAt,
        expiresAt: entry.expiresAt,
      });
      return true;
    },
    getPendingPrint(jobId) {
      const row = rows.get(jobId);
      return row ? { ...row } : undefined;
    },
    resolvePendingPrint(jobId) {
      const row = rows.get(jobId);
      if (!row || row.status === 'resolved') return false;
      row.status = 'resolved';
      return true;
    },
    expirePendingPrints(now) {
      const expired: Array<{ jobId: string; compositePath: string }> = [];
      for (const row of rows.values()) {
        if (row.status === 'awaiting' && row.expiresAt <= now) {
          row.status = 'expired';
          expired.push({ jobId: row.jobId, compositePath: row.compositePath });
        }
      }
      return expired;
    },
  };

  return { registry, rows };
}
