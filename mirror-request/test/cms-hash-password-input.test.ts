import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { readPasswordFrom } from '../scripts/passwordInput';
import { verifyPassword } from '../src/cms/cmsAuth';
import { hashPassword } from '../src/cms/cmsAuth';

// ---------------------------------------------------------------------------
// Phase 8 code review, WR-04 — the master password must not travel through
// argv.
//
// scripts/hashCmsPassword.ts read `process.argv[2]`. Its header claimed the
// password "never touches disk", which was true of THIS process and false of
// the surrounding system: argv is visible in plaintext to the invoking
// shell's history file, and to any other local process through `ps aux` or
// /proc/<pid>/cmdline for as long as the script runs. On a shared or
// multi-user machine both are more routinely inspected than "touches disk",
// and neither appeared in the file's own threat reasoning.
//
// The reading half is extracted into scripts/passwordInput.ts so it can be
// tested against a fake stream. Testing the CLI end to end would mean
// spawning a child process and asserting on a real TTY, which is a great deal
// of machinery to prove one branch of an if.
// ---------------------------------------------------------------------------

function feed(chunks: string[], isTTY: boolean): NodeJS.ReadableStream & { isTTY?: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
  stream.isTTY = isTTY;
  queueMicrotask(() => {
    for (const c of chunks) stream.write(c);
    stream.end();
  });
  return stream;
}

describe('WR-04: the password is read from stdin, never from argv', () => {
  it('reads a piped password', async () => {
    const password = await readPasswordFrom(feed(['correct horse battery staple\n'], false));

    expect(password).toBe('correct horse battery staple');
  });

  it('keeps everything but the line terminator — spaces and punctuation included', async () => {
    // A password is not a word. Trimming it would silently mint a hash for a
    // different string than the operator typed, and they would only find out
    // at the login screen.
    const password = await readPasswordFrom(feed(['  a b#c$d  \n'], false));

    expect(password).toBe('  a b#c$d  ');
  });

  it('strips a CRLF terminator, not just LF', async () => {
    const password = await readPasswordFrom(feed(['from-windows\r\n'], false));

    expect(password).toBe('from-windows');
  });

  it('accepts input arriving in several chunks', async () => {
    const password = await readPasswordFrom(feed(['part-one', '-part-two', '\n'], false));

    expect(password).toBe('part-one-part-two');
  });

  it('rejects an empty line rather than hashing the empty string', async () => {
    // Hashing '' would produce a perfectly valid CMS_PASSWORD_HASH that any
    // empty form submission satisfies.
    await expect(readPasswordFrom(feed(['\n'], false))).rejects.toThrow();
  });

  it('rejects a closed stream with no line at all', async () => {
    await expect(readPasswordFrom(feed([], false))).rejects.toThrow();
  });

  it('disables terminal echo while reading from a TTY, and restores it', async () => {
    const calls: boolean[] = [];
    const stream = feed(['typed-at-a-prompt\n'], true) as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    stream.setRawMode = (mode: boolean) => {
      calls.push(mode);
    };

    const password = await readPasswordFrom(stream);

    expect(password).toBe('typed-at-a-prompt');
    // On, then off. Leaving raw mode enabled would hand the operator back a
    // terminal that no longer echoes anything they type.
    expect(calls).toEqual([true, false]);
  });

  // -------------------------------------------------------------------------
  // Non-vacuity: the value actually reaching hashPassword is the one typed.
  // -------------------------------------------------------------------------

  it('the password read this way verifies against its own hash', async () => {
    const password = await readPasswordFrom(feed(['operator-pass-01\n'], false));

    expect(verifyPassword(password, hashPassword(password))).toBe(true);
    expect(verifyPassword('operator-pass-02', hashPassword(password))).toBe(false);
  });
});
