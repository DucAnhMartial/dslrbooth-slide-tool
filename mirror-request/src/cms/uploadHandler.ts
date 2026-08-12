import { Request, Response, RequestHandler } from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { labelLogger } from '../logging/logger';

const log = labelLogger('cms');

/**
 * BOTH halves of D-15's upload story, in one file on purpose.
 *
 * The serving half (plan 08-01) came first, because CMS-05 is a hole this
 * project has already had once and the exposure is created by how bytes are
 * SERVED, not by how they arrive. The receiving half (plan 08-03) lives beside
 * it rather than in its own module for a specific reason: the two halves must
 * agree about what type a stored file is, and the cheapest way to guarantee
 * agreement is that there is only ONE sniffer, one signature table, and one
 * type map — `sniffImageKind()` and `ALLOWED_TYPES` below — consulted by both.
 *
 * There is deliberately no sidecar metadata file. A sidecar is a second
 * recording of the same fact, and any drift between it and the bytes would
 * resolve in the attacker's favour. The receiving half validates the bytes and
 * mints an extension FROM the sniffed kind; the serving half re-derives the
 * kind from the same bytes through the same function. Two readings of one
 * source cannot disagree.
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

/**
 * The extension minted for each sniffed kind. This is the ONLY place an
 * extension is ever chosen, and it is chosen from the CONTENT — which is the
 * precise inversion of the CMS-05 mechanism, where `web-slide` took the
 * extension from a caller-supplied `image_type` field and wrote it into a
 * statically-served directory.
 *
 * The extension is cosmetic here: the serving route re-sniffs and would refuse
 * a `.png` that is not a PNG. It exists so an operator browsing the upload
 * directory sees something intelligible, not because anything trusts it.
 */
const EXTENSION_FOR_KIND: Record<AllowedKind, string> = {
  png: 'png',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
};

/** The public URL prefix these files are served from — see index.ts. */
export const UPLOAD_URL_PREFIX = '/uploads/';

/**
 * The one shape a stored asset URL may ever take, and the only shape the event
 * update route accepts for `logo_url`, `background_url` and `qr_image_url`.
 *
 * A UUID, a dot, and one of exactly four extensions. Nothing else: not an
 * absolute URL to another host, not a `data:` URL, not a `javascript:` URL,
 * and no path segment of any kind. These strings end up in an `<img src>` and
 * in a CSS `url()` on every TV in the room, so the accepted set is defined by
 * what this service itself mints rather than by what a validator can be
 * persuaded to allow.
 */
export const STORED_ASSET_URL_RE = /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

export function isStoredAssetUrl(value: string): boolean {
  return STORED_ASSET_URL_RE.test(value);
}

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

// ---------------------------------------------------------------------------
// The RECEIVING half (plan 08-03, D-15, T-08-13..T-08-16)
// ---------------------------------------------------------------------------

export interface AssetUploadDeps {
  /** Absolute or relative directory the bytes land in. Outside the code tree. */
  uploadDir: string;
  /** The DECODED byte cap, checked before anything is written. */
  maxBytes: number;
}

/**
 * One refusal for every way an upload can fail — wrong signature, oversize,
 * malformed base64, missing field, unwritable directory.
 *
 * Same discipline as `genericNotFound()` above and `statusRoute.ts`'s original.
 * Distinct messages here would tell a caller which of its guesses was closer:
 * "too large" versus "wrong type" is a probe for the configured cap and for
 * the accepted signature set, one request at a time.
 */
function genericUploadFailure(res: Response): Response {
  return res.status(400).json({ error: 'Invalid upload' });
}

/**
 * Strict base64 decode.
 *
 * `Buffer.from(s, 'base64')` is famously lenient: it skips characters outside
 * the alphabet and silently truncates a malformed tail, so a payload that is
 * NOT valid base64 still yields bytes. Those bytes could begin with a valid
 * signature while the rest is attacker-shaped garbage, which is a way to smuggle
 * a payload past a sniffer that only sees the decoded head. Decoding and then
 * re-encoding, and requiring the round trip to be byte-identical, is what makes
 * "this is valid base64" an actual check rather than an assumption.
 */
function decodeStrictBase64(raw: string): Buffer | undefined {
  // Accept the data-URL form a browser's FileReader produces, but take NOTHING
  // from its declared type — the `data:image/png;base64,` prefix is discarded
  // whole, not parsed.
  const commaIndex = raw.startsWith('data:') ? raw.indexOf(',') : -1;
  const payload = (commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw).replace(/\s+/g, '');
  if (!payload) return undefined;
  if (payload.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return undefined;

  const decoded = Buffer.from(payload, 'base64');
  if (decoded.length === 0) return undefined;
  if (decoded.toString('base64') !== payload) return undefined;
  return decoded;
}

/**
 * D-15's receiving half: the authenticated, content-validated, size-capped,
 * server-named write.
 *
 * Mounted BEHIND `requireSession()` (see cmsRouter.ts's documented ordering) —
 * this handler performs no authentication of its own, deliberately, because
 * two places deciding who may upload is two places to get it wrong.
 *
 * The order of the checks below is the control, and it is strict:
 *   1. The body must carry a string `data` field.
 *   2. The ENCODED length is bounded before decoding, so a hostile 100MB
 *      base64 string is refused without allocating its decoded form.
 *   3. Strict base64 decode.
 *   4. The DECODED length is checked against maxBytes — before any write.
 *   5. The bytes are sniffed against exactly four signatures.
 *   6. Only then is a name minted and a file written.
 *
 * Nothing the caller says about the payload participates in any of it. The
 * request may carry `filename` and `type`; both are read by nobody. That is
 * the whole answer to CMS-05: not a filter over the caller's string, but the
 * absence of any code path in which the caller's string is used.
 */
export function handleAssetUpload(deps: AssetUploadDeps): RequestHandler {
  const root = path.resolve(deps.uploadDir);

  return (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { data?: unknown };
    if (typeof body.data !== 'string') {
      genericUploadFailure(res);
      return;
    }

    // 4/3 is base64's exact inflation; the slack covers padding and any
    // data-URL prefix. Cheap arithmetic before an expensive allocation.
    if (body.data.length > Math.ceil(deps.maxBytes * (4 / 3)) + 128) {
      log.warn('Refused an oversize CMS asset upload before decoding it');
      genericUploadFailure(res);
      return;
    }

    const decoded = decodeStrictBase64(body.data);
    if (!decoded) {
      genericUploadFailure(res);
      return;
    }

    if (decoded.length > deps.maxBytes) {
      log.warn('Refused a CMS asset upload larger than the configured cap');
      genericUploadFailure(res);
      return;
    }

    const kind = sniffImageKind(decoded.subarray(0, SNIFF_LENGTH));
    if (!kind) {
      // An SVG, an HTML document, a script, a PDF, a zip — anything whose
      // leading bytes are not one of the four. This is where CMS-05 dies: the
      // payload never becomes a file, so there is nothing for the serving
      // route to refuse later.
      log.warn('Refused a CMS asset upload whose content is not one of the four allowed image types');
      genericUploadFailure(res);
      return;
    }

    // randomUUID(), never a timestamp and never anything derived from the
    // request. A timestamp-derived name is predictable and collides under
    // concurrent uploads; a request-derived name is the CMS-05 bug.
    const filename = `${randomUUID()}.${EXTENSION_FOR_KIND[kind]}`;
    const target = path.join(root, filename);

    try {
      fs.mkdirSync(root, { recursive: true });
      // 'wx' — fail rather than overwrite. A collision on a v4 UUID is not a
      // realistic event, but "create, never replace" is the correct posture for
      // a write into a directory the room's screens read from.
      fs.writeFileSync(target, decoded, { flag: 'wx' });
    } catch {
      log.warn('Failed to store a validated CMS asset upload');
      genericUploadFailure(res);
      return;
    }

    // safeId() on both the name and the size: PHONE_RE masks any run of 7+
    // digits, and a UUID or a byte count can trivially contain one. Without
    // the digit-run break the operator reads a partially asterisked filename
    // in the log and cannot match it to the file on disk.
    log.info(
      `Stored CMS asset ${safeId(filename)} (${ALLOWED_TYPES[kind]}, ${safeId(String(decoded.length))} bytes)`,
    );

    res.status(201).json({
      url: `${UPLOAD_URL_PREFIX}${filename}`,
      // The RECORDED type, and it is the sniffed one. The serving half answers
      // with the same value because it re-derives it from the same bytes
      // through the same function — see this file's header.
      contentType: ALLOWED_TYPES[kind],
    });
  };
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
