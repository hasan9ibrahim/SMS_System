// CSV for the Migration Center (§13.22): RFC 4180 with quoted fields (commas, quotes and line breaks
// inside quotes), a BOM-tolerant start and the delimiter guessed from the header (comma, semicolon or tab).

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delim = count("\t") > 0 ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows: string[][] = [];
  let at = 0;
  while (at < src.length) {
    let end = src.indexOf("\n", at);
    if (end < 0) end = src.length;
    const line = src.charCodeAt(end - 1) === 13 ? src.slice(at, end - 1) : src.slice(at, end);
    // Most lines have no quotes: a plain split is many times faster than the character loop.
    if (!line.includes('"')) {
      if (line.trim()) rows.push(line.split(delim));
      at = end + 1;
      continue;
    }
    const [row, next] = quotedRecord(src, at, delim);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    at = next;
  }
  return rows;
}

/** One record starting at `at` that has quotes (fields may span lines); returns it and where the next starts. */
function quotedRecord(src: string, at: number, delim: string): [string[], number] {
  const row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = at;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      break;
    } else cell += ch;
  }
  row.push(cell);
  return [row, i + 1];
}

const quote = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(quote).join(",")).join("\n") + "\n";

/** Header + rows as cell arrays, with each column's index (cheaper than objects for big files). */
export function csvTable(text: string) {
  const [head = [], ...rows] = parseCsv(text);
  const header = head.map((h) => h.trim());
  const at = new Map(header.map((h, i) => [h, i]));
  return { header, rows, col: (name: string) => at.get(name) ?? -1 };
}

/** Header + rows as objects keyed by header name (trimmed). */
export function csvObjects(text: string): { header: string[]; rows: Record<string, string>[] } {
  const [head = [], ...body] = parseCsv(text);
  const header = head.map((h) => h.trim());
  return {
    header,
    rows: body.map((cells) => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()]))),
  };
}

/** A PostgreSQL array literal from COPY CSV ({a,b,"c d"}) as strings. */
export function pgArray(v: string): string[] {
  const s = v.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return s ? [s] : [];
  const inner = s.slice(1, -1);
  if (!inner) return [];
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (q) {
      if (ch === "\\") cur += inner[++i] ?? "";
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.filter((x) => x !== "NULL");
}
