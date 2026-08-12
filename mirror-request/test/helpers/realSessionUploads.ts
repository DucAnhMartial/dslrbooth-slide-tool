/**
 * The five `file_upload` payloads of ONE REAL dslrBooth session, captured
 * verbatim from the booth PC's Agent log on 2026-08-12 — measured data, not
 * a constructed fixture. See `.planning/phases/07-session-lifecycle-retake/
 * 07-EVIDENCE-dslrbooth-triggers.md` for the surrounding trigger stream.
 *
 * dslrBooth sends no `photoUrl` field. Its trigger carries positional params:
 *   param1 = local file path   C:\dslrBooth\<event>\{Singles,Prints}\....jpg
 *   param2 = the shared URL    https://fotoshare.co/i/<token>
 *   param3 = 'original' | 'print'
 *   param4 = event name
 *
 * It lives in one shared file, for the reason `pendingPrintRegistry.ts` and
 * `noPhotoSweep.ts` give: two suites now assert against these exact values —
 * `queue-file-upload-print.test.ts` proves the `print` filter and the registry
 * resolution, and `queue-event-coverage.test.ts` proves D-13 (no info-level
 * line ever carries one of these URLs). A hand-copied second fixture would let
 * the D-13 assertion drift onto a URL the service never sees, at which point it
 * passes while proving nothing.
 *
 * `PRINT_URL` and `COMPOSITE` are DERIVED from the fixture rather than written
 * out again: an assertion that hard-codes the string it is searching for cannot
 * fail when the fixture changes, which is the exact failure mode this file
 * exists to prevent.
 */
export const REAL_SESSION_UPLOADS = [
  { param1: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_131525_230.jpg', param2: 'https://fotoshare.co/i/1t1vcs3', param3: 'original', param4: 'Test event' },
  { param1: 'C:\\dslrBooth\\Test_event\\Prints\\20260812_131547_837_1x.jpg', param2: 'https://fotoshare.co/i/4kmtdhm', param3: 'print', param4: 'Test event' },
  { param1: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_131532_316.jpg', param2: 'https://fotoshare.co/i/4eexxer', param3: 'original', param4: 'Test event' },
  { param1: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_131538_830.jpg', param2: 'https://fotoshare.co/i/483fqdw', param3: 'original', param4: 'Test event' },
  { param1: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_131545_279.jpg', param2: 'https://fotoshare.co/i/2yx6f9k', param3: 'original', param4: 'Test event' },
] as const;

/** The one `print` composite of that session — exactly one exists per session. */
export const REAL_PRINT_UPLOAD = REAL_SESSION_UPLOADS[1];

/** The capability URL D-13 forbids at `info` level. Derived, never retyped. */
export const PRINT_URL = REAL_PRINT_UPLOAD.param2;

/** The composite path the print anchor carries, from the same real session. */
export const COMPOSITE = REAL_PRINT_UPLOAD.param1;

/**
 * Every fotoshare URL the session produced, print and originals alike. D-13's
 * prohibition is not limited to the print composite's URL — each of these five
 * is a capability URL to a real guest's photo.
 */
export const ALL_FOTOSHARE_URLS = REAL_SESSION_UPLOADS.map((upload) => upload.param2);
