/**
 * Mints the CMS_PASSWORD_HASH value for .env — offline, on the operator's own
 * machine, never inside the running service.
 *
 *   npm run cms:hash-password
 *
 * and type the password at the prompt. Nothing echoes while you type. For a
 * scripted install, pipe it instead:
 *
 *   printf '%s\n' "$PASSWORD" | npm run cms:hash-password
 *
 * D-14 requires the .env value itself to be a hash. This script is what makes
 * that practical: without it an operator has no way to produce the value, and
 * the pressure to "just add a plaintext CMS_PASSWORD and hash it at startup"
 * becomes irresistible — at which point the plaintext is in .env, in the
 * process environment, and one careless log line away from the log files
 * (T-08-06).
 *
 * Deliberate properties:
 *  - The password is read from STDIN, never from argv. It does not touch
 *    disk, and it does not appear in the shell's history file or in `ps aux`
 *    / `/proc/<pid>/cmdline` either — the two exposures the argv version had,
 *    and the ones more routinely inspected on a shared machine than "touches
 *    disk" (Phase 8 code review, WR-04). A positional argument is now
 *    REFUSED rather than quietly accepted, because an operator following an
 *    older note would otherwise keep the exposure while believing it fixed.
 *  - Nothing here imports the service, the logger, or the config. A helper
 *    that booted the app to hash a string would put the plaintext inside a
 *    process that has log transports attached.
 *  - Running it twice on the same password prints DIFFERENT output. That is
 *    the fresh 16-byte salt, not a bug — it is the property that stops two
 *    installations with the same password from having the same digest.
 */
import { hashPassword } from '../src/cms/cmsAuth';
import { readPasswordFrom, type PasswordStream } from './passwordInput';

const USAGE =
  'Usage: npm run cms:hash-password        (type the password at the prompt)\n' +
  '   or: printf \'%s\\n\' "$PASSWORD" | npm run cms:hash-password\n\n' +
  'Prints a salt:hash pair for CMS_PASSWORD_HASH in .env.\n';

async function main(): Promise<void> {
  if (process.argv[2]) {
    process.stderr.write(
      '\nRefusing to read the password from the command line.\n\n' +
        'A password in argv is visible in your shell history and to every other\n' +
        'process on this machine via `ps`. Run it again without the argument.\n\n' +
        USAGE,
    );
    process.exit(1);
  }

  const stdin = process.stdin as PasswordStream;
  if (stdin.isTTY) process.stderr.write('Mật khẩu CMS (không hiển thị khi gõ): ');

  let password: string;
  try {
    password = await readPasswordFrom(stdin);
  } catch (err) {
    process.stderr.write(`\n${(err as Error).message}\n\n${USAGE}`);
    process.exit(1);
    return;
  }

  if (stdin.isTTY) process.stderr.write('\n');

  // stdout carries ONLY the hash, so the operator can pipe or copy it without
  // dragging prose into .env. Guidance goes to stderr.
  process.stderr.write('\nAdd this line to .env (the password itself is never stored):\n\n');
  process.stdout.write(`CMS_PASSWORD_HASH=${hashPassword(password)}\n`);
  process.stderr.write('\n');
  process.exit(0);
}

void main();
