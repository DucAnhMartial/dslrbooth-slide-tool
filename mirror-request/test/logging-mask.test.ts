import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mask, debugRawPayload, logger } from '../src/logging/logger';

describe('mask', () => {
  it('replaces an email address with [EMAIL REDACTED] and removes the original', () => {
    const result = mask('contact alice@example.com now');
    expect(result).toContain('[EMAIL REDACTED]');
    expect(result).not.toContain('alice@example.com');
  });

  it('replaces a phone number with asterisks of the same length', () => {
    const result = mask('call 0900000000');
    expect(result).toBe('call **********');
  });

  it('leaves ordinary ingestion log text unchanged (no false positives)', () => {
    const input = 'registration r-1 status=accepted';
    expect(mask(input)).toBe(input);
  });
});

describe('debugRawPayload gating (D-16)', () => {
  let originalNodeEnv: string | undefined;
  let originalDebug: string | undefined;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDebug = process.env.DEBUG;
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    debugSpy.mockRestore();
  });

  it('emits nothing when NODE_ENV is production, even with DEBUG set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUG = '1';

    debugRawPayload('on-register', '{"email":"a@b.co"}');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('emits nothing when DEBUG is unset, whatever NODE_ENV is', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DEBUG;

    debugRawPayload('on-register', '{"email":"a@b.co"}');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('emits exactly one logger.debug call with a string message when NODE_ENV is not production and DEBUG is set', () => {
    process.env.NODE_ENV = 'test';
    process.env.DEBUG = '1';

    debugRawPayload('on-register', '{"email":"a@b.co"}');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message] = debugSpy.mock.calls[0];
    expect(typeof message).toBe('string');
  });
});
