import { Request, Response, RequestHandler } from 'express';
import fs from 'fs';
import path from 'path';
import { labelLogger } from '../logging/logger';

const log = labelLogger('cms');

/**
 * The SERVING half of D-15's upload story. The receiving half — base64-JSON
 * body, magic-byte validation on the way in, server-generated filenames, the
 * size cap — lands in plan 08-03. This file exists first, and separately,
 * because CMS-05 is a hole this project has already had once: the exposure is
 * created by how bytes are SERVED, not by how they arrive, so the safe
 * serving path is built before anything can write into the directory.
 *
 * This route is deliberately NOT express.static(). That middleware derives
 * the Content-Type from the extension on disk, which is precisely the CMS-05
 * mechanism: a file named `.svg` or `.html` in an uploads directory gets
 * served as a document the browser will execute. Everything below exists to
 * make that impossible by construction rather than by convention.
 */

/**
 * The complete set of types this route can EVER emit. A hard-coded map, not a
 * lookup into a mime library, so that widening it is a visible edit to this
 * list and nothing else.
 *
 * `image/svg+xml` is absent on purpose and must stay absent: SVG is an XML
 * document that can carry <script>, so serving one from a user-writable
 * directory is stored XSS with extra steps. `text/html` and
 * `application/javascript` are absent for the same reason.
 */
const ALLOWED_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

type AllowedKind = keyof typeof ALLOWED_TYPES;

/** Enough bytes to cover the longest signature checked below (WEBP, 12). */
const SNIFF_LENGTH = 12;

/**
 * Four fixed, well-documented signatures — deliberately hand-rolled rather
 * than pulling in an image-type package, per RESEARCH's "Don't Hand-Roll"
 * carve-out: this is a closed-form check of four constants, not an
 * open-ended parser.
 *
 * The CONTENT is the authority here, not a sidecar file and not the name.
 * Plan 08-03 validates the same signatures on the way in and mints the
 * filename; re-deriving from the bytes at serve time means the two can never
 * disagree in the attacker's favour, and a file that somehow reached the
 * directory by another route is still judged by what it actually contains.
 */
export function sniffImageKind(head: Buffer): AllowedKind | undefined {
  if (head.length >= 8 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
      head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return 'png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpeg';
  }
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'GIF8') {
    return 'gif';
  }
  if (head.length >= 12 &&
      head.toString('ascii', 0, 4) === 'RIFF' &&
      head.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return undefined;
}

/**
 * One shape for every miss — a file that does not exist, a name that escaped
 * the directory, a payload that is not one of the four image types, an
 * unreadable file. Mirrors `statusRoute.ts`'s `genericNotFound()`: two
 * refusal shapes here would let a caller distinguish "no such asset" from
 * "an asset you may not have", which is an enumeration oracle over what the
 * operator has uploaded.
 */
function genericNotFound(res: Response): Response {
  return res.status(404).json({ error: 'not found' });
}

/**
 * Breaks up digit runs so the winston PHONE_RE mask cannot partially asterisk
 * a filename that embeds a timestamp. Same fix, at the same kind of site, as
 * `agentServer.ts`'s connection-id mint — applied here at the LOG site
 * because the filename is minted elsewhere (plan 08-03).
 */
function safeId(value: string): string {
  return value.replace(/(\d)(?=\d)/g, '$1x');
}

/**
 * Serves one uploaded asset, or the generic 404.
 *
 * Order is the control:
 *   1. path.basename() strips every directory component BEFORE any
 *      filesystem call, so `../../etc/passwd` becomes `passwd`.
 *   2. The resolved path is then checked to be a direct child of uploadDir,
 *      as a second, independent guard — belt and braces, because step 1 is a
 *      string transform and step 2 is a statement about the real path.
 *   3. Only then is anything read, and what is read decides the type.
 */
export function serveUploadedAsset(uploadDir: string): RequestHandler {
  const root = path.resolve(uploadDir);

  return (req: Request, res: Response) => {
    const requested = String(req.params.filename ?? '');

    // Reject empty and dot-only names outright; basename('..') is '..'.
    const base = path.basename(requested);
    if (!base || base === '.' || base === '..') {
      log.warn(`Refused upload request for a non-file name: ${safeId(requested)}`);
      genericNotFound(res);
      return;
    }

    const resolved = path.resolve(root, base);
    if (path.dirname(resolved) !== root) {
      log.warn(`Refused upload request resolving outside the upload directory: ${safeId(requested)}`);
      genericNotFound(res);
      return;
    }

    let head: Buffer;
    let stat: fs.Stats;
    let handle: number;
    try {
      stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        genericNotFound(res);
        return;
      }
      handle = fs.openSync(resolved, 'r');
    } catch {
      genericNotFound(res);
      return;
    }

    try {
      head = Buffer.alloc(SNIFF_LENGTH);
      const read = fs.readSync(handle, head, 0, SNIFF_LENGTH, 0);
      head = head.subarray(0, read);
    } catch {
      genericNotFound(res);
      return;
    } finally {
      fs.closeSync(handle);
    }

    const kind = sniffImageKind(head);
    if (!kind) {
      // The file exists but is not one of the four allowed image types — an
      // SVG, an HTML document, a script. It is unreachable through this route
      // by construction, and the refusal is byte-identical to a missing file.
      log.warn(`Refused upload request for a non-image payload: ${safeId(base)}`);
      genericNotFound(res);
      return;
    }

    // Content-Type comes from the hard-coded map above and from nowhere else:
    // never from the extension, never from a request header, never from a
    // sidecar. nosniff stops a browser from second-guessing it.
    res.setHeader('Content-Type', ALLOWED_TYPES[kind]);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(resolved).pipe(res);
  };
}
