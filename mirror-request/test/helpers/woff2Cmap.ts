import { brotliDecompressSync } from 'zlib';

/**
 * Reads the set of Unicode codepoints a WOFF2 file actually covers, by
 * parsing its `cmap` table.
 *
 * This exists because RESEARCH assumption A4 says, in as many words, not to
 * assume the Google Fonts CSS2 API's Vietnamese coverage — verify that the
 * downloaded bytes really carry Đ, ơ, ư and the tone-mark forms. A file-size
 * check cannot tell the difference between a font that covers Vietnamese and
 * one that does not; only the character map can. A wrong answer here is
 * invisible until an event is live and a guest's name renders in a fallback
 * face mid-word.
 *
 * Zero dependencies, deliberately: Node's builtin zlib does Brotli, which is
 * the only compression WOFF2 uses.
 *
 * Implements just enough of the WOFF2 spec (W3C WOFF2 §4, §5) to reach cmap:
 * the 48-byte header, the variable-length table directory, and the Brotli
 * stream. `cmap` is known-tag index 0 and is emitted first in the directory,
 * so it sits at offset 0 of the decompressed stream and no offset arithmetic
 * over later tables is needed. cmap is never one of the transformed tables
 * (only glyf/loca are), so the bytes are the ordinary sfnt cmap.
 */

/** WOFF2 known-table tags, in the spec's fixed order. Only the first entry is
 * load-bearing here; the rest exist so the directory can be walked. */
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

/** UIntBase128, the WOFF2 variable-length integer (spec §4.1). */
function readBase128(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let i = offset;
  for (let byteCount = 0; byteCount < 5; byteCount += 1) {
    const byte = buf[i];
    i += 1;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: i };
  }
  throw new Error('malformed UIntBase128 in WOFF2 table directory');
}

function decompressCmap(file: Buffer): Buffer {
  if (file.toString('latin1', 0, 4) !== 'wOF2') {
    throw new Error('not a WOFF2 file (missing wOF2 signature)');
  }
  const numTables = file.readUInt16BE(12);

  let offset = 48;
  let cmapLength = -1;
  // Tables appear in the decompressed stream in directory order, so cmap's
  // offset is the sum of every preceding table's stored length. (An earlier
  // version of this helper assumed cmap came first, because it is known-tag
  // index 0; the real files put it later, and the assumption produced garbage
  // rather than an error — hence the explicit accounting.)
  let cmapOffset = 0;
  let streamOffset = 0;
  for (let t = 0; t < numTables; t += 1) {
    const flags = file[offset];
    offset += 1;
    const tagIndex = flags & 0x3f;
    let tag: string;
    if (tagIndex === 63) {
      tag = file.toString('latin1', offset, offset + 4);
      offset += 4;
    } else {
      tag = KNOWN_TAGS[tagIndex];
    }
    const transformVersion = (flags >> 6) & 0x03;

    const orig = readBase128(file, offset);
    offset = orig.next;

    // A transformLength follows only for a table that IS transformed. For
    // glyf/loca the null transform is version 3; for every other table it is
    // version 0.
    const transformed = tag === 'glyf' || tag === 'loca' ? transformVersion !== 3 : transformVersion !== 0;
    let storedLength = orig.value;
    if (transformed) {
      const transform = readBase128(file, offset);
      offset = transform.next;
      storedLength = transform.value;
    }

    if (tag === 'cmap') {
      cmapOffset = streamOffset;
      cmapLength = storedLength;
    }
    streamOffset += storedLength;
  }
  if (cmapLength < 0) throw new Error('WOFF2 file has no cmap table');

  const decompressed = brotliDecompressSync(file.subarray(offset));
  return decompressed.subarray(cmapOffset, cmapOffset + cmapLength);
}

function codepointsFromFormat4(cmap: Buffer, base: number): Set<number> {
  const covered = new Set<number>();
  const segCountX2 = cmap.readUInt16BE(base + 6);
  const segCount = segCountX2 / 2;
  const endBase = base + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;

  for (let s = 0; s < segCount; s += 1) {
    const end = cmap.readUInt16BE(endBase + s * 2);
    const start = cmap.readUInt16BE(startBase + s * 2);
    if (start === 0xffff) continue;
    const rangeOffset = cmap.readUInt16BE(rangeBase + s * 2);
    const delta = cmap.readInt16BE(deltaBase + s * 2);
    for (let cp = start; cp <= end && cp !== 0x10000; cp += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xffff;
      } else {
        const idx = rangeBase + s * 2 + rangeOffset + (cp - start) * 2;
        if (idx + 1 >= cmap.length) continue;
        glyph = cmap.readUInt16BE(idx);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) covered.add(cp);
    }
  }
  return covered;
}

function codepointsFromFormat12(cmap: Buffer, base: number): Set<number> {
  const covered = new Set<number>();
  const nGroups = cmap.readUInt32BE(base + 12);
  for (let g = 0; g < nGroups; g += 1) {
    const rec = base + 16 + g * 12;
    const start = cmap.readUInt32BE(rec);
    const end = cmap.readUInt32BE(rec + 4);
    // Bounded: these fonts are Latin-scale, but a corrupt group count should
    // not hang the suite.
    for (let cp = start; cp <= end && cp - start < 0x10000; cp += 1) covered.add(cp);
  }
  return covered;
}

/** Every codepoint the font maps to a real glyph. */
export function coveredCodepoints(file: Buffer): Set<number> {
  const cmap = decompressCmap(file);
  const numTables = cmap.readUInt16BE(2);
  const covered = new Set<number>();

  for (let i = 0; i < numTables; i += 1) {
    const recordBase = 4 + i * 8;
    const subtableOffset = cmap.readUInt32BE(recordBase + 4);
    if (subtableOffset + 4 > cmap.length) continue;
    const format = cmap.readUInt16BE(subtableOffset);
    if (format === 4) {
      for (const cp of codepointsFromFormat4(cmap, subtableOffset)) covered.add(cp);
    } else if (format === 12) {
      for (const cp of codepointsFromFormat12(cmap, subtableOffset)) covered.add(cp);
    }
  }
  return covered;
}

/** Returns the characters of `text` the font does NOT cover — empty means the
 * string renders entirely in this face, with no mid-word fallback. */
export function missingCharacters(file: Buffer, text: string): string[] {
  const covered = coveredCodepoints(file);
  const missing: string[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp !== undefined && !covered.has(cp) && !missing.includes(char)) missing.push(char);
  }
  return missing;
}
