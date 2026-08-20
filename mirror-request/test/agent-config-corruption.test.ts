import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';
import { DEFAULT_AGENT_CONFIG, readAgentConfigForAgent } from '../src/agent/agentConfigContract';

// ---------------------------------------------------------------------------
// Phase 8 code review, WR-07 — a corrupt blob must not eat the good one.
//
// `getAgentConfig()` returned `undefined` for BOTH "no row yet" and "the row
// is not valid JSON". `readAgentConfigForAgent()` reads that single
// `undefined` as "never configured" and seeds the defaults with a SAVE — and
// `saveAgentConfig()`'s UPSERT rotates the outgoing current into
// `previous_json`. So a corrupt current_json ends up:
//
//   before:  current = <corrupt>   previous = <the operator's last good save>
//   after:   current = <defaults>  previous = <corrupt>
//
// D-18 promises one step back. This destroys it at precisely the moment it
// would be reached for — the operator opens the CMS to fix a broken booth and
// finds the restore button now restores garbage.
//
// It needs external corruption to trigger; no writer in this codebase can
// produce it. That is why it is a warning and not a critical. It is also why
// it was untested: every path the suite could reach wrote valid JSON.
//
// The second half of this file covers the same failure class on the OTHER
// side of the pair. `restorePreviousAgentConfig()` wrote previous_json into
// current_json and only THEN tried to parse it, so a corrupt previous_json
// destroyed a perfectly good current one and returned undefined. That was not
// in the review's finding; it is the same defect reached from the other end,
// and fixing one without the other would have left the hole open.
// ---------------------------------------------------------------------------

const GOOD_A = { logLevel: 'warn', autoOpenDisplay: false, dslrBoothApiPort: 1500 };
const GOOD_B = { logLevel: 'debug', autoOpenDisplay: true, dslrBoothApiPort: 1600 };
const CORRUPT = '{not json at all';

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeStore(): { store: LocalStore; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-corrupt-'));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'test.sqlite');
  const store = new LocalStore(dbPath);
  openStores.push(store);
  return { store, dbPath };
}

/** Writes a blob no code path in this repository can produce. */
function corrupt(dbPath: string, column: 'current_json' | 'previous_json'): void {
  const raw = new Database(dbPath);
  raw.prepare(`UPDATE agent_config SET ${column} = ? WHERE id = 1`).run(CORRUPT);
  raw.close();
}

function readRaw(dbPath: string): { current_json: string; previous_json: string | null } {
  const raw = new Database(dbPath);
  const row = raw.prepare('SELECT current_json, previous_json FROM agent_config WHERE id = 1').get() as {
    current_json: string;
    previous_json: string | null;
  };
  raw.close();
  return row;
}

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('WR-07: a corrupt agent_config row does not destroy the one step back (D-18)', () => {
  it('answering an Agent over a corrupt current_json leaves previous_json intact', () => {
    const { store, dbPath } = makeStore();
    store.saveAgentConfig(GOOD_A);
    store.saveAgentConfig(GOOD_B); // previous_json = GOOD_A
    corrupt(dbPath, 'current_json');

    const answered = readAgentConfigForAgent(store);

    // The Agent still gets a usable answer — a booth asking for its config
    // must never be told nothing.
    expect(answered).toEqual(DEFAULT_AGENT_CONFIG);
    // And the operator's step back is still there. This is the assertion that
    // fails before the fix: previous_json held CORRUPT, so this returned
    // undefined.
    expect(store.restorePreviousAgentConfig()).toEqual(GOOD_A);
  });

  it('reading a corrupt row writes nothing at all', () => {
    const { store, dbPath } = makeStore();
    store.saveAgentConfig(GOOD_A);
    store.saveAgentConfig(GOOD_B);
    corrupt(dbPath, 'current_json');
    const before = readRaw(dbPath);

    readAgentConfigForAgent(store);

    // Not "previous survived" but "the read was a read". A seed that happened
    // to preserve previous_json by luck would pass the case above and fail
    // this one.
    expect(readRaw(dbPath)).toEqual(before);
  });

  it('restoring a corrupt previous_json leaves the current configuration alone', () => {
    const { store, dbPath } = makeStore();
    store.saveAgentConfig(GOOD_A);
    store.saveAgentConfig(GOOD_B);
    corrupt(dbPath, 'previous_json');

    expect(store.restorePreviousAgentConfig()).toBeUndefined();
    // Before the fix the UPDATE ran first and this read back CORRUPT: an
    // unusable restore that also took the working configuration with it.
    expect(store.getAgentConfig()).toEqual(GOOD_B);
  });

  // -------------------------------------------------------------------------
  // Non-vacuity. Both pass BEFORE the fix. They pin that "never seed" is not
  // the fix — a booth that has genuinely never been configured must still get
  // the shipped defaults written, or every restart re-answers from nothing.
  // -------------------------------------------------------------------------

  it('a genuinely absent row is still seeded and persisted', () => {
    const { store } = makeStore();
    expect(store.getAgentConfig()).toBeUndefined();

    expect(readAgentConfigForAgent(store)).toEqual(DEFAULT_AGENT_CONFIG);
    expect(store.getAgentConfig()).toEqual(DEFAULT_AGENT_CONFIG);
    // A seed is an INSERT, so there is nothing behind it to step back to.
    expect(store.restorePreviousAgentConfig()).toBeUndefined();
  });

  it('a healthy row is answered from storage, not from the defaults', () => {
    const { store } = makeStore();
    store.saveAgentConfig(GOOD_B);

    expect(readAgentConfigForAgent(store)).toEqual(GOOD_B);
  });
});
