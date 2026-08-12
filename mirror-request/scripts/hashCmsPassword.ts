/**
 * Mints the CMS_PASSWORD_HASH value for .env — offline, on the operator's own
 * machine, never inside the running service.
 *
 *   npm run cms:hash-password -- 'the-password-you-chose'
 *
 * D-14 requires the .env value itself to be a hash. This script is what makes
 * that practical: without it an operator has no way to produce the value, and
 * the pressure to "just add a plaintext CMS_PASSWORD and hash it at startup"
 * becomes irresistible — at which point the plaintext is in .env, in the
 * process environment, and one careless log line away from the log files
 * (T-08-06).
 *
 * Deliberate properties:
 *  - The password is read from argv, not prompted and not stored. It never
 *    touches disk, and this process exits immediately.
 *  - Nothing here imports the service, the logger, or the config. A helper
 *    that booted the app to hash a string would put the plaintext inside a
 *    process that has log transports attached.
 *  - Running it twice on the same password prints DIFFERENT output. That is
 *    the fresh 16-byte salt, not a bug — it is the property that stops two
 *    installations with the same password from having the same digest.
 */
import { hashPassword } from '../src/cms/cmsAuth';

function main(): void {
  const password = process.argv[2];

  if (!password) {
    process.stderr.write(
      'Usage: npm run cms:hash-password -- \'<password>\'\n\n' +
        'Prints a salt:hash pair for CMS_PASSWORD_HASH in .env.\n' +
        'Wrap the password in single quotes so the shell does not expand it.\n',
    );
    process.exit(1);
  }

  // stdout carries ONLY the hash, so the operator can pipe or copy it without
  // dragging prose into .env. Guidance goes to stderr.
  process.stderr.write('\nAdd this line to .env (the password itself is never stored):\n\n');
  process.stdout.write(`CMS_PASSWORD_HASH=${hashPassword(password)}\n`);
  process.stderr.write('\n');
}

main();
