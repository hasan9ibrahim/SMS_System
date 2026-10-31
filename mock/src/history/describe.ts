// Readable change history (§13.10, team trial round 1: "more detail on what the user changed so the
// admin has an idea"). Each change gets the names of the records it touched and a one-line summary;
// each field gets a label and plain before / after text, with ids of trunks, lists, tables and the
// like shown by name and list fields split into what was added, removed and changed. Times read as
// "2026-10-30 16:49 UTC" and nested fields as "Billing › Customer › Credit limit" (team trial round 12).
import type pg from "pg";
import type { Change } from "@sms/contract";
import { RECORD_TYPE_LABELS } from "../lists/fields.js";

/** Record type → table with a name (users are first + last name). */
const ENTITY_TABLE: Record<string, { table: string; name: string }> = {
  route_rule: { table: "route_rules", name: "name" },
  rate_table: { table: "rate_tables", name: "name" },
  enterprise: { table: "enterprises", name: "name" },
  customer_trunk: { table: "customer_trunks", name: "name" },
  vendor_trunk: { table: "vendor_trunks", name: "name" },
  translation_rule: { table: "translation_rules", name: "name" },
  hlr_rule: { table: "hlr_rules", name: "name" },
  hlr_provider: { table: "hlr_providers", name: "name" },
  voice_gateway: { table: "voice_gateways", name: "name" },
  number_list: { table: "number_lists", name: "name" },
  product_category: { table: "product_categories", name: "name" },
  department: { table: "departments", name: "name" },
  access_group: { table: "access_groups", name: "name" },
  billing_cycle: { table: "billing_cycles", name: "name" },
  business_company: { table: "business_companies", name: "name" },
  country: { table: "countries", name: "name" },
  currency: { table: "currencies", name: "name" },
  dial_code: { table: "dial_codes", name: "prefix" },
  destination: {
    table: "mccmnc",
    name: `(SELECT co.name FROM countries co WHERE co.id = mccmnc.country_id) || ' · ' ||
      CASE WHEN is_all_networks THEN 'All networks' ELSE network END || ' (' || mccmnc || ')'`,
  },
  user: { table: "users", name: "first_name || ' ' || last_name" },
};

/** Keys (inside values, or whole fields holding ids) that point at named records. */
const REF_TABLE: Record<string, string> = {
  vendorTrunkId: "vendor_trunk",
  vendorTrunkIds: "vendor_trunk",
  backupForVendorTrunkId: "vendor_trunk",
  customerTrunkId: "customer_trunk",
  customerTrunkIds: "customer_trunk",
  enterpriseId: "enterprise",
  rateTableId: "rate_table",
  numberListId: "number_list",
  senderListId: "number_list",
  receiverListId: "number_list",
  senderConversionListId: "number_list",
  productCategoryId: "product_category",
  categoryId: "product_category",
  categoryIds: "product_category",
  vendorCategoryIds: "product_category",
  accountManagerId: "user",
  userId: "user",
  managerId: "user",
  departmentId: "department",
  routeRuleId: "route_rule",
  gatewayId: "voice_gateway",
};

const LABELS: Record<string, string> = {
  "*": "Whole record",
  mccmncs: "MCCMNCs",
  mccmnc: "MCCMNC",
  tps: "TPS",
  dlrTargetPct: "DLR target %",
  asrTargetPct: "ASR target %",
  qbrWeights: "QBR weights",
  hlrPorted: "HLR ported",
  sharePct: "share %",
  ip: "IP",
  ips: "IPs",
  smppPort: "SMPP port",
  systemId: "System ID",
  iso: "ISO",
  archived: "Archived (deleted)",
  // Periods (account managers, §13.30): "Jana Okafor from 2026-10-08: until — → 2026-10-30 16:49 UTC".
  startsAt: "From",
  endsAt: "Until",
  // Voice gateways (§8 SMS To Voice).
  callerIdMode: "Caller ID mode",
  fixedCallerId: "Fixed caller ID",
  ringTimeoutS: "Ring timeout (s)",
  retryDelayS: "Retry delay (s)",
};

const partLabel = (part: string): string =>
  LABELS[part] ??
  part
    .replace(/Ids?$/, (m) => (m === "Ids" ? "s" : ""))
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

/** "routeType" → "Route type"; a nested field "billing.customer.creditLimit" → "Billing › Customer › Credit limit". */
export const fieldLabel = (field: string): string =>
  LABELS[field] ?? (field.includes(".") ? field.split(".").map(partLabel).join(" › ") : partLabel(field));

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** "2026-10-30T16:49:56.332Z" → "2026-10-30 16:49 UTC"; midnight UTC → the date alone. */
export function showTime(v: string): string {
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return v;
  const iso = t.toISOString();
  return iso.slice(11, 19) === "00:00:00" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Names of referenced records, by record type then id. */
export type Names = Map<string, Map<number, string>>;

const named = (names: Names, type: string, id: unknown) =>
  typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))
    ? (names.get(type)?.get(Number(id)) ?? `#${id}`)
    : String(id);

/** One value as text; `key` is the field (or object key) it sits under, for id lookups. */
export function showValue(v: unknown, names: Names, key = ""): string {
  if (v === null || v === undefined || v === "") return "—";
  const ref = REF_TABLE[key];
  if (Array.isArray(v)) {
    if (!v.length) return "none";
    return v.map((x) => showValue(x, names, ref ? key : "")).join(", ");
  }
  if (ref && (typeof v === "number" || typeof v === "string")) return named(names, ref, v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string" && ISO_TIME.test(v)) return showTime(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // An account manager period (§13.30): "Jana Okafor from 2026-10-08 until 2026-10-30 16:49 UTC (Handover)".
    if ("userId" in o && "startsAt" in o)
      return `${itemName(o, names)}${o.endsAt ? ` until ${showValue(o.endsAt, names)}` : ""}${
        o.note ? ` (${String(o.note)})` : ""
      }`;
    // A rate line (§13.12) reads as "20801 0.0450 from … until …".
    if ("rate" in o && "mccmnc" in o)
      return `${String(o.mccmnc)}${o.senderId ? `/${String(o.senderId)}` : ""} ${String(o.rate)}${
        o.from ? ` from ${String(o.from).slice(0, 10)}` : ""
      }${o.to ? ` until ${String(o.to).slice(0, 10)}` : ""}${o.blocked ? " blocked" : ""}`;
    // A vendor row: "Kite_DIR (level 1, 60 %, backup)".
    if ("vendorTrunkId" in o) {
      const extra = [
        o.level !== undefined && o.level !== null ? `level ${String(o.level)}` : null,
        o.sharePct !== undefined && o.sharePct !== null ? `${String(o.sharePct)} %` : null,
        o.isBackup
          ? o.backupForVendorTrunkId
            ? `backup of ${named(names, "vendor_trunk", o.backupForVendorTrunkId)}`
            : "backup"
          : null,
        o.warmupCount ? `warm-up ${String(o.warmupCount)}/${String(o.warmupReset ?? "")}` : null,
        Array.isArray(o.numbers) && o.numbers.length ? `numbers ${o.numbers.join(", ")}` : null,
        o.numberListId ? `list ${named(names, "number_list", o.numberListId)}` : null,
      ].filter(Boolean);
      return `${named(names, "vendor_trunk", o.vendorTrunkId)}${extra.length ? ` (${extra.join(", ")})` : ""}`;
    }
    const parts = Object.entries(o)
      .filter(([, x]) => x !== null && x !== undefined && x !== "" && !(Array.isArray(x) && !x.length))
      .map(([k, x]) => `${fieldLabel(k).toLowerCase()} ${showValue(x, names, k)}`);
    return parts.length ? parts.join(", ") : "—";
  }
  return String(v);
}

/** What makes two list items the same item, so an edited one reads as changed rather than removed and added. */
function identity(x: unknown): string | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (o.id !== undefined && o.id !== null) return `id:${String(o.id)}`;
  if ("userId" in o && "startsAt" in o) return `am:${String(o.userId)}:${String(o.startsAt)}`;
  if ("vendorTrunkId" in o)
    return `vt:${String(o.vendorTrunkId)}:${o.isBackup ? `b${String(o.backupForVendorTrunkId ?? "")}` : ""}`;
  return null;
}

/** The short name of a list item: the user and start of a period, the vendor, or its name or id. */
function itemName(o: Record<string, unknown>, names: Names): string {
  if ("userId" in o && "startsAt" in o) return `${named(names, "user", o.userId)} from ${showValue(o.startsAt, names)}`;
  if ("vendorTrunkId" in o) return named(names, "vendor_trunk", o.vendorTrunkId);
  for (const k of ["name", "label", "email", "mccmnc"]) if (typeof o[k] === "string" && o[k]) return String(o[k]);
  return `#${String(o.id ?? "?")}`;
}

/** "Jana Okafor from 2026-10-08: ends at — → 2026-10-30 16:49 UTC". */
function changedItem(before: Record<string, unknown>, after: Record<string, unknown>, names: Names): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  const what = keys.map(
    (k) => `${fieldLabel(k).toLowerCase()} ${showValue(before[k], names, k)} → ${showValue(after[k], names, k)}`,
  );
  return `${itemName(after, names)}: ${what.join(", ")}`;
}

export interface FieldText {
  label: string;
  beforeText: string;
  afterText: string;
  added?: string[];
  removed?: string[];
  changed?: string[];
}

/** A field as text; list fields also say what was added and removed. */
export function describeField(field: string, before: unknown, after: unknown, names: Names): FieldText {
  const out: FieldText = {
    label: fieldLabel(field),
    beforeText: showValue(before, names, field),
    afterText: showValue(after, names, field),
  };
  if (Array.isArray(before) || Array.isArray(after)) {
    const b = (Array.isArray(before) ? before : []).map((x) => [JSON.stringify(x), x] as const);
    const a = (Array.isArray(after) ? after : []).map((x) => [JSON.stringify(x), x] as const);
    const bk = new Set(b.map(([k]) => k));
    const ak = new Set(a.map(([k]) => k));
    const one = (x: unknown) => showValue(x, names, typeof x === "object" ? "" : field);
    const added = a.filter(([k]) => !bk.has(k)).map(([, x]) => x);
    const removed = b.filter(([k]) => !ak.has(k)).map(([, x]) => x);
    // An item on both sides under the same identity was edited, not replaced.
    const changed: string[] = [];
    for (const r of [...removed]) {
      const id = identity(r);
      const i = id === null ? -1 : added.findIndex((x) => identity(x) === id);
      if (i < 0) continue;
      changed.push(changedItem(r as Record<string, unknown>, added[i] as Record<string, unknown>, names));
      added.splice(i, 1);
      removed.splice(removed.indexOf(r), 1);
    }
    out.added = added.map(one);
    out.removed = removed.map(one);
    if (changed.length) out.changed = changed;
  }
  return out;
}

const VERB: Record<string, string> = {
  create: "Created",
  edit: "Edited",
  clone: "Cloned",
  delete: "Deleted",
  reorder: "Reordered",
  enable: "Enabled",
  disable: "Disabled",
  bulk: "Bulk edited",
  undo: "Undid a change on",
  import: "Imported",
  cleanup: "Cleaned up",
};

/** "Edited route rule “NG MTN”: Route type static → block; Vendors +1 −2". */
export function summarize(c: Change, entityNames: string[], fields: FieldText[]): string {
  // "MCCMNC code", "route rule": the record type's label, lower case unless it starts with an acronym.
  const label = RECORD_TYPE_LABELS[c.entityType] ?? c.entityType.replace(/_/g, " ");
  const type = /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
  const plural = /s$/.test(type) ? type : /[^aeiou]y$/.test(type) ? `${type.slice(0, -1)}ies` : `${type}s`;
  const n = c.entityIds.length;
  const who =
    n === 1
      ? entityNames.length
        ? `${type} “${entityNames[0]}”`
        : `${type} #${c.entityIds[0]}`
      : `${n.toLocaleString("en-US")} ${plural}${
          entityNames.length ? ` (${entityNames.slice(0, 3).join(", ")}${n > 3 ? ", …" : ""})` : ""
        }`;
  const real = fields.filter((f) => f.label !== LABELS["*"] && f.label !== LABELS.archived);
  const whole = fields.filter((f) => f.label === LABELS["*"]);
  // A record created or removed as a whole: say what it holds (only when no name says it already).
  const wholePart = (f: FieldText) =>
    f.afterText !== "—" ? f.afterText : f.beforeText !== "—" ? `removed ${f.beforeText}` : "";
  const parts = (real.length ? real : n === 1 && entityNames.length ? [] : whole)
    .slice(0, 3)
    .map((f) =>
      f.label === LABELS["*"]
        ? wholePart(f)
        : f.added || f.removed
          ? `${f.label}${f.added?.length ? ` +${f.added.join(", +")}` : ""}${f.removed?.length ? ` −${f.removed.join(", −")}` : ""}${
              f.changed?.length ? ` ~${f.changed.join(", ~")}` : ""
            }`
          : `${f.label} ${f.beforeText} → ${f.afterText}`,
    );
  const shown = real.length ? real.length : parts.length ? whole.length : 0;
  const more = shown > 3 ? ` · +${shown - 3} more` : "";
  const text = `${VERB[c.changeType] ?? c.changeType} ${who}${parts.filter(Boolean).length ? `: ${parts.filter(Boolean).join("; ")}` : ""}${more}`;
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

/** Collect referenced ids per record type (record ids and ids inside the diff values). */
function collectRefs(changes: Change[]): Map<string, Set<number>> {
  const want = new Map<string, Set<number>>();
  const add = (type: string, id: unknown) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    if (!want.has(type)) want.set(type, new Set());
    want.get(type)!.add(n);
  };
  const walk = (v: unknown, key: string) => {
    const ref = REF_TABLE[key];
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
    else if (ref && (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)))) add(ref, v);
  };
  for (const c of changes) {
    if (ENTITY_TABLE[c.entityType]) c.entityIds.slice(0, 20).forEach((id) => add(c.entityType, id));
    for (const d of c.diff) {
      walk(d.before, d.field);
      walk(d.after, d.field);
    }
  }
  return want;
}

/** Names for a page of changes, one query per record type. */
export async function loadNames(pool: pg.Pool, changes: Change[]): Promise<Names> {
  const names: Names = new Map();
  await Promise.all(
    [...collectRefs(changes)].map(async ([type, ids]) => {
      const t = ENTITY_TABLE[type];
      if (!t) return;
      const r = await pool.query<{ id: string; name: string }>(
        `SELECT id, ${t.name} AS name FROM ${t.table} WHERE id = ANY($1::bigint[])`,
        [[...ids]],
      );
      names.set(type, new Map(r.rows.map((x) => [Number(x.id), String(x.name)])));
    }),
  );
  return names;
}

/** Adds record names, a summary and per-field text to each change. */
export function describeChanges(changes: Change[], names: Names): Change[] {
  return changes.map((c) => {
    const own = names.get(c.entityType);
    // A created record's name is in its "*" diff when the record itself is gone.
    const created = c.diff.find((d) => d.field === "*" && typeof d.after === "string");
    const entityNames = c.entityIds
      .slice(0, 20)
      .map((id) => own?.get(id) ?? (created && created.entityId === id ? String(created.after) : null))
      .filter((n): n is string => n !== null);
    const diff = c.diff.map((d) => ({ ...d, ...describeField(d.field, d.before, d.after, names) }));
    return { ...c, entityNames, summary: summarize(c, entityNames, diff), diff };
  });
}

export async function withDescriptions(pool: pg.Pool, changes: Change[]): Promise<Change[]> {
  return describeChanges(changes, await loadNames(pool, changes));
}
