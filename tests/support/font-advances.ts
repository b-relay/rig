import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";

/** The tags a WOFF2 table directory names by index (WOFF2 §5.1). */
const KNOWN_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
];

/** How far each character of `text` advances in the WOFF2 font at `path`, in em: read from its `cmap` (format 4) and
 * `hmtx` tables, as a browser lays the text out. A character the font lacks reads as `undefined`. */
export function advancesOf(
  path: string,
  text: string,
): Map<string, number | undefined> {
  const bytes = readFileSync(path);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = header.getUint16(12);
  const compressed = header.getUint32(20);
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = bytes[at++]!;
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error("malformed UIntBase128");
  };
  const directory: { tag: string; length: number }[] = [];
  for (let index = 0; index < count; index++) {
    const flags = bytes[at++]!;
    const tag =
      (flags & 0x3f) === 63
        ? String.fromCharCode(...bytes.subarray(at, (at += 4)))
        : KNOWN_TAGS[flags & 0x3f]!;
    const original = base128();
    const transformed =
      tag === "glyf" || tag === "loca" ? flags >> 6 === 0 : flags >> 6 !== 0;
    // A transformed hmtx stores its advances differently; the fonts read here keep it plain.
    if (tag === "hmtx" && transformed)
      throw new Error("transformed hmtx tables are not supported");
    directory.push({ tag, length: transformed ? base128() : original });
  }
  const data = brotliDecompressSync(bytes.subarray(at, at + compressed));
  const tables = new Map<string, DataView>();
  let offset = 0;
  for (const { tag, length } of directory) {
    tables.set(
      tag,
      new DataView(data.buffer, data.byteOffset + offset, length),
    );
    offset += length;
  }
  const unitsPerEm = tables.get("head")!.getUint16(18);
  const metrics = tables.get("hhea")!.getUint16(34);
  const hmtx = tables.get("hmtx")!;
  const cmap = tables.get("cmap")!;
  let format4: number | undefined;
  for (let index = 0; index < cmap.getUint16(2); index++) {
    const record = 4 + index * 8;
    const start = cmap.getUint32(record + 4);
    if (
      cmap.getUint16(record) === 3 &&
      cmap.getUint16(record + 2) === 1 &&
      cmap.getUint16(start) === 4
    )
      format4 = start;
  }
  if (format4 === undefined) throw new Error("no Unicode BMP cmap");
  const segments = cmap.getUint16(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  const glyphOf = (code: number): number => {
    for (let segment = 0; segment < segments; segment++) {
      if (code > cmap.getUint16(ends + segment * 2)) continue;
      const first = cmap.getUint16(starts + segment * 2);
      if (code < first) return 0;
      const delta = cmap.getInt16(deltas + segment * 2);
      const range = cmap.getUint16(ranges + segment * 2);
      if (range === 0) return (code + delta) & 0xffff;
      const glyph = cmap.getUint16(
        ranges + segment * 2 + range + (code - first) * 2,
      );
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
  return new Map(
    [...text].map((character) => {
      const glyph = glyphOf(character.codePointAt(0)!);
      return [
        character,
        glyph === 0
          ? undefined
          : hmtx.getUint16(Math.min(glyph, metrics - 1) * 4) / unitsPerEm,
      ];
    }),
  );
}
