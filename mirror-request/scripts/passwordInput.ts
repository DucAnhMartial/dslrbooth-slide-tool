/**
 * Reads one password from a stream, without it ever appearing in `argv`.
 *
 * WHY THIS EXISTS (Phase 8 code review, WR-04): `hashCmsPassword.ts` took the
 * password as `process.argv[2]`. Its header claimed the value "never touches
 * disk", which was true of that process and false of the machine around it —
 * argv is plaintext in the invoking shell's history file, and readable by any
 * other local process through `ps aux` or `/proc/<pid>/cmdline` for as long as
 * the script runs. On a shared or multi-user box both are checked more often
 * than "touches disk", and neither appeared in the file's threat reasoning.
 *
 * Extracted into its own module so it can be driven by a fake stream in a
 * test. Proving this behaviour through the CLI would mean spawning a child
 * process and attaching a pseudo-terminal — a great deal of machinery to
 * assert one branch of an `if`.
 */

export interface PasswordStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

/**
 * Resolves with the first line, minus its terminator. Rejects on an empty
 * line or a stream that closes without one.
 *
 * The empty-line rejection is not politeness. Hashing `''` yields a perfectly
 * well-formed `CMS_PASSWORD_HASH` that any empty form submission satisfies,
 * and nothing downstream would ever flag it — `verifyPassword` would return
 * true, `config.ts`'s `required()` check sees a non-empty hash, and the CMS
 * would be open to anyone who could reach it.
 *
 * Nothing is trimmed except the line terminator. A password is not a word:
 * silently dropping the operator's leading space would mint a hash for a
 * different string than they typed, and they would discover it at the login
 * screen with no way to tell why.
 */
export function readPasswordFrom(stream: PasswordStream): Promise<string> {
  return new Promise((resolve, reject) => {
    // Echo off while typing, when there is a terminal to turn it off on. A
    // piped or redirected stdin has no `setRawMode` and needs none.
    const interactive = Boolean(stream.isTTY) && typeof stream.setRawMode === 'function';
    if (interactive) stream.setRawMode!(true);

    let buffer = '';
    let settled = false;

    const restore = (): void => {
      if (interactive) stream.setRawMode!(false);
    };

    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      restore();
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (value === '') {
        reject(new Error('No password supplied — refusing to hash an empty string.'));
        return;
      }
      resolve(value);
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const breakAt = buffer.indexOf('\n');
      if (breakAt < 0) return;
      // Strip LF, and the CR of a CRLF terminator — an operator pasting from
      // a Windows editor must not get a hash of "password\r".
      finish(buffer.slice(0, breakAt).replace(/\r$/, ''));
    };

    const onEnd = (): void => {
      // A stream that ended without a newline still carries a password if it
      // carries anything; `finish` rejects the genuinely empty case.
      finish(buffer.replace(/\r$/, ''));
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      restore();
      reject(err);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}
