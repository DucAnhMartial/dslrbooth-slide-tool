import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../src/logging/logger';

// ---------------------------------------------------------------------------
// The suite must not write into the operational log.
//
// Measured 2026-08-16: one `vitest run` deposited 20 `error` lines into
// `logs/extension-service-<today>.log` — the file an operator reads to find
// out what happened during an event. Every one was synthetic, manufactured by
// suites that exercise failure paths on purpose (`job-a ... boom`,
// `weird_unmapped_status`). Establishing that the live service was healthy
// that day meant reading the file and filtering fixtures out of it by hand.
//
// This case exists because that pollution is invisible from inside a test run:
// every suite passed while it was happening, and it would silently return the
// moment someone re-added a file transport unconditionally.
// ---------------------------------------------------------------------------

describe('logging under vitest', () => {
  it('runs with no file transport attached', () => {
    // NODE_ENV is pinned to 'test' by vitest.config.ts. If that ever changes,
    // this assertion is the first thing that should notice.
    expect(process.env.NODE_ENV).toBe('test');

    const fileLike = logger.transports.filter((t) => {
      const shape = t as unknown as { dirname?: unknown; filename?: unknown };
      return typeof shape.dirname === 'string' || typeof shape.filename === 'string';
    });
    expect(fileLike).toEqual([]);
  });

  it("leaves today's operational log untouched when it logs", () => {
    const logPath = path.join(
      process.cwd(),
      'logs',
      `extension-service-${new Date().toISOString().slice(0, 10)}.log`,
    );
    const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : null;

    // The exact shape of the lines that were leaking: an error a suite emits
    // deliberately while proving a failure path.
    logger.error('synthetic failure from logging-test-isolation.test.ts — must never reach the operational log');

    const after = fs.existsSync(logPath) ? fs.statSync(logPath).size : null;
    expect(after).toBe(before);
  });

  it('still logs — the transport is suppressed, the logger is not', () => {
    // The failure this guards against is over-correction: a logger with no
    // transports at all would satisfy both cases above while silently
    // swallowing every diagnostic a test relies on. Suites spy on
    // logger.warn/error to assert what was reported, so the methods must stay
    // live and callable.
    expect(logger.transports.length).toBeGreaterThan(0);
    expect(() => logger.warn('a warning a spying suite could observe')).not.toThrow();
  });
});
