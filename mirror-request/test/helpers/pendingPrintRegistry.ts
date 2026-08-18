/**
 * An in-memory stand-in for the `pending_print` table's accessors, for the
 * mocked `LocalStore` objects the QueueService suite builds.
 *
 * It lives in one shared file rather than being re-typed into each test's
 * `buildStore()` on purpose: the semantics are the thing under test, and
 * hand-copied maps would be chances for a mock to drift away from the SQL it
 * is standing in for — at which point a test would pass against semantics
 * the database does not have. The real SQL is proved separately, against a
 * real temp-file database, in test/local-store-persistence.test.ts.
 *
 * D11-01..D11-05 (phase 11) extended this in place rather than forking it —
 * every file importing it (queue-dual-completion.test.ts,
 * queue-file-upload-print.test.ts, queue-config-injection.test.ts,
 * queue-retake-anchor.test.ts, queue-print-registry-expiry.test.ts,
 * queue-release-timer.test.ts) picks up the new shape together. The old
 * single-status `resolvePendingPrint` member is GONE, replaced by
 * `markPendingPrintFinalized` (D11-05) — any importer still calling the old
 * name breaks at the call site, which is the intended signal that its own
 * fixture predates this phase's model and is owned by a later plan in this
 * phase (11-02).
 *
 * The semantics mirrored here, each pinned by a case in
 * test/local-store-persistence.test.ts:
 *   - openOrOverwritePendingPrint — first write for a jobId opens the slot;
 *     a second call with the SAME composite path leaves it unchanged; a
 *     second call with a DIFFERENT composite path overwrites the composite,
 *     attempt number and deadline, and clears any prior photoUrl/approval
 *     (a genuinely new attempt discards the old one's answers).
 *   - getPendingPrint — returns the row whatever its status, so the caller
 *     keeps all three answers: 'awaiting', 'expired', and "no row at all".
 *   - setPendingPrintPhotoUrl — writes the URL without touching status;
 *     succeeds only while the slot is still 'awaiting' or 'expired'.
 *   - markPendingPrintFinalized — succeeds once, from 'awaiting' or
 *     'expired', never twice (idempotent, D11-05's one finalize gate); a
 *     job with no slot at all still finalizes, by inserting a resolved row
 *     directly (the empty-session case, Q3 in 11-CONTEXT.md).
 *   - expirePendingPrints — returns only 'awaiting' rows already at or past
 *     expires_at, marks exactly those, and never returns one twice. Expired
 *     rows are marked, never deleted.
 */

export type PendingPrintStatus = 'awaiting' | 'resolved' | 'expired';
export type ApprovalDoor = 'printing' | 'grace' | 'operator';
export type PendingPrintOverwriteOutcome = 'opened' | 'overwritten' | 'unchanged';

export interface PendingPrintRow {
  jobId: string;
  compositePath: string;
  status: PendingPrintStatus;
  openedAt: number;
  expiresAt: number;
  photoUrl?: string;
  attemptNo?: number;
  approvedBy?: ApprovalDoor;
  approvedAt?: number;
}

export interface PendingPrintRegistry {
  openOrOverwritePendingPrint(entry: {
    jobId: string; compositePath: string; attemptNo: number; openedAt: number; expiresAt: number;
  }): PendingPrintOverwriteOutcome;
  getPendingPrint(jobId: string): PendingPrintRow | undefined;
  setPendingPrintPhotoUrl(jobId: string, photoUrl: string): boolean;
  markPendingPrintFinalized(jobId: string, approvedBy: ApprovalDoor, approvedAt: number): {
    matched: boolean; photoUrl: string | undefined; attemptNo: number | undefined;
  };
  expirePendingPrints(now: number): Array<{ jobId: string; compositePath: string }>;
}

export function createPendingPrintRegistry(seed: PendingPrintRow[] = []): {
  registry: PendingPrintRegistry;
  rows: Map<string, PendingPrintRow>;
} {
  const rows = new Map<string, PendingPrintRow>();
  for (const row of seed) rows.set(row.jobId, { ...row });

  const registry: PendingPrintRegistry = {
    openOrOverwritePendingPrint(entry) {
      const existing = rows.get(entry.jobId);
      if (!existing) {
        rows.set(entry.jobId, {
          jobId: entry.jobId,
          compositePath: entry.compositePath,
          status: 'awaiting',
          openedAt: entry.openedAt,
          expiresAt: entry.expiresAt,
          attemptNo: entry.attemptNo,
        });
        return 'opened';
      }
      if (existing.compositePath === entry.compositePath) {
        return 'unchanged';
      }
      existing.compositePath = entry.compositePath;
      existing.attemptNo = entry.attemptNo;
      existing.openedAt = entry.openedAt;
      existing.expiresAt = entry.expiresAt;
      existing.photoUrl = undefined;
      existing.approvedBy = undefined;
      existing.approvedAt = undefined;
      return 'overwritten';
    },
    getPendingPrint(jobId) {
      const row = rows.get(jobId);
      return row ? { ...row } : undefined;
    },
    setPendingPrintPhotoUrl(jobId, photoUrl) {
      const row = rows.get(jobId);
      if (!row || (row.status !== 'awaiting' && row.status !== 'expired')) return false;
      row.photoUrl = photoUrl;
      return true;
    },
    markPendingPrintFinalized(jobId, approvedBy, approvedAt) {
      const row = rows.get(jobId);
      if (row) {
        if (row.status !== 'awaiting' && row.status !== 'expired') {
          return { matched: false, photoUrl: undefined, attemptNo: undefined };
        }
        const photoUrl = row.photoUrl;
        const attemptNo = row.attemptNo;
        row.status = 'resolved';
        row.approvedBy = approvedBy;
        row.approvedAt = approvedAt;
        return { matched: true, photoUrl, attemptNo };
      }
      // No slot was ever opened for this job — an unapproved attempt that
      // produced no composite at all still finalizes (Q3), by inserting a
      // resolved row directly, mirroring the real SQL's INSERT branch.
      rows.set(jobId, {
        jobId,
        compositePath: '',
        status: 'resolved',
        openedAt: approvedAt,
        expiresAt: approvedAt,
        approvedBy,
        approvedAt,
      });
      return { matched: true, photoUrl: undefined, attemptNo: undefined };
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
