/**
 * Table sink: every generated table is written to <dir>/<table>.csv (PostgreSQL
 * COPY csv format, header row = column list). The Postgres loader then COPYs the
 * files in dependency order; with --target csv the files are the output.
 *
 * Columns are taken from the first row written to a table; every later row must
 * carry exactly the same keys (checked), so a typo cannot silently shift columns.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

export type Row = Record<string, unknown>;

/** Marks a value for a jsonb column (a plain JS array would otherwise become a PG array). */
export class Json {
  constructor(readonly value: unknown) {}
}
export const json = (value: unknown) => new Json(value);

/** Encode one value for PostgreSQL COPY ... (FORMAT csv). NULL is an empty unquoted field. */
export function pgCsvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "t" : "f";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`non-finite number in row: ${v}`);
    return String(v);
  }
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Json) return csvQuote(JSON.stringify(v.value));
  if (Array.isArray(v)) return csvQuote(pgArrayLiteral(v));
  if (typeof v === "object") return csvQuote(JSON.stringify(v));
  const s = String(v);
  return csvQuote(s);
}

function csvQuote(s: string): string {
  // Always quote strings so '' (empty string) differs from NULL.
  return `"${s.replace(/"/g, '""')}"`;
}

function pgArrayLiteral(arr: unknown[]): string {
  const items = arr.map((x) => {
    if (x === null || x === undefined) return "NULL";
    if (typeof x === "number") return String(x);
    const s = String(x);
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(",")}}`;
}

class TableFile {
  readonly columns: string[];
  private buf: string[] = [];
  private bufLen = 0;
  count = 0;

  constructor(
    readonly name: string,
    readonly stream: WriteStream,
    firstRow: Row,
  ) {
    this.columns = Object.keys(firstRow);
    this.stream.write(this.columns.join(",") + "\n");
  }

  async add(row: Row): Promise<void> {
    const keys = Object.keys(row);
    if (keys.length !== this.columns.length) {
      throw new Error(`${this.name}: row has columns [${keys}] but table has [${this.columns}]`);
    }
    const line = this.columns
      .map((c) => {
        if (!(c in row)) throw new Error(`${this.name}: row is missing column ${c}`);
        return pgCsvValue(row[c]);
      })
      .join(",");
    this.buf.push(line);
    this.bufLen += line.length;
    this.count++;
    if (this.bufLen > 1 << 20) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const chunk = this.buf.join("\n") + "\n";
    this.buf = [];
    this.bufLen = 0;
    if (!this.stream.write(chunk)) {
      await new Promise<void>((resolve) => this.stream.once("drain", resolve));
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

export class TableSink {
  private readonly tables = new Map<string, TableFile>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async insert(table: string, row: Row): Promise<void> {
    let t = this.tables.get(table);
    if (!t) {
      t = new TableFile(table, createWriteStream(join(this.dir, `${table}.csv`)), row);
      this.tables.set(table, t);
    }
    await t.add(row);
  }

  async insertAll(table: string, rows: Iterable<Row>): Promise<void> {
    for (const r of rows) await this.insert(table, r);
  }

  counts(): Record<string, number> {
    return Object.fromEntries([...this.tables].map(([k, v]) => [k, v.count]));
  }

  async close(): Promise<void> {
    for (const t of this.tables.values()) await t.close();
  }
}
