import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger, labelLogger, setLogLevel, LOG_LEVELS } from '../src/logging/logger';
import { reloadLogLevelFromEnvFile, registerLogLevelSignalHandler } from '../src/ops/logLevelControl';

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

describe('reloadLogLevelFromEnvFile() + registerLogLevelSignalHandler() (Task 2 — SIGHUP reload)', () => {
  let startingLevel: string;
  let tmpDir: string;
  let tmpEnvPath: string;
  let unregister: (() => void) | undefined;

  beforeEach(() => {
    startingLevel = logger.level;
    // fs.mkdtempSync + fs.writeFileSync under os.tmpdir(), the same
    // temp-directory pattern test/local-store-persistence.test.ts uses.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-log-level-'));
    tmpEnvPath = path.join(tmpDir, '.env');
    unregister = undefined;
  });

  afterEach(() => {
    logger.level = startingLevel;
    unregister?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeEnv(contents: string): void {
    fs.writeFileSync(tmpEnvPath, contents, 'utf8');
  }

  it('reloadLogLevelFromEnvFile sets the level from a file containing LOG_LEVEL=debug and returns changed: true, source: file', () => {
    writeEnv('LOG_LEVEL=debug\n');

    const result = reloadLogLevelFromEnvFile(tmpEnvPath);

    expect(result.changed).toBe(true);
    expect(result.current).toBe('debug');
    expect(result.source).toBe('file');
    expect(logger.level).toBe('debug');
  });

  it('a nonexistent path falls back to process.env.LOG_LEVEL', () => {
    const originalEnvLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    try {
      const result = reloadLogLevelFromEnvFile(path.join(tmpDir, 'does-not-exist.env'));

      expect(result.changed).toBe(true);
      expect(result.current).toBe('debug');
      expect(result.source).toBe('env');
      expect(logger.level).toBe('debug');
    } finally {
      if (originalEnvLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = originalEnvLevel;
    }
  });

  it('a nonexistent path with no process.env.LOG_LEVEL either leaves the level unchanged and returns changed: false, source: none — no throw', () => {
    const originalEnvLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
    try {
      const before = logger.level;

      let result: ReturnType<typeof reloadLogLevelFromEnvFile> | undefined;
      expect(() => {
        result = reloadLogLevelFromEnvFile(path.join(tmpDir, 'does-not-exist.env'));
      }).not.toThrow();

      expect(result).toEqual({ previous: before, current: before, changed: false, source: 'none' });
      expect(logger.level).toBe(before);
    } finally {
      if (originalEnvLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = originalEnvLevel;
    }
  });

  it('a .env with LOG_LEVEL=shouty leaves the level unchanged, returns changed: false, and produces one warn', () => {
    writeEnv('LOG_LEVEL=shouty\n');
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const before = logger.level;

      const result = reloadLogLevelFromEnvFile(tmpEnvPath);

      expect(result.changed).toBe(false);
      expect(logger.level).toBe(before);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('registerLogLevelSignalHandler(SIGUSR1) + emit changes the level; the returned unregister function stops further reloads', () => {
    writeEnv('LOG_LEVEL=debug\n');
    unregister = registerLogLevelSignalHandler('SIGUSR1', tmpEnvPath);

    process.emit('SIGUSR1');

    expect(logger.level).toBe('debug');

    // Unregister, then change what the next emit WOULD reload to, and prove
    // a further emit no longer touches the level.
    unregister();
    unregister = undefined;
    writeEnv('LOG_LEVEL=warn\n');

    process.emit('SIGUSR1');

    expect(logger.level).toBe('debug');
  });

  it('parsing the env file never mutates process.env — a key present only in the file is still undefined on process.env after the reload', () => {
    const marker = 'GSD_LOG_LEVEL_CONTROL_TEST_ONLY_KEY';
    expect(process.env[marker]).toBeUndefined();
    writeEnv(`LOG_LEVEL=debug\n${marker}=should-never-reach-process-env\n`);

    reloadLogLevelFromEnvFile(tmpEnvPath);

    expect(process.env[marker]).toBeUndefined();
  });
});
