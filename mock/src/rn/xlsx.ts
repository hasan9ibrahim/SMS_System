// Excel rate sheets for incoming RNs (team trial round 2): the first worksheet of an .xlsx file as rows of
// cells, read straight from the zip with no library. Protected sheets and workbooks (sheet or structure
// protection, "read-only recommended") are read as usual: protection only stops editing in Excel. A workbook
// that needs a password to open is encrypted (an OLE file, not a zip) and is refused with a clear message.
import { inflateRawSync } from "node:zlib";

export class SheetFileError extends Error {}

interface Entry {
  name: string;
  method: number;
  size: number;
  offset: number;
}

function entries(buf: Buffer): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new SheetFileError("not an Excel .xlsx file (save it as .xlsx or CSV)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    out.push({
      method: buf.readUInt16LE(p + 10),
      size: buf.readUInt32LE(p + 20),
      offset: buf.readUInt32LE(p + 42),
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

/**
 * A part of the workbook may unpack to this much at most (security audit, team trial round 12): rate sheets arrive by
 * e-mail from anyone, and a "zip bomb" of a few hundred KB would otherwise unpack to gigabytes.
 */
export const MAX_PART_BYTES = 64 * 1024 * 1024;

function read(buf: Buffer, e: Entry): string {
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.size);
  if (e.method === 0) return data.toString("utf8");
  if (e.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }).toString("utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
        throw new SheetFileError(`${e.name} unpacks to more than ${MAX_PART_BYTES / 1024 / 1024} MB: not a rate sheet`);
      throw new SheetFileError(`${e.name} could not be read (${(err as Error).message})`);
    }
  }
  throw new SheetFileError(`unsupported compression in ${e.name}`);
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/** The text of a shared or inline string, without phonetic runs. */
const textOf = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((m) => unescape(m[1]!))
    .join("");

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Built-in number formats that are dates or times. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(styles: string | null): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g))
    custom.set(Number(attr(m[0], "numFmtId")), unescape(attr(m[0], "formatCode") ?? ""));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    if (DATE_FORMATS.has(id) || /[dy]|m{3,}|h.*m/i.test(code)) out.add(i);
  });
  return out;
}

/** An Excel serial day number (1900 system) as "YYYY-MM-DD" or "YYYY-MM-DD HH:MM". */
export function serialDate(n: number): string {
  const ms = Math.round((n - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return iso.slice(11, 16) === "00:00" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** "AB12" → column index 27 (0-based). */
const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

/** The first worksheet of an .xlsx file as rows of cell text (empty rows kept, so row numbers match Excel). */
export function readXlsx(buf: Buffer): string[][] {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0)
    throw new SheetFileError(
      "the workbook needs a password to open (or is an old .xls file): ask the vendor for an unlocked file or CSV",
    );
  const list = entries(buf);
  const get = (name: string) => {
    const e = list.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return e ? read(buf, e) : null;
  };
  const workbook = get("xl/workbook.xml");
  if (!workbook) throw new SheetFileError("not an Excel workbook (no xl/workbook.xml)");
  const first = /<sheet\b[^>]*>/.exec(workbook)?.[0];
  const rid = first ? attr(first, "r:id") : undefined;
  const rels = get("xl/_rels/workbook.xml.rels") ?? "";
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => attr(r, "Id") === rid);
  const target = (rel && attr(rel, "Target")) ?? "worksheets/sheet1.xml";
  const sheet = get(target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  if (!sheet) throw new SheetFileError("the workbook has no worksheet");
  const shared = [...(get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const dates = dateStyles(get("xl/styles.xml"));
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const r = Number(attr(rm[1] ?? rm[3] ?? "", "r") ?? rows.length + 1);
    while (rows.length < r - 1) rows.push([]);
    const cells: string[] = [];
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cm[1]!;
      const body = cm[2] ?? "";
      const at = attr(tag, "r");
      const idx = at ? colIndex(at) : cells.length;
      const type = attr(tag, "t");
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = "";
      if (type === "s") text = shared[Number(v)] ?? "";
      else if (type === "inlineStr") text = textOf(body);
      else if (type === "b") text = v === "1" ? "TRUE" : "FALSE";
      else if (v !== undefined) {
        text = unescape(v);
        const n = Number(text);
        if (type !== "str" && type !== "e" && Number.isFinite(n) && dates.has(Number(attr(tag, "s") ?? -1)))
          text = serialDate(n);
      }
      while (cells.length < idx) cells.push("");
      cells[idx] = text.trim();
    }
    rows.push(cells);
  }
  return rows;
}
