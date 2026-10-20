// Reading vendor rate sheets (§13.13 A "read any layout"): the delimiter, the columns by their header
// names (or a mapping remembered per vendor), dates in the usual layouts, closed destinations, and a
// username column that splits one file into one RN per trunk. Pure functions, no database.

export type Field =
  | "mccmnc"
  | "mcc"
  | "mnc"
  | "dialCode"
  | "country"
  | "network"
  | "rate"
  | "currency"
  | "effective"
  | "changeType"
  | "username"
  | "senderId";

export interface SheetRow {
  lineNo: number;
  mccmnc: string | null;
  dialCode: string | null;
  country: string | null;
  network: string | null;
  rate: number | null;
  currency: string | null;
  effective: string | null; // ISO
  closed: boolean;
  username: string | null;
  senderId: string | null;
}

export interface Sheet {
  columns: { header: string; field: Field | null }[];
  /** The row the headers were read from, 1 = first row; null when none was found. */
  headerRow: number | null;
  rows: SheetRow[];
  errors: { line: number; message: string }[];
  /** True when the sheet can't be used at all (Failed). */
  fatal: boolean;
}

const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Header names recognised per field, after normalising (lower case, punctuation removed). */
const KNOWN: [Field, RegExp][] = [
  ["mccmnc", /^(mcc ?mnc|mccmnc|mcc mnc code|imsi|imsi prefix|hni|plmn)$/],
  ["mcc", /^mcc$/],
  ["mnc", /^mnc$/],
  ["dialCode", /^(dial ?code|dialcode|prefix|code|country code|cc ndc|destination code)$/],
  ["country", /^(country|country name|destination country)$/],
  ["network", /^(network|operator|carrier|network name|operator name|destination|mobile network)$/],
  ["currency", /^(currency|ccy|cur)$/],
  ["effective", /^(effective|effective date|effective from|eff date|valid from|start date|date|from)$/],
  ["changeType", /^(change|change type|status|remark|remarks|comment|action|type)$/],
  ["username", /^(username|user name|account|system ?id|systemid|smpp account|smpp user|login|trunk)$/],
  ["senderId", /^(sender|sender id|senderid|originator)$/],
  ["rate", /^(rate|price|new rate|new price|rate eur|rate usd|cost|sms rate|tariff|rate per sms)$/],
];

export function fieldOf(header: string, mapping?: Record<string, string> | null): Field | null {
  const key = norm(header);
  const remembered = mapping?.[key];
  if (remembered) return remembered as Field;
  for (const [f, re] of KNOWN) if (re.test(key)) return f;
  if (/rate|price/.test(key) && !/old|previous|current/.test(key)) return "rate";
  return null;
}

/** Splits text into rows of cells: comma, semicolon or tab separated, with "quoted" cells. */
export function splitRows(text: string): string[][] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const first = lines.find((l) => l.trim()) ?? "";
  const count = (ch: string) => first.split(ch).length - 1;
  const delim = count("\t") > 0 ? "\t" : count(";") > count(",") ? ";" : ",";
  const out: string[][] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push([]);
      continue;
    }
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) {
        cells.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cells.push(cur.trim());
    out.push(cells);
  }
  return out;
}

/** A date as vendors write it: 2026-10-20, 20/10/2026, 20.10.2026, 20-Oct-2026, optional time. UTC. */
export function parseDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return utc(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0));
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?: (\d{2}):(\d{2}))?$/);
  if (m) return utc(+m[3]!, +m[2]!, +m[1]!, +(m[4] ?? 0), +(m[5] ?? 0));
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{4})$/);
  if (m) {
    const mon = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(m[2]!.toLowerCase()) / 3;
    if (mon >= 0 && Number.isInteger(mon)) return utc(+m[3]!, mon + 1, +m[1]!, 0, 0);
  }
  return null;
}
function utc(y: number, mo: number, d: number, h: number, mi: number): string | null {
  const t = Date.UTC(y, mo - 1, d, h, mi);
  const dt = new Date(t);
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) return null;
  return dt.toISOString();
}

/** How a partner writes "all networks" of a country (team trial round 2); see AllNetworksCode in the contract. */
export type AllNetworks = "mcc" | "mcc0" | "mcc00" | "mcc000" | "mccStar";

/** A sheet code in the partner's "all networks" form → the country code (MCC); other codes unchanged. */
export function toCountryCode(code: string, conv: AllNetworks | null | undefined): string {
  if (conv === "mcc0" && /^\d{3}0$/.test(code)) return code.slice(0, 3);
  if (conv === "mcc00" && /^\d{3}00$/.test(code)) return code.slice(0, 3);
  if (conv === "mcc000" && /^\d{3}000$/.test(code)) return code.slice(0, 3);
  return code;
}

/** The country code (MCC) written the partner's way; network codes unchanged. */
export function fromCountryCode(code: string, conv: AllNetworks | null | undefined): string {
  if (code.length !== 3) return code;
  return conv === "mcc0"
    ? `${code}0`
    : conv === "mcc00"
      ? `${code}00`
      : conv === "mcc000"
        ? `${code}000`
        : conv === "mccStar"
          ? `${code}*`
          : code;
}

const CLOSED = /^(close|closed|closing|delete|deleted|removed|remove|blocked|discontinued|stop|n\/?a|-)$/i;

export interface ReadOptions {
  /** The header row, 1 = first row; otherwise the first of the first 20 rows with a rate and a destination column. */
  headerRow?: number | null;
  /** The partner's "all networks" code, read as the country code. */
  allNetworks?: AllNetworks | null;
}

/** Reads a sheet (text, or rows of cells from an Excel file). */
export function readSheet(
  input: string | string[][],
  mapping?: Record<string, string> | null,
  opts: ReadOptions = {},
): Sheet {
  const all = typeof input === "string" ? splitRows(input) : input;
  const errors: Sheet["errors"] = [];
  let headerAt = -1;
  let fields: (Field | null)[] = [];
  const usable = (f: (Field | null)[]) =>
    f.includes("rate") && (f.includes("mccmnc") || (f.includes("mcc") && f.includes("mnc")) || f.includes("dialCode"));
  if (opts.headerRow) {
    const f = (all[opts.headerRow - 1] ?? []).map((h) => fieldOf(h, mapping));
    if (usable(f)) [headerAt, fields] = [opts.headerRow - 1, f];
  } else
    for (let i = 0; i < Math.min(all.length, 20); i++) {
      const f = all[i]!.map((h) => fieldOf(h, mapping));
      if (usable(f)) {
        [headerAt, fields] = [i, f];
        break;
      }
    }
  if (headerAt < 0) {
    const scan = opts.headerRow ? all.slice(opts.headerRow - 1, opts.headerRow) : all.slice(0, 20);
    const missing = scan.some((r) => r.map((h) => fieldOf(h, mapping)).includes("rate"))
      ? "no destination column (MCCMNC, MCC + MNC or dial code)"
      : "no rate column";
    const where = opts.headerRow ? ` in row ${opts.headerRow}` : "";
    return {
      columns: [],
      headerRow: null,
      rows: [],
      errors: [{ line: opts.headerRow ?? 1, message: `Can't read the sheet: ${missing}${where}` }],
      fatal: true,
    };
  }
  const header = all[headerAt]!;
  const columns = header.map((h, i) => ({ header: h, field: fields[i] ?? null }));
  const col = (f: Field) => fields.indexOf(f);
  const rows: SheetRow[] = [];
  for (let i = headerAt + 1; i < all.length; i++) {
    const cells = all[i]!;
    if (!cells.length || cells.every((c) => !c)) continue;
    const get = (f: Field) => {
      const k = col(f);
      return k >= 0 ? (cells[k] ?? "").trim() : "";
    };
    const lineNo = i + 1;
    let mccmnc = get("mccmnc").replace(/[^0-9]/g, "") || null;
    if (!mccmnc && get("mcc") && get("mnc")) mccmnc = `${get("mcc")}${get("mnc")}`.replace(/[^0-9]/g, "") || null;
    if (mccmnc) mccmnc = toCountryCode(mccmnc, opts.allNetworks);
    const dialCode = get("dialCode").replace(/[^0-9]/g, "") || null;
    if (mccmnc && !/^\d{3,6}$/.test(mccmnc)) {
      errors.push({ line: lineNo, message: `"${mccmnc}" is not an MCCMNC` });
      continue;
    }
    if (!mccmnc && !dialCode) {
      errors.push({ line: lineNo, message: "no destination (MCCMNC or dial code)" });
      continue;
    }
    const rawRate = get("rate");
    const change = get("changeType");
    const closed = CLOSED.test(change) || /close|delet|remov/i.test(change) || CLOSED.test(rawRate);
    let rate: number | null = null;
    if (!closed) {
      const cleaned = rawRate.replace(/[^0-9.,-]/g, "").replace(",", ".");
      const n = cleaned && /\d/.test(cleaned) ? Number(cleaned) : NaN;
      if (!rawRate || !Number.isFinite(n) || n < 0 || n > 100) {
        errors.push({ line: lineNo, message: rawRate ? `"${rawRate}" is not a rate` : "no rate" });
        continue;
      }
      rate = Math.round(n * 1e6) / 1e6;
    }
    const rawDate = get("effective");
    const effective = rawDate ? parseDate(rawDate) : null;
    if (rawDate && !effective) {
      errors.push({ line: lineNo, message: `"${rawDate}" is not a date` });
      continue;
    }
    rows.push({
      lineNo,
      mccmnc,
      dialCode,
      country: get("country") || null,
      network: get("network") || null,
      rate,
      currency: get("currency").toUpperCase() || null,
      effective,
      closed,
      username: get("username") || null,
      senderId: get("senderId") || null,
    });
  }
  return { columns, headerRow: headerAt + 1, rows, errors, fatal: rows.length === 0 };
}

/** The remembered mapping of a sheet: normalised header -> field, for the recognised columns. */
export function mappingOf(columns: Sheet["columns"]): Record<string, string> {
  return Object.fromEntries(columns.filter((c) => c.field).map((c) => [norm(c.header), c.field!]));
}

export interface TrunkRef {
  id: number;
  name: string;
  username: string;
  enterpriseId: number;
}

const word = (needle: string) =>
  new RegExp(`(^|[^a-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_])`, "i");

/**
 * Finds the vendor trunk from the e-mail (§13.13 A step 1): its username (SMPP system_id) or name in
 * the subject, body or file name; else the only trunk of the sender's enterprise.
 */
export function matchTrunk<T extends TrunkRef>(
  trunks: T[],
  mail: { subject?: string | null; body?: string | null; fileName?: string | null },
  senderEnterpriseIds: number[],
): { trunk: T; reason: string } | null {
  const pool = senderEnterpriseIds.length ? trunks.filter((t) => senderEnterpriseIds.includes(t.enterpriseId)) : trunks;
  const places: [string, string | null | undefined][] = [
    ["subject", mail.subject],
    ["file name", mail.fileName],
    ["body", mail.body],
  ];
  for (const [where, text] of places) {
    if (!text) continue;
    const byUser = pool.filter((t) => t.username.length >= 4 && word(t.username).test(text));
    if (byUser.length === 1) return { trunk: byUser[0]!, reason: `username ${byUser[0]!.username} in the ${where}` };
    const byName = pool.filter((t) => t.name.length >= 4 && word(t.name).test(text));
    if (byName.length === 1) return { trunk: byName[0]!, reason: `trunk name ${byName[0]!.name} in the ${where}` };
  }
  if (senderEnterpriseIds.length && pool.length === 1)
    return { trunk: pool[0]!, reason: "the only live trunk of the sender's enterprise" };
  return null;
}

/** A trunk by the username written in a sheet row (one file, many trunks). */
export function trunkByUsername<T extends TrunkRef>(trunks: T[], username: string): T | null {
  const u = username.trim().toLowerCase();
  return trunks.find((t) => t.username.toLowerCase() === u) ?? trunks.find((t) => t.name.toLowerCase() === u) ?? null;
}
