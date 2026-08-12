import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger, labelLogger, setLogLevel, LOG_LEVELS } from '../src/logging/logger';

describe('setLogLevel() (Task 1 — SC-5, runtime half)', () => {
  let startingLevel: string;

  beforeEach(() => {
    startingLevel = logger.level;
  });

  afterEach(() => {
    // Never leak a raised level into an unrelated suite — vitest.config.ts
    // pins LOG_LEVEL: 'error' for the whole test run, and this file is the
    // one place that deliberately raises it.
    logger.level = startingLevel;
  });

  it('sets the level and reports previous/current/changed under the test env (LOG_LEVEL=error)', () => {
    expect(startingLevel).toBe('error');

    const result = setLogLevel('debug');

    expect(result).toEqual({ previous: 'error', current: 'debug', changed: true });
    expect(logger.level).toBe('debug');
  });

  it('a real labelLogger() child follows the parent level — measured, not assumed', () => {
    setLogLevel('debug');

    const child = labelLogger('queue');
    expect(child.isLevelEnabled('debug')).toBe(true);
  });

  it('returns changed: false and does not touch the level when the requested level already matches', () => {
    expect(logger.level).toBe('error');

    const result = setLogLevel('error');

    expect(result).toEqual({ previous: 'error', current: 'error', changed: false });
    expect(logger.level).toBe('error');
  });

  it('rejects an invalid level, leaves the level untouched, and emits exactly one warn naming the rejected value and the accepted vocabulary', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const before = logger.level;

      const result = setLogLevel('shouty');

      expect(result).toEqual({ previous: before, current: before, changed: false });
      expect(logger.level).toBe(before);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0];
      expect(String(message)).toContain('shouty');
      for (const level of LOG_LEVELS) {
        expect(String(message)).toContain(level);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('LOG_LEVELS is the single source of truth every accepted value belongs to', () => {
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']);
    for (const level of LOG_LEVELS) {
      const before = logger.level;
      const result = setLogLevel(level);
      expect(result.changed || level === before).toBe(true);
      expect(logger.level).toBe(level);
    }
  });
});
