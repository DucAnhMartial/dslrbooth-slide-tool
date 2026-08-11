import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Vitest globalTeardown — deletes the per-test SQLite files the suite creates.
 *
 * Why this exists: from plan 01-02 onward, tests construct their own
 * `LocalStore(dbPath)` via the constructor seam instead of sharing the
 * `getStore()` singleton (WINDOWS ledger item 4). That is the correct pattern
 * and must not change — but each such test writes a real file under `data/`
 * and nothing removed them. Measured 2026-08-11: 159 files / 16MB had
 * accumulated, growing by 12 files (~1.5MB) per full run.
 *
 * Deliberately scoped to the `test-` prefix. `data/extension-service.sqlite`
 * is the real local store and `data/backups/` holds the pre-migration backups
 * taken at the Phase 4 gate; neither may ever match this glob. The prefix is
 * checked with startsWith on the basename — not a substring search — so a file
 * merely containing "test" elsewhere in its name is not caught.
 */
export function teardown(): void {
  const dataDir = join(process.cwd(), 'data');

  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return; // no data/ dir — nothing to clean, not an error
  }

  for (const name of entries) {
    if (!name.startsWith('test-')) continue;
    if (!/\.sqlite(-shm|-wal)?$/.test(name)) continue;
    try {
      rmSync(join(dataDir, name), { force: true });
    } catch {
      // A worker may still hold a handle on Windows; leaving one file behind
      // is harmless and must never fail the run.
    }
  }
}
