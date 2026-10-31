// Migration import (§13.22): reads one CSV per entity (template field names, or the source system's
// column names through a saved mapping), matches each row to an existing record (old ID first, then the
// natural key), and plans create / update / skip per row. The dry run returns that plan as a report and
// writes nothing; apply runs the same plan in one transaction and records it as one change in History
// (entity type "migration"), so undoing that change rolls the whole import back.
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { hostNetworks } from "../ipRanges.js";
import type {
  MigrationConflict,
  MigrationField,
  MigrationEntityReport,
  MigrationFileInput,
  MigrationImportEntity,
  MigrationIssue,
  MigrationReport,
  TranslationRuleInput,
} from "@sms/contract";
import { hashPassword } from "../admin/passwords.js";
import { csvTable } from "./csv.js";
import { BUILT_IN_MAPPINGS, CHOICE_SYNONYMS, ENTITY, HEADER_ALIASES, IMPORT_ENTITIES } from "./entities.js";
import { entryProblem } from "../api/numberLists.js";
import { checkRule, insertRule, normalise } from "../api/translationRules.js";
import { compilePattern } from "../routing/pattern.js";

type Db = pg.Pool | pg.PoolClient;
type Ent = MigrationImportEntity;

/** A record the plan points at: one already in the system, or one this import creates. */
export class Ref {
  constructor(
    readonly entity: Ent,
    readonly row: number,
  ) {}
}
type Value = unknown;
type Action = "create" | "update" | "skip" | "error";

export interface PlanRow {
  /** Line in the file (header = 1). */
  line: number;
  action: Action;
  externalId: string | null;
  existingId: number | null;
  /** Column values to write (Ref or Ref[] for links to records of the same import). */
  values: Record<string, Value>;
  /** For updates: the current values of the columns that change. */
  before: Record<string, Value>;
  extra: Record<string, Value>;
}
export interface Plan {
  sourceSystem: string;
  trunksInactive: boolean;
  rows: Map<Ent, PlanRow[]>;
  report: MigrationReport;
  includesCredentials: boolean;
}
export interface ImportSettings {
  sourceSystem: string;
  files: MigrationFileInput[];
  conflicts: Partial<Record<Ent, MigrationConflict>>;
  trunksInactive: boolean;
}

const MAX_ISSUES = 500;
const NONE = new Map<string, number>();
const lower = (s: string) => s.trim().toLowerCase();
/** A field with several values: separated by ; or , (team trial round 1: "IP1,IP2"). */
const list = (s: string | undefined) =>
  (s ?? "")
    .split(/[;,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
/** Import field → enterprise contact type (§5, team trial round 1: all four types, not only commercial). */
export const CONTACT_FIELDS = [
  ["emails", "commercial"],
  ["technicalEmails", "technical"],
  ["ratesEmails", "rates"],
  ["financeEmails", "finance"],
] as const;
const yes = (s: string | undefined) => /^(yes|y|true|1)$/i.test(s ?? "");
const num = (s: string | undefined) => (s == null || s.trim() === "" ? null : Number(s.replace(/,/g, "")));

interface Lookups {
  departments: Map<string, number>;
  accessGroups: Map<string, number>;
  companies: Map<string, { id: number; currency: string }>;
  categories: Map<string, number>;
  currencies: Set<string>;
  countries: Map<string, number>;
  mccmnc: Map<string, number>;
  users: Map<string, number>;
  /** Users that are deleted: a file row with one of their usernames brings the user back (team trial round 10). */
  deletedUsers: Set<number>;
  enterprises: Map<string, number>;
  customerTrunks: Map<string, number>;
  customerUsernames: Map<string, number>;
  vendorTrunks: Map<string, number>;
  vendorTables: Map<number, number>;
  rateTables: Map<string, number>;
  routeRules: Map<string, number>;
  /** Team trial round 12: number lists, HLR providers and rules, translation rules, archived department names. */
  numberLists: Map<string, { id: number; type: string }>;
  hlrProviders: Map<string, number>;
  hlrRules: Map<string, number>;
  translationRules: Map<string, number>;
  archivedDepartments: Set<string>;
  refs: Map<string, number>;
  counts: Record<Ent, number | null>;
}

async function loadLookups(c: Db, source: string): Promise<Lookups> {
  const map = async (sql: string, args: unknown[] = []) =>
    new Map<string, number>((await c.query(sql, args)).rows.map((r) => [String(r.k), Number(r.id)]));
  const count = async (sql: string) => Number((await c.query(sql)).rows[0].n);
  const companies = new Map<string, { id: number; currency: string }>(
    (await c.query("SELECT id, lower(name) AS k, base_currency FROM business_companies")).rows.map((r) => [
      r.k,
      { id: Number(r.id), currency: String(r.base_currency).trim() },
    ]),
  );
  // Refs only point at live records: a rolled-back import's records are archived and do not match.
  const { rows: refRows } = await c.query(
    `SELECT r.entity, r.external_id, r.record_id FROM migration_refs r
      WHERE r.source_system = $1 AND CASE r.entity
        WHEN 'users' THEN EXISTS (SELECT 1 FROM users x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        WHEN 'enterprises' THEN EXISTS (SELECT 1 FROM enterprises x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        WHEN 'customer_trunks' THEN EXISTS (SELECT 1 FROM customer_trunks x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        WHEN 'vendor_trunks' THEN EXISTS (SELECT 1 FROM vendor_trunks x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        WHEN 'rate_tables' THEN EXISTS (SELECT 1 FROM rate_tables x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        WHEN 'route_rules' THEN EXISTS (SELECT 1 FROM route_rules x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        WHEN 'departments' THEN EXISTS (SELECT 1 FROM departments x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        WHEN 'product_categories' THEN EXISTS (SELECT 1 FROM product_categories x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        WHEN 'translation_rules' THEN EXISTS (SELECT 1 FROM translation_rules x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        WHEN 'hlr_rules' THEN EXISTS (SELECT 1 FROM hlr_rules x WHERE x.id = r.record_id AND x.deleted_at IS NULL)
        ELSE false END`,
    [source],
  );
  return {
    departments: await map("SELECT lower(name) AS k, id FROM departments WHERE deleted_at IS NULL"),
    accessGroups: await map("SELECT lower(name) AS k, id FROM access_groups WHERE deleted_at IS NULL"),
    companies,
    categories: await map("SELECT lower(name) AS k, id FROM product_categories WHERE deleted_at IS NULL"),
    currencies: new Set((await c.query("SELECT iso FROM currencies WHERE deleted_at IS NULL")).rows.map((r) => r.iso)),
    countries: await map("SELECT upper(iso) AS k, id FROM countries"),
    mccmnc: await map("SELECT mccmnc AS k, id FROM mccmnc WHERE deleted_at IS NULL"),
    // Usernames are unique across archived users too.
    users: await map("SELECT lower(username) AS k, id FROM users"),
    deletedUsers: new Set(
      (await c.query("SELECT id FROM users WHERE deleted_at IS NOT NULL")).rows.map((r) => Number(r.id)),
    ),
    enterprises: await map(
      "SELECT lower(name) AS k, min(id) AS id FROM enterprises WHERE deleted_at IS NULL GROUP BY 1",
    ),
    customerTrunks: await map(
      "SELECT lower(name) AS k, min(id) AS id FROM customer_trunks WHERE deleted_at IS NULL GROUP BY 1",
    ),
    customerUsernames: await map("SELECT username AS k, id FROM customer_trunks WHERE deleted_at IS NULL"),
    vendorTrunks: await map(
      "SELECT lower(name) AS k, min(id) AS id FROM vendor_trunks WHERE deleted_at IS NULL GROUP BY 1",
    ),
    vendorTables: new Map(
      (await c.query("SELECT vendor_trunk_id, id FROM rate_tables WHERE vendor_trunk_id IS NOT NULL")).rows.map((r) => [
        Number(r.vendor_trunk_id),
        Number(r.id),
      ]),
    ),
    rateTables: await map(
      "SELECT kind || ':' || lower(name) AS k, min(id) AS id FROM rate_tables WHERE deleted_at IS NULL GROUP BY 1",
    ),
    routeRules: await map(
      "SELECT lower(name) AS k, min(id) AS id FROM route_rules WHERE deleted_at IS NULL GROUP BY 1",
    ),
    numberLists: new Map(
      (
        await c.query(
          "SELECT lower(name) AS k, min(id) AS id, min(list_type) AS t FROM number_lists WHERE deleted_at IS NULL GROUP BY 1",
        )
      ).rows.map((r) => [String(r.k), { id: Number(r.id), type: String(r.t) }]),
    ),
    hlrProviders: await map(
      "SELECT lower(name) AS k, min(id) AS id FROM hlr_providers WHERE deleted_at IS NULL GROUP BY 1",
    ),
    hlrRules: await map("SELECT lower(name) AS k, min(id) AS id FROM hlr_rules WHERE deleted_at IS NULL GROUP BY 1"),
    translationRules: await map(
      "SELECT lower(name) AS k, min(id) AS id FROM translation_rules WHERE deleted_at IS NULL GROUP BY 1",
    ),
    archivedDepartments: new Set(
      (await c.query("SELECT lower(name) AS k FROM departments WHERE deleted_at IS NOT NULL")).rows.map((r) => r.k),
    ),
    refs: new Map(refRows.map((r) => [`${r.entity}:${r.external_id}`, Number(r.record_id)])),
    counts: {
      departments: await count("SELECT count(*) AS n FROM departments WHERE deleted_at IS NULL"),
      product_categories: await count("SELECT count(*) AS n FROM product_categories WHERE deleted_at IS NULL"),
      number_lists: await count("SELECT count(*) AS n FROM number_lists WHERE deleted_at IS NULL"),
      translation_rules: await count("SELECT count(*) AS n FROM translation_rules WHERE deleted_at IS NULL"),
      hlr_rules: await count("SELECT count(*) AS n FROM hlr_rules WHERE deleted_at IS NULL"),
      users: await count("SELECT count(*) AS n FROM users WHERE deleted_at IS NULL"),
      enterprises: await count("SELECT count(*) AS n FROM enterprises WHERE deleted_at IS NULL"),
      customer_trunks: await count("SELECT count(*) AS n FROM customer_trunks WHERE deleted_at IS NULL"),
      vendor_trunks: await count("SELECT count(*) AS n FROM vendor_trunks WHERE deleted_at IS NULL"),
      rate_tables: await count("SELECT count(*) AS n FROM rate_tables WHERE deleted_at IS NULL"),
      rate_lines: await count("SELECT count(*) AS n FROM rate_lines WHERE valid_to IS NULL OR valid_to > now()"),
      route_rules: await count("SELECT count(*) AS n FROM route_rules WHERE deleted_at IS NULL"),
      opening_balances: null,
    },
  };
}

/** A header or choice compared loosely: case, spaces, dashes, underscores, dots and brackets ignored. */
export const looseKey = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}&]/gu, "")
    .replace(/&/g, "and")
    .toLowerCase();

/** A choice as the template writes it ("Active" → active, "Tier 1" → tier1, "Bilateral" → reciprocal); else as is. */
export function choiceOf(allowed: string[], value: string): string {
  const k = looseKey(value);
  if (!k) return value;
  return (
    allowed.find((a) => looseKey(a) === k) ??
    allowed.find((a) => (CHOICE_SYNONYMS[a] ?? []).some((x) => looseKey(x) === k)) ??
    value
  );
}

/**
 * Rows of one file as template fields (team trial round 11: any header the field is known by works). Each field
 * takes the first column found, in this order: the chosen mapping's column, the field key, its label, the reference
 * platform's name, then the other names it is known by; a column serves one field. Choices are written the
 * template's way.
 */
export function mapRows(file: MigrationFileInput, mapping: Record<string, string> | null) {
  const info = ENTITY.get(file.entity)!;
  const { header, rows } = csvTable(file.content);
  const byKey = new Map<string, number>();
  header.forEach((h, i) => {
    const k = looseKey(h);
    if (k && !byKey.has(k)) byKey.set(k, i);
  });
  const builtIn = BUILT_IN_MAPPINGS.find((m) => m.entity === file.entity)?.columns ?? {};
  const aliases = HEADER_ALIASES[file.entity] ?? {};
  const names = (f: MigrationField, pass: 0 | 1) =>
    pass === 0
      ? [mapping?.[f.field], f.field, f.label].filter((x): x is string => !!x)
      : [builtIn[f.field], ...(aliases[f.field] ?? [])].filter((x): x is string => !!x);
  const taken = new Set<number>();
  const col = new Map<string, number>();
  // Exact names first for every field, so another field's alias never takes a column named after its own field.
  for (const pass of [0, 1] as const)
    for (const f of info.fields) {
      if (col.has(f.field)) continue;
      for (const n of names(f, pass)) {
        const i = byKey.get(looseKey(n));
        if (i != null && !taken.has(i)) {
          col.set(f.field, i);
          taken.add(i);
          break;
        }
      }
    }
  const missing = info.fields
    .filter((f) => f.required && !col.has(f.field))
    .map((f) => {
      const want = mapping?.[f.field];
      return `${f.label} (a column named "${want ?? f.field}"${want ? ` or "${f.field}"` : ""} or "${f.label}")`;
    });
  const out = rows.map((cells) => {
    const o: Record<string, string> = {};
    for (const f of info.fields) {
      const i = col.get(f.field);
      const v = i == null ? "" : (cells[i] ?? "").trim();
      o[f.field] = f.allowed.length ? choiceOf(f.allowed, v) : v;
    }
    return o;
  });
  return { rows: out, missing };
}

class Planner {
  readonly issues: MigrationIssue[] = [];
  issueCount = 0;
  includesCredentials = false;
  readonly rows = new Map<Ent, PlanRow[]>();
  /** This import's records by external ID and by natural key. */
  private readonly byExt = new Map<string, number>();
  private readonly byKey = new Map<string, number>();

  constructor(
    readonly lk: Lookups,
    readonly conflicts: Partial<Record<Ent, MigrationConflict>>,
    readonly trunksInactive: boolean,
  ) {}

  private readonly perEntity = new Map<string, number>();
  issue(entity: Ent, line: number, field: string | null, message: string, severity: "error" | "warning" = "error") {
    this.issueCount++;
    // Each entity keeps its own share of the list, so one noisy file does not hide the others.
    const n = this.perEntity.get(entity) ?? 0;
    this.perEntity.set(entity, n + 1);
    if (n < MAX_ISSUES / 8 && this.issues.length < MAX_ISSUES)
      this.issues.push({ entity, row: line, field, message, severity });
  }
  /** Number lists this import creates, by lower-case name → type (team trial round 12). */
  readonly newLists = new Map<string, string>();
  /** Rows that failed validation, by external ID and key: rows pointing at them are skipped quietly. */
  readonly failed = new Set<string>();
  fail(entity: Ent, ext: string | null, key: string) {
    if (ext) this.failed.add(`${entity}:${ext}`);
    this.failed.add(`${entity}:${key}`);
  }

  /** Registers a planned row so later files can point at it. */
  index(entity: Ent, row: number, ext: string | null, key: string) {
    if (ext) this.byExt.set(`${entity}:${ext}`, row);
    this.byKey.set(`${entity}:${key}`, row);
  }

  /** A record by external ID or name: this import first, then imported earlier (refs), then the system. */
  resolve(entity: Ent, key: string, system: Map<string, number>, systemKey = lower(key)): Ref | number | null {
    const k = key.trim();
    if (!k) return null;
    const inFile = this.byExt.get(`${entity}:${k}`) ?? this.byKey.get(`${entity}:${systemKey}`);
    if (inFile != null) {
      const r = this.rows.get(entity)![inFile]!;
      if (r.action === "create") return new Ref(entity, inFile);
      if (r.existingId != null) return r.existingId;
      return null;
    }
    return this.lk.refs.get(`${entity}:${k}`) ?? system.get(systemKey) ?? null;
  }

  /** Matches a row to an existing record; decides create / update / skip by the conflict setting. */
  match(entity: Ent, line: number, ext: string | null, existing: number | null): { action: Action; id: number | null } {
    const id = (ext ? this.lk.refs.get(`${entity}:${ext}`) : undefined) ?? existing;
    if (id == null) return { action: "create", id: null };
    const how = this.conflicts[entity] ?? "skip";
    if (how === "create") return { action: "create", id: null };
    void line;
    return { action: how === "update" ? "update" : "skip", id };
  }
}

const UPDATABLE: Partial<Record<Ent, { table: string; columns: string[] }>> = {
  departments: { table: "departments", columns: ["description", "status"] },
  product_categories: { table: "product_categories", columns: ["name"] },
  hlr_rules: { table: "hlr_rules", columns: ["hlr_provider_id", "dnid_pattern", "status"] },
  users: {
    table: "users",
    // deleted_at: only a restored user's row carries it (null), see planUsers.
    columns: [
      "first_name",
      "last_name",
      "email",
      "department_id",
      "access_group_id",
      "is_account_manager",
      "status",
      "deleted_at",
    ],
  },
  enterprises: {
    table: "enterprises",
    columns: ["alias", "type", "tier", "status", "account_manager_id", "address_line1", "country_id", "vat_number"],
  },
  customer_trunks: {
    table: "customer_trunks",
    columns: ["host_ips", "ssl_type", "protocol", "tps", "product_category_id", "billing_type", "username", "password"],
  },
  vendor_trunks: {
    table: "vendor_trunks",
    columns: ["host", "port", "username", "password", "protocol", "tps", "product_category_id", "billing_type"],
  },
  rate_tables: { table: "rate_tables", columns: ["product_category_id"] },
  route_rules: {
    table: "route_rules",
    columns: ["priority", "status", "customer_trunk_mode", "customer_trunk_ids", "mccmnc_mode", "mccmncs"],
  },
};

const same = (a: unknown, b: unknown) => {
  const norm = (v: unknown) => (Array.isArray(v) ? JSON.stringify(v.map(String)) : v == null ? "" : String(v));
  return norm(a) === norm(b);
};

/** Turns a matched row into an update of the columns that differ, or a skip when none do. */
async function diffUpdates(c: Db, entity: Ent, rows: PlanRow[]) {
  const u = UPDATABLE[entity];
  const todo = rows.filter((r) => r.action === "update");
  if (!u || !todo.length) return;
  const { rows: cur } = await c.query(`SELECT id, ${u.columns.join(", ")} FROM ${u.table} WHERE id = ANY($1)`, [
    todo.map((r) => r.existingId),
  ]);
  const byId = new Map(cur.map((r) => [Number(r.id), r]));
  for (const r of todo) {
    const now = byId.get(r.existingId!);
    const before: Record<string, Value> = {};
    const after: Record<string, Value> = {};
    for (const col of u.columns) {
      if (!(col in r.values) || r.values[col] === undefined) continue;
      const v = r.values[col];
      if (v instanceof Ref || (Array.isArray(v) && v.some((x) => x instanceof Ref)) || !same(v, now?.[col])) {
        before[col] = now?.[col] ?? null;
        after[col] = v;
      }
    }
    if (!Object.keys(after).length) r.action = "skip";
    r.values = after;
    r.before = before;
  }
}

// ---------------------------------------------------------------- per-entity planning

type Raw = Record<string, string>;
const row = (line: number, ext: string | null): PlanRow => ({
  line,
  action: "create",
  externalId: ext,
  existingId: null,
  values: {},
  before: {},
  extra: {},
});

function required(p: Planner, entity: Ent, line: number, r: Raw): boolean {
  let ok = true;
  for (const f of ENTITY.get(entity)!.fields) {
    const v = r[f.field] ?? "";
    if (f.required && !v.trim()) {
      p.issue(entity, line, f.field, `${f.label} is required`);
      ok = false;
    } else if (v.trim() && f.allowed.length && !f.allowed.includes(v.trim().toLowerCase())) {
      p.issue(entity, line, f.field, `${f.label} "${v}" is not one of ${f.allowed.join(", ")}`);
      ok = false;
    }
  }
  return ok;
}

function planUsers(p: Planner, raws: Raw[]): PlanRow[] {
  const out: PlanRow[] = [];
  const seen = new Set<string>();
  raws.forEach((r, i) => {
    const line = i + 2;
    const ext = r.externalId?.trim() || null;
    const pr = row(line, ext);
    out.push(pr);
    if (!required(p, "users", line, r)) return void (pr.action = "error");
    const uname = lower(r.username!);
    if (seen.has(uname)) {
      p.issue("users", line, "username", `Username "${r.username}" appears twice in the file`);
      return void (pr.action = "error");
    }
    seen.add(uname);
    const existing = p.lk.users.get(uname) ?? null;
    // A deleted user keeps its username (history and audit refer to it), so the row cannot create a new one. Skipping
    // it would leave the user deleted while the import says it is already there (team trial round 10): the import
    // restores the user with the file's details instead, whatever the setting for existing users.
    const restore = existing != null && p.lk.deletedUsers.has(existing);
    const m = restore ? { action: "update" as const, id: existing } : p.match("users", line, ext, existing);
    pr.action = m.action;
    pr.existingId = m.id;
    if (restore)
      p.issue(
        "users",
        line,
        "username",
        `User "${r.username}" was deleted: the import restores it with the file's details`,
        "warning",
      );
    if (m.action === "create" && p.lk.users.has(uname)) {
      p.issue("users", line, "username", `Username "${r.username}" is taken: choose skip or update for users`);
      return void (pr.action = "error");
    }
    const dept = r.department?.trim() ? p.resolve("departments", r.department, p.lk.departments) : null;
    if (r.department?.trim() && dept == null)
      p.issue("users", line, "department", `Department "${r.department}" does not exist; left empty`, "warning");
    const group = r.accessGroup?.trim() ? (p.lk.accessGroups.get(lower(r.accessGroup)) ?? null) : null;
    if (r.accessGroup?.trim() && group == null)
      p.issue("users", line, "accessGroup", `Access group "${r.accessGroup}" does not exist; left empty`, "warning");
    pr.values = {
      username: r.username!.trim(),
      first_name: r.firstName!.trim(),
      last_name: r.lastName!.trim(),
      email: r.email!.trim(),
      department_id: dept,
      access_group_id: group,
      is_account_manager: yes(r.isAccountManager),
      status: r.status?.trim().toLowerCase() || "active",
      ...(restore ? { deleted_at: null } : {}),
    };
  });
  out.forEach((r, i) => r.action !== "error" && p.index("users", i, r.externalId, lower(String(r.values.username))));
  return out;
}

function planEnterprises(p: Planner, raws: Raw[]): PlanRow[] {
  const out: PlanRow[] = [];
  const seen = new Set<string>();
  raws.forEach((r, i) => {
    const line = i + 2;
    const ext = r.externalId?.trim() || null;
    const pr = row(line, ext);
    out.push(pr);
    if (!required(p, "enterprises", line, r)) return void (pr.action = "error");
    const name = r.name!.trim();
    if (seen.has(lower(name)) && !ext) {
      p.issue("enterprises", line, "name", `"${name}" appears twice in the file: give each row its external ID`);
      return void (pr.action = "error");
    }
    seen.add(lower(name));
    const company = p.lk.companies.get(lower(r.businessCompany!));
    if (!company) {
      p.issue("enterprises", line, "businessCompany", `Business company "${r.businessCompany}" does not exist`);
      return void (pr.action = "error");
    }
    let am: Ref | number | null = null;
    if (r.accountManager?.trim()) {
      am = p.resolve("users", r.accountManager, p.lk.users);
      if (am == null)
        p.issue("enterprises", line, "accountManager", `User "${r.accountManager}" not found; no AM set`, "warning");
    }
    const country = r.country?.trim() ? (p.lk.countries.get(r.country.trim().toUpperCase()) ?? null) : null;
    if (r.country?.trim() && country == null)
      p.issue("enterprises", line, "country", `Country "${r.country}" not found; left empty`, "warning");
    const m = p.match("enterprises", line, ext, p.lk.enterprises.get(lower(name)) ?? null);
    pr.action = m.action;
    pr.existingId = m.id;
    pr.values = {
      business_company_id: company.id,
      name,
      alias:
        r.alias?.trim() ||
        name
          .replace(/[^A-Za-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
          .toUpperCase()
          .slice(0, 20),
      type: r.type!.trim().toLowerCase(),
      tier: r.tier?.trim().toLowerCase() || "tier3",
      status: r.status?.trim().toLowerCase() || "active",
      account_manager_id: am,
      address_line1: r.address?.trim() ?? "",
      country_id: country,
      vat_number: r.vatNumber?.trim() || null,
    };
    pr.extra = {
      currency: company.currency,
      contacts: Object.fromEntries(CONTACT_FIELDS.map(([field, type]) => [type, list(r[field])])),
    };
  });
  out.forEach((r, i) => r.action !== "error" && p.index("enterprises", i, r.externalId, lower(String(r.values.name))));
  return out;
}

function planTrunks(p: Planner, kind: "customer" | "vendor", raws: Raw[]): PlanRow[] {
  const entity: Ent = kind === "customer" ? "customer_trunks" : "vendor_trunks";
  const system = kind === "customer" ? p.lk.customerTrunks : p.lk.vendorTrunks;
  const out: PlanRow[] = [];
  const seen = new Set<string>();
  const usernames = new Map(p.lk.customerUsernames);
  raws.forEach((r, i) => {
    const line = i + 2;
    const ext = r.externalId?.trim() || null;
    const pr = row(line, ext);
    out.push(pr);
    if (!required(p, entity, line, r)) return void (pr.action = "error");
    const name = r.name!.trim();
    if (seen.has(lower(name)) && !ext) {
      p.issue(entity, line, "name", `"${name}" appears twice in the file: give each row its external ID`);
      return void (pr.action = "error");
    }
    seen.add(lower(name));
    const ent = p.resolve("enterprises", r.enterprise!, p.lk.enterprises);
    if (ent == null) {
      p.issue(entity, line, "enterprise", `Enterprise "${r.enterprise}" not found in the system or the file`);
      return void (pr.action = "error");
    }
    const tps = num(r.tps);
    if (tps == null || !Number.isInteger(tps) || tps < 1) {
      p.issue(entity, line, "tps", `TPS "${r.tps}" must be a whole number of 1 or more`);
      return void (pr.action = "error");
    }
    const port = num(r.port);
    if (kind === "vendor" && r.port?.trim() && (port == null || !Number.isInteger(port) || port < 1 || port > 65535)) {
      p.issue(entity, line, "port", `Port "${r.port}" is not a valid port`);
      return void (pr.action = "error");
    }
    let category: Ref | number | null = null;
    if (r.category?.trim()) {
      category = p.resolve("product_categories", r.category, p.lk.categories);
      if (category == null) {
        if (kind === "vendor") {
          p.issue(entity, line, "category", `Product category "${r.category}" does not exist`);
          return void (pr.action = "error");
        }
        p.issue(entity, line, "category", `Product category "${r.category}" does not exist; left empty`, "warning");
      }
    }
    const m = p.match(entity, line, ext, system.get(lower(name)) ?? null);
    pr.action = m.action;
    pr.existingId = m.id;
    if (["username", "password", "hostIps", "host", "port"].some((f) => r[f]?.trim())) p.includesCredentials = true;
    const v: Record<string, Value> = {
      enterprise_id: ent,
      name,
      protocol: r.protocol?.trim().toLowerCase() || "smpp",
      product_category_id: category,
      billing_type: r.billingType?.trim().toLowerCase() || "submit",
      tps,
      bind_type: "TR",
      max_connections: 2,
    };
    if (kind === "customer") {
      let username = r.username?.trim();
      if (!username) {
        if (m.action === "create") {
          username = `imp_${name
            .replace(/[^A-Za-z0-9]+/g, "")
            .slice(0, 10)
            .toLowerCase()}_${randomBytes(2).toString("hex")}`;
          p.issue(
            entity,
            line,
            "username",
            `No System ID in the file: ${username} is set; change it before go-live`,
            "warning",
          );
        }
      } else {
        const owner = usernames.get(username);
        if (owner != null && owner !== m.id) {
          p.issue(entity, line, "username", `System ID "${username}" is used by another customer trunk`);
          return void (pr.action = "error");
        }
        usernames.set(username, m.id ?? -1 - i);
      }
      v.username = username;
      v.password = r.password?.trim() || (m.action === "create" ? randomBytes(6).toString("base64url") : undefined);
      if (!r.password?.trim() && m.action === "create")
        p.issue(entity, line, "password", "No password in the file: a random one is set", "warning");
      // Addresses, networks and ranges, checked here (R9): a bad one used to pass the dry run and fail Apply.
      if (r.hostIps?.trim()) {
        const hosts = hostNetworks(list(r.hostIps));
        for (const e of hosts.errors) p.issue(entity, line, "hostIps", `"${list(r.hostIps)[e.index]}": ${e.message}`);
        if (hosts.errors.length) return void (pr.action = "error");
        v.host_ips = hosts.networks;
      } else v.host_ips = m.action === "create" ? [] : undefined;
      // The port is not imported: it follows the SSL type (2775 / 2776, migration 070).
      v.ssl_type = r.sslType?.trim().toLowerCase() || (m.action === "create" ? "none" : undefined);
    } else {
      v.port = port ?? 2775;
      v.host = r.host?.trim() || (m.action === "create" ? "not-set.invalid" : undefined);
      if (!r.host?.trim() && m.action === "create")
        p.issue(entity, line, "host", "No host in the file: the trunk cannot bind until one is set", "warning");
      v.username = r.username?.trim() || (m.action === "create" ? "not-set" : undefined);
      v.password = r.password?.trim() || (m.action === "create" ? "not-set" : undefined);
    }
    if (m.action !== "create") {
      if (!r.port?.trim()) delete v.port;
      if (!r.category?.trim()) delete v.product_category_id;
    }
    pr.values = v;
  });
  out.forEach((r, i) => r.action !== "error" && p.index(entity, i, r.externalId, lower(String(r.values.name))));
  return out;
}

function planRateTables(p: Planner, raws: Raw[]): PlanRow[] {
  const out: PlanRow[] = [];
  const seen = new Set<string>();
  const trunkTables = new Map<string, number>();
  raws.forEach((r, i) => {
    const line = i + 2;
    const ext = r.externalId?.trim() || null;
    const pr = row(line, ext);
    out.push(pr);
    if (!required(p, "rate_tables", line, r)) return void (pr.action = "error");
    const name = r.name!.trim();
    const kind = r.kind!.trim().toLowerCase();
    const key = `${kind}:${lower(name)}`;
    if (seen.has(key) && !ext) {
      p.issue("rate_tables", line, "name", `"${name}" appears twice in the file: give each row its external ID`);
      return void (pr.action = "error");
    }
    seen.add(key);
    const currency = r.currency!.trim().toUpperCase();
    if (!p.lk.currencies.has(currency)) {
      p.issue("rate_tables", line, "currency", `Currency "${r.currency}" does not exist`);
      return void (pr.action = "error");
    }
    const category = p.resolve("product_categories", r.category!, p.lk.categories);
    if (category == null) {
      p.issue("rate_tables", line, "category", `Product category "${r.category}" does not exist`);
      return void (pr.action = "error");
    }
    const m = p.match("rate_tables", line, ext, p.lk.rateTables.get(key) ?? null);
    pr.action = m.action;
    pr.existingId = m.id;
    let vendor: Ref | number | null = null;
    if (kind === "vendor") {
      vendor = r.vendorTrunk?.trim() ? p.resolve("vendor_trunks", r.vendorTrunk, p.lk.vendorTrunks) : null;
      if (vendor == null) {
        p.issue(
          "rate_tables",
          line,
          "vendorTrunk",
          `A vendor table needs its vendor trunk ("${r.vendorTrunk ?? ""}" not found)`,
        );
        return void (pr.action = "error");
      }
      const k = vendor instanceof Ref ? `new:${vendor.row}` : `id:${vendor}`;
      const has = vendor instanceof Ref ? undefined : p.lk.vendorTables.get(vendor);
      if (m.action === "create" && (trunkTables.has(k) || has != null)) {
        p.issue("rate_tables", line, "vendorTrunk", "That vendor trunk already has a rate table");
        return void (pr.action = "error");
      }
      trunkTables.set(k, i);
    }
    const trunks: (Ref | number)[] = [];
    for (const t of list(r.customerTrunks)) {
      const id = p.resolve("customer_trunks", t, p.lk.customerTrunks);
      if (id == null)
        p.issue("rate_tables", line, "customerTrunks", `Customer trunk "${t}" not found; not linked`, "warning");
      else trunks.push(id);
    }
    pr.values = {
      kind,
      name,
      product_category_id: category,
      currency,
      vendor_trunk_id: vendor,
    };
    pr.extra = { customerTrunks: trunks };
  });
  out.forEach((r, i) => {
    const raw = raws[i]!;
    if (r.action === "error") p.fail("rate_tables", r.externalId, lower(raw.name ?? ""));
    else p.index("rate_tables", i, r.externalId, `${r.values.kind}:${lower(String(r.values.name))}`);
  });
  return out;
}

function planRateLines(p: Planner, raws: Raw[], tables: PlanRow[]): PlanRow[] {
  const out: PlanRow[] = [];
  const warned = new Set<string>();
  const existing = new Set<string>();
  const now = new Date();
  const groups = new Map<string, PlanRow[]>();
  raws.forEach((r, i) => {
    const line = i + 2;
    const pr = row(line, null);
    out.push(pr);
    if (!required(p, "rate_lines", line, r)) return void (pr.action = "error");
    const tableKey = r.rateTable!.trim();
    if (p.failed.has(`rate_tables:${tableKey}`) || p.failed.has(`rate_tables:${lower(tableKey)}`))
      return void (pr.action = "skip");
    const ref =
      p.resolve("rate_tables", tableKey, NONE, `customer:${lower(tableKey)}`) ??
      p.resolve("rate_tables", tableKey, NONE, `vendor:${lower(tableKey)}`);
    if (!(ref instanceof Ref)) {
      if (ref == null && !warned.has(tableKey)) {
        warned.add(tableKey);
        p.issue("rate_lines", line, "rateTable", `Rate table "${tableKey}" is not in this import`);
      }
      if (ref != null) existing.add(tableKey);
      pr.action = ref == null ? "error" : "skip";
      return;
    }
    const mcc = r.mccmnc!.trim();
    const mccId = p.lk.mccmnc.get(mcc);
    if (mccId == null) {
      p.issue("rate_lines", line, "mccmnc", `MCCMNC "${mcc}" is not in the master`);
      return void (pr.action = "error");
    }
    const rate = num(r.rate);
    if (rate == null || !Number.isFinite(rate) || rate < 0) {
      p.issue("rate_lines", line, "rate", `Rate "${r.rate}" must be a number of 0 or more`);
      return void (pr.action = "error");
    }
    const from = r.validFrom?.trim()
      ? new Date(
          /^\d{4}-\d{2}-\d{2}$/.test(r.validFrom.trim()) ? `${r.validFrom.trim()}T00:00:00Z` : r.validFrom.trim(),
        )
      : now;
    if (Number.isNaN(from.getTime())) {
      p.issue("rate_lines", line, "validFrom", `"${r.validFrom}" is not a date`);
      return void (pr.action = "error");
    }
    const sender = r.senderId?.trim() || null;
    pr.values = {
      rate_table_id: ref,
      mccmnc_id: mccId,
      mccmnc: mcc,
      sender_id: sender,
      rate,
      valid_from: from.toISOString(),
      valid_to: null,
      is_blocked: yes(r.blocked),
    };
    const g = `${ref.row}|${mccId}|${sender ?? ""}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(pr);
  });
  if (existing.size)
    p.issue(
      "rate_lines",
      0,
      "rateTable",
      `Lines of ${existing.size} rate tables that already exist are skipped (e.g. ${[...existing].slice(0, 3).join(", ")}): ` +
        "lines go only into tables this import creates; use the Rate Manager upload for the rest",
      "warning",
    );
  // Versions of one destination follow each other: each ends where the next starts.
  for (const g of groups.values()) {
    g.sort((a, b) => String(a.values.valid_from).localeCompare(String(b.values.valid_from)));
    for (let k = 0; k < g.length - 1; k++) {
      if (g[k]!.values.valid_from === g[k + 1]!.values.valid_from) {
        p.issue(
          "rate_lines",
          g[k + 1]!.line,
          "validFrom",
          "Same destination and sender twice with the same start date",
        );
        g[k + 1]!.action = "error";
      } else g[k]!.values.valid_to = g[k + 1]!.values.valid_from;
    }
  }
  void tables;
  return out;
}

function planRouteRules(p: Planner, raws: Raw[]): PlanRow[] {
  const out: PlanRow[] = [];
  const seen = new Set<string>();
  raws.forEach((r, i) => {
    const line = i + 2;
    const ext = r.externalId?.trim() || null;
    const pr = row(line, ext);
    out.push(pr);
    if (!required(p, "route_rules", line, r)) return void (pr.action = "error");
    const name = r.name!.trim();
    if (seen.has(lower(name)) && !ext) {
      p.issue("route_rules", line, "name", `"${name}" appears twice in the file: give each row its external ID`);
      return void (pr.action = "error");
    }
    seen.add(lower(name));
    const priority = num(r.priority);
    if (priority == null || !Number.isInteger(priority) || priority < 1 || priority > 100) {
      p.issue("route_rules", line, "priority", `Priority "${r.priority}" must be 1 to 100`);
      return void (pr.action = "error");
    }
    const trunks: (Ref | number)[] = [];
    for (const t of list(r.customerTrunks)) {
      const id = p.resolve("customer_trunks", t, p.lk.customerTrunks);
      if (id == null) {
        p.issue("route_rules", line, "customerTrunks", `Customer trunk "${t}" not found`);
        return void (pr.action = "error");
      }
      trunks.push(id);
    }
    const dest = list(r.destinations);
    const bad = dest.filter((d) => !p.lk.mccmnc.has(d));
    if (bad.length) {
      p.issue("route_rules", line, "destinations", `Not in the MCCMNC master: ${bad.slice(0, 5).join(", ")}`);
      return void (pr.action = "error");
    }
    const vendors: { trunk: Ref | number; share: number | null }[] = [];
    for (const part of list(r.vendors)) {
      const at = part.lastIndexOf(":");
      const key = at > 0 ? part.slice(0, at) : part;
      const share = at > 0 ? num(part.slice(at + 1)) : null;
      const id = p.resolve("vendor_trunks", key, p.lk.vendorTrunks);
      if (id == null) {
        p.issue("route_rules", line, "vendors", `Vendor trunk "${key}" not found`);
        return void (pr.action = "error");
      }
      if (share != null && (!Number.isInteger(share) || share < 0 || share > 100)) {
        p.issue("route_rules", line, "vendors", `Share "${part}" must be 0 to 100`);
        return void (pr.action = "error");
      }
      vendors.push({ trunk: id, share });
    }
    const shares = vendors.filter((v) => v.share != null);
    if (shares.length && shares.reduce((s, v) => s + v.share!, 0) !== 100)
      p.issue("route_rules", line, "vendors", "Vendor shares do not add up to 100", "warning");
    const m = p.match("route_rules", line, ext, p.lk.routeRules.get(lower(name)) ?? null);
    pr.action = m.action;
    pr.existingId = m.id;
    pr.values = {
      name,
      priority,
      status: r.status?.trim().toLowerCase() || "active",
      customer_trunk_mode: trunks.length ? "inclusive" : "all",
      customer_trunk_ids: trunks,
      mccmnc_mode: dest.length ? "inclusive" : "all",
      mccmncs: dest,
    };
    pr.extra = { vendors, percentage: shares.length > 0 };
  });
  out.forEach((r, i) => r.action !== "error" && p.index("route_rules", i, r.externalId, lower(String(r.values.name))));
  return out;
}

function planBalances(p: Planner, raws: Raw[]): PlanRow[] {
  let kept = 0;
  const out = raws.map((r, i) => {
    const line = i + 2;
    const pr = row(line, null);
    if (!required(p, "opening_balances", line, r)) return { ...pr, action: "error" as const };
    const ent = p.resolve("enterprises", r.enterprise!, p.lk.enterprises);
    if (ent == null) {
      p.issue("opening_balances", line, "enterprise", `Enterprise "${r.enterprise}" not found`);
      return { ...pr, action: "error" as const };
    }
    const amount = num(r.amount);
    if (amount == null || !Number.isFinite(amount)) {
      p.issue("opening_balances", line, "amount", `Amount "${r.amount}" is not a number`);
      return { ...pr, action: "error" as const };
    }
    const currency = r.currency!.trim().toUpperCase();
    if (!p.lk.currencies.has(currency)) {
      p.issue("opening_balances", line, "currency", `Currency "${r.currency}" does not exist`);
      return { ...pr, action: "error" as const };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date!.trim())) {
      p.issue("opening_balances", line, "date", `Date "${r.date}" must be YYYY-MM-DD`);
      return { ...pr, action: "error" as const };
    }
    if (amount === 0) return { ...pr, action: "skip" as const };
    // A partner already in the system keeps its balance: only partners this import creates get one.
    if (!(ent instanceof Ref)) {
      kept++;
      return { ...pr, action: "skip" as const };
    }
    return {
      ...pr,
      values: { enterprise_id: ent, side: r.side!.trim().toLowerCase(), amount, currency, date: r.date!.trim() },
    };
  });
  if (kept)
    p.issue(
      "opening_balances",
      0,
      "enterprise",
      `${kept} balances belong to partners already in the system: their balances stay as they are (adjust them in Finance)`,
      "warning",
    );
  return out;
}

// ---------------------------------------------------------------- dry run

/** Validates every file and returns the plan; writes nothing. */
// ---------------------------------------------------------------- team trial round 12: lists, rules, departments

/** A record kept by name only (departments, product categories): one row each, matched by external ID or name. */
function planNamed(
  p: Planner,
  entity: "departments" | "product_categories",
  raws: Raw[],
  system: Map<string, number>,
  values: (r: Raw, name: string) => Record<string, Value>,
): PlanRow[] {
  const seen = new Set<string>();
  const out = raws.map((r, i) => {
    const line = i + 2;
    const ext = r.externalId?.trim() || null;
    const pr = row(line, ext);
    if (!required(p, entity, line, r)) return { ...pr, action: "error" as const };
    const name = r.name!.trim();
    if (seen.has(lower(name))) {
      p.issue(entity, line, "name", `"${name}" appears twice in the file`);
      return { ...pr, action: "error" as const };
    }
    seen.add(lower(name));
    const m = p.match(entity, line, ext, system.get(lower(name)) ?? null);
    if (m.action === "create" && entity === "departments" && p.lk.archivedDepartments.has(lower(name))) {
      p.issue(entity, line, "name", `Department "${name}" was deleted: restore it on the Departments page first`);
      return { ...pr, action: "error" as const };
    }
    return { ...pr, action: m.action, existingId: m.id, values: values(r, name) };
  });
  out.forEach((r, i) => r.action !== "error" && p.index(entity, i, r.externalId, lower(String(r.values.name))));
  return out;
}

/**
 * Number lists: one row per value (or several values separated by , or ;); rows with the same list name go into one
 * list. A list that exists keeps its type and gets the values it lacks; `existing` holds its current values.
 */
function planNumberLists(p: Planner, raws: Raw[], existing: Map<string, Set<string>>): PlanRow[] {
  const typeOf = new Map<string, string>();
  const added = new Map<string, Set<string>>();
  return raws.map((r, i) => {
    const line = i + 2;
    const pr = row(line, null);
    if (!required(p, "number_lists", line, r)) return { ...pr, action: "error" as const };
    const name = r.name!.trim();
    const key = lower(name);
    const type = r.type!.trim().toLowerCase();
    const system = p.lk.numberLists.get(key);
    const listType = system?.type ?? typeOf.get(key) ?? type;
    if (listType !== type) {
      p.issue("number_lists", line, "type", `List "${name}" is a ${listType} list, not ${type}`);
      return { ...pr, action: "error" as const };
    }
    typeOf.set(key, type);
    if (!system) p.newLists.set(key, type);
    const content = r.content?.trim() || null;
    if (content && type !== "sender_id_template") {
      p.issue("number_lists", line, "content", "Content goes only in a sender_id_template list");
      return { ...pr, action: "error" as const };
    }
    const values = list(r.value);
    for (const v of values) {
      const problem = entryProblem(type as "random" | "tag" | "sender_id_template", v);
      if (problem) {
        p.issue("number_lists", line, "value", `"${v}": ${problem}`);
        return { ...pr, action: "error" as const };
      }
    }
    const have = existing.get(key) ?? new Set<string>();
    const mine = added.get(key) ?? new Set<string>();
    added.set(key, mine);
    const fresh = values.filter(
      (v) => !have.has(`${v}\u0000${content ?? ""}`) && !mine.has(`${v}\u0000${content ?? ""}`),
    );
    fresh.forEach((v) => mine.add(`${v}\u0000${content ?? ""}`));
    return {
      ...pr,
      action: fresh.length ? ("create" as const) : ("skip" as const),
      existingId: system?.id ?? null,
      values: { name, list_type: type },
      extra: { entries: fresh.map((v) => ({ value: v, content })) },
    };
  });
}

/** Trunk names to rule targets; "all" (any case) targets every trunk of that side. */
function trunkTargets(
  p: Planner,
  entity: Ent,
  line: number,
  field: string,
  names: string[],
  kind: "customer" | "vendor",
): { type: "trunk" | "all"; trunkKind: "customer" | "vendor"; id: Value }[] | null {
  const out: { type: "trunk" | "all"; trunkKind: "customer" | "vendor"; id: Value }[] = [];
  for (const n of names) {
    if (lower(n) === "all") {
      out.push({ type: "all", trunkKind: kind, id: null });
      continue;
    }
    const id = p.resolve(`${kind}_trunks`, n, kind === "customer" ? p.lk.customerTrunks : p.lk.vendorTrunks);
    if (id == null) {
      p.issue(entity, line, field, `${kind === "customer" ? "Customer" : "Vendor"} trunk "${n}" not found`);
      return null;
    }
    out.push({ type: "trunk", trunkKind: kind, id });
  }
  return out;
}

/** A number list by name: in the system or created by this import; its type for the checks. */
function listType(p: Planner, name: string): string | null {
  return p.lk.numberLists.get(lower(name))?.type ?? p.newLists.get(lower(name)) ?? null;
}

const smallInt = (s: string | undefined, max: number): number | null | "bad" => {
  const n = num(s);
  if (n == null) return null;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : "bad";
};

/**
 * Translation rules (§13.2): the form's own checks run after planning (checkTranslationRows); lists and trunks are
 * checked here because they may come from this same import.
 */
function planTranslationRules(p: Planner, raws: Raw[]): PlanRow[] {
  const seen = new Set<string>();
  const out = raws.map((r, i) => {
    const line = i + 2;
    const ext = r.externalId?.trim() || null;
    const pr = row(line, ext);
    const bad = (field: string, message: string) => {
      p.issue("translation_rules", line, field, message);
      return { ...pr, action: "error" as const };
    };
    if (!required(p, "translation_rules", line, r)) return { ...pr, action: "error" as const };
    const name = r.name!.trim();
    if (seen.has(lower(name)) && !ext)
      return bad("name", `"${name}" appears twice in the file: give each row its external ID`);
    seen.add(lower(name));
    const customer = trunkTargets(p, "translation_rules", line, "customerTrunks", list(r.customerTrunks), "customer");
    if (!customer) return { ...pr, action: "error" as const };
    const vendor = trunkTargets(p, "translation_rules", line, "vendorTrunks", list(r.vendorTrunks), "vendor");
    if (!vendor) return { ...pr, action: "error" as const };
    const dest = list(r.mccmncs);
    const unknown = dest.filter((d) => !p.lk.mccmnc.has(d));
    if (unknown.length) return bad("mccmncs", `Not in the MCCMNC master: ${unknown.slice(0, 5).join(", ")}`);
    // Each list by name, with its ID when it is already in the system (a list of this import gets its ID on apply).
    const lists: Record<string, { name: string; id: number | null } | null> = {};
    for (const f of ["senderList", "receiverList", "senderConversionList"]) {
      const n = r[f]?.trim() || null;
      if (n && !listType(p, n)) return bad(f, `Number list "${n}" not found`);
      lists[f] = n ? { name: n, id: p.lk.numberLists.get(lower(n))?.id ?? null } : null;
    }
    const sc = r.senderConversion?.trim().toLowerCase() || null;
    if (lists.senderConversionList) {
      const want = sc === "random_number" ? "random" : sc === "sender_id_template" ? "sender_id_template" : null;
      if (!want) return bad("senderConversionList", "Only random_number and sender_id_template use a list");
      if (listType(p, lists.senderConversionList.name) !== want)
        return bad("senderConversionList", `Pick a ${want} list`);
    } else if (sc === "random_number" || sc === "sender_id_template")
      return bad("senderConversionList", `${sc} needs a number list`);
    const ton: Record<string, number | null> = {};
    for (const [f, max] of [
      ["senderTon", 6],
      ["senderNpi", 18],
      ["destTon", 6],
      ["destNpi", 18],
    ] as const) {
      const v = smallInt(r[f], max);
      if (v === "bad") return bad(f, `"${r[f]}" must be 0 to ${max}`);
      ton[f] = v;
    }
    const m = p.match("translation_rules", line, ext, p.lk.translationRules.get(lower(name)) ?? null);
    if (m.action === "update") {
      p.issue(
        "translation_rules",
        line,
        "name",
        `Rule "${name}" exists; updating rules by import is not offered, skipped`,
        "warning",
      );
      return { ...pr, action: "skip" as const, existingId: m.id, values: { name } };
    }
    const direction = r.direction?.trim().toLowerCase() || null;
    const input = {
      name,
      direction: direction as "ingress" | "egress" | null,
      action: (r.action?.trim().toLowerCase() || "allow") as "allow" | "block",
      status: (r.status?.trim().toLowerCase() || "active") as "active" | "inactive",
      continueAfter: lower(r.continueAfter ?? "") === "yes",
      senderPattern: r.senderPattern?.trim() || null,
      receiverPattern: r.receiverPattern?.trim() || null,
      contentPattern: r.contentPattern?.trim() || null,
      mccmncs: dest,
      senderConversion: sc,
      senderConversionValue: r.senderConversionValue?.trim() || null,
      receiverConversion: r.receiverConversion?.trim().toLowerCase() || null,
      receiverConversionValue: r.receiverConversionValue?.trim() || null,
      senderTon: ton.senderTon,
      senderNpi: ton.senderNpi,
      destTon: ton.destTon,
      destNpi: ton.destNpi,
    };
    return {
      ...pr,
      action: m.action,
      existingId: m.id,
      values: { name },
      extra: { input, lists, targets: [...customer, ...vendor] },
    };
  });
  out.forEach(
    (r, i) => r.action !== "error" && p.index("translation_rules", i, r.externalId, lower(String(r.values.name))),
  );
  return out;
}

/** The rule form's input for an imported translation rule (blank form + the file's columns). */
function translationInput(
  extra: Record<string, Value>,
  resolveList: (l: { name: string; id: number | null } | null) => number | null,
) {
  const x = extra.input as Record<string, unknown>;
  const lists = extra.lists as Record<string, { name: string; id: number | null } | null>;
  return {
    direction: null,
    action: "allow",
    status: "active",
    continueAfter: false,
    senderPatternNegate: false,
    senderMatchCase: true,
    receiverPatternNegate: false,
    senderValues: [],
    receiverValues: [],
    mccmncNegate: false,
    mccmncPattern: null,
    contentPatternNegate: false,
    senderListNegate: false,
    receiverListNegate: false,
    senderConversionReplacement: null,
    receiverConversionReplacement: null,
    billingType: null,
    registeredDelivery: null,
    dlrMap: [],
    contentRegex: null,
    contentRegexIndex: null,
    contentReplacement: null,
    msgTemplate: null,
    contentWords: [],
    contentNumberFormat: null,
    contentNumberMinDigits: null,
    senderMinLength: 0,
    senderMaxLength: 20,
    receiverMinLength: 0,
    receiverMaxLength: 20,
    startsAt: null,
    stopsAt: null,
    insertAt: "bottom",
    ...x,
    senderListId: resolveList(lists.senderList ?? null),
    receiverListId: resolveList(lists.receiverList ?? null),
    senderConversionListId: resolveList(lists.senderConversionList ?? null),
    targets: [],
  } as unknown as TranslationRuleInput;
}

/** The rule form's own checks on each planned rule; lists, trunks and codes were checked while planning. */
async function checkTranslationRows(c: Db, p: Planner, rows: PlanRow[]) {
  const SKIP = /^\/(senderListId|receiverListId|senderConversionListId|targets|mccmncs)/;
  for (const r of rows) {
    if (r.action !== "create") continue;
    const errors = await checkRule(c, normalise(translationInput(r.extra, () => null)));
    const real = errors.filter((e) => !SKIP.test(e.path));
    for (const e of real) p.issue("translation_rules", r.line, e.path.slice(1), `${e.path.slice(1)}: ${e.message}`);
    if (real.length) r.action = "error";
  }
}

/** HLR rules (§13.24): an existing provider, a receiver pattern and the trunks (empty = every trunk). */
function planHlrRules(p: Planner, raws: Raw[]): PlanRow[] {
  const seen = new Set<string>();
  const out = raws.map((r, i) => {
    const line = i + 2;
    const ext = r.externalId?.trim() || null;
    const pr = row(line, ext);
    const bad = (field: string, message: string) => {
      p.issue("hlr_rules", line, field, message);
      return { ...pr, action: "error" as const };
    };
    if (!required(p, "hlr_rules", line, r)) return { ...pr, action: "error" as const };
    const name = r.name!.trim();
    if (seen.has(lower(name)) && !ext)
      return bad("name", `"${name}" appears twice in the file: give each row its external ID`);
    seen.add(lower(name));
    const provider = p.lk.hlrProviders.get(lower(r.provider!));
    if (provider == null)
      return bad("provider", `HLR provider "${r.provider}" not found: add it on the HLR page first`);
    const pattern = r.dnidPattern!.trim();
    if (!compilePattern(pattern)) return bad("dnidPattern", `"${pattern}" is not a valid regular expression`);
    const names = list(r.customerTrunks);
    const targets = names.length
      ? trunkTargets(p, "hlr_rules", line, "customerTrunks", names, "customer")
      : [{ type: "all" as const, trunkKind: "customer" as const, id: null }];
    if (!targets) return { ...pr, action: "error" as const };
    const m = p.match("hlr_rules", line, ext, p.lk.hlrRules.get(lower(name)) ?? null);
    return {
      ...pr,
      action: m.action,
      existingId: m.id,
      values: {
        name,
        hlr_provider_id: provider,
        dnid_pattern: pattern,
        status: r.status?.trim().toLowerCase() || "active",
      },
      extra: { targets: targets.map((t) => ({ type: t.type, id: t.id })) },
    };
  });
  out.forEach((r, i) => r.action !== "error" && p.index("hlr_rules", i, r.externalId, lower(String(r.values.name))));
  return out;
}

export async function planImport(
  c: Db,
  settings: ImportSettings,
  mappings: Map<number, { entity: string; columns: Record<string, string> }>,
): Promise<Plan> {
  const lk = await loadLookups(c, settings.sourceSystem);
  const p = new Planner(lk, settings.conflicts, settings.trunksInactive);
  const raws = new Map<Ent, Raw[]>();
  const source = new Map<Ent, number>();
  for (const f of settings.files) {
    if (raws.has(f.entity)) {
      p.issue(f.entity, 0, null, `Two files for ${ENTITY.get(f.entity)!.label}: send one per entity`);
      continue;
    }
    const mapping = f.mappingId != null ? mappings.get(f.mappingId) : null;
    if (f.mappingId != null && (!mapping || mapping.entity !== f.entity)) {
      p.issue(f.entity, 0, null, `Mapping ${f.mappingId} is not a mapping for ${f.entity}`);
      continue;
    }
    const { rows, missing } = mapRows(f, mapping?.columns ?? null);
    source.set(f.entity, rows.length);
    if (missing.length) {
      p.issue(f.entity, 1, null, `${f.fileName}: missing columns ${missing.join(", ")}`);
      continue;
    }
    raws.set(f.entity, rows);
  }
  // Number lists: the values the file's lists already hold, so only new ones are added (team trial round 12).
  const listValues = new Map<string, Set<string>>();
  const listNames = [...new Set((raws.get("number_lists") ?? []).map((r) => lower(r.name ?? "")).filter(Boolean))];
  if (listNames.length) {
    const { rows } = await c.query(
      `SELECT lower(l.name) AS k, e.value, coalesce(e.content, '') AS content
         FROM number_lists l JOIN number_list_entries e ON e.number_list_id = l.id AND e.deleted_at IS NULL
        WHERE l.deleted_at IS NULL AND lower(l.name) = ANY($1)`,
      [listNames],
    );
    for (const r of rows) {
      if (!listValues.has(r.k)) listValues.set(r.k, new Set());
      listValues.get(r.k)!.add(`${r.value}\u0000${r.content}`);
    }
  }
  for (const info of IMPORT_ENTITIES) {
    const e = info.entity as Ent;
    const rs = raws.get(e);
    if (!rs) continue;
    let planned: PlanRow[];
    switch (e) {
      case "departments":
        planned = planNamed(p, e, rs, p.lk.departments, (r, name) => ({
          name,
          description: r.description?.trim() || null,
          status: r.status?.trim().toLowerCase() || "active",
        }));
        break;
      case "product_categories":
        planned = planNamed(p, e, rs, p.lk.categories, (_r, name) => ({ name }));
        break;
      case "number_lists":
        planned = planNumberLists(p, rs, listValues);
        break;
      case "translation_rules":
        planned = planTranslationRules(p, rs);
        await checkTranslationRows(c, p, planned);
        break;
      case "hlr_rules":
        planned = planHlrRules(p, rs);
        break;
      case "users":
        planned = planUsers(p, rs);
        break;
      case "enterprises":
        planned = planEnterprises(p, rs);
        break;
      case "customer_trunks":
        planned = planTrunks(p, "customer", rs);
        break;
      case "vendor_trunks":
        planned = planTrunks(p, "vendor", rs);
        break;
      case "rate_tables":
        planned = planRateTables(p, rs);
        break;
      case "rate_lines":
        planned = planRateLines(p, rs, p.rows.get("rate_tables") ?? []);
        break;
      case "route_rules":
        planned = planRouteRules(p, rs);
        break;
      case "opening_balances":
        planned = planBalances(p, rs);
        break;
    }
    // Rows must be visible to resolve() as soon as they are indexed.
    p.rows.set(e, planned);
    await diffUpdates(c, e, planned);
  }
  // Lines of a rate table that failed or was skipped follow it.
  const tables = p.rows.get("rate_tables") ?? [];
  for (const l of p.rows.get("rate_lines") ?? []) {
    const ref = l.values.rate_table_id;
    if (ref instanceof Ref && tables[ref.row]?.action !== "create" && l.action !== "error") l.action = "skip";
  }
  const entities: MigrationEntityReport[] = IMPORT_ENTITIES.filter((i) => source.has(i.entity as Ent)).map((i) => {
    const e = i.entity as Ent;
    const rs = p.rows.get(e) ?? [];
    const n = (a: Action) => rs.filter((r) => r.action === a).length;
    return {
      entity: e,
      rows: rs.length,
      create: n("create"),
      update: n("update"),
      skip: n("skip"),
      errors: n("error"),
      source: source.get(e) ?? 0,
      inSystem: lk.counts[e],
    };
  });
  const errors = p.issues.some((x) => x.severity === "error") || entities.some((x) => x.errors > 0);
  return {
    sourceSystem: settings.sourceSystem,
    trunksInactive: settings.trunksInactive,
    rows: p.rows,
    includesCredentials: p.includesCredentials,
    report: {
      entities,
      issues: p.issues,
      issueCount: p.issueCount,
      canApply: !errors && entities.some((x) => x.create + x.update > 0),
    },
  };
}

// ---------------------------------------------------------------- apply

export interface Entry {
  table: string;
  entity_id: number;
  field: "*" | "row";
  before: unknown;
  after: unknown;
}

/** Two IDs as the database and the plan carry them (bigint text or number), or both none. */
export const sameId = (a: unknown, b: unknown) => String(a ?? "") === String(b ?? "");

/**
 * The enterprise's account manager from now on in its AM history (QA 2026-10-31, §13.30): reports attribute traffic by
 * that history, and a load re-applies the history's current AM over enterprises.account_manager_id, so an AM the import
 * sets without a history row was flipped back. Ends the current assignment now and drops a scheduled one, as a
 * handover does; `userId` null leaves the enterprise without one.
 */
export async function setAmFromNow(
  c: pg.PoolClient,
  enterpriseId: number,
  userId: number | null,
  note: string,
  byId: number,
): Promise<void> {
  await c.query("DELETE FROM enterprise_am_history WHERE enterprise_id = $1 AND starts_at > now()", [enterpriseId]);
  await c.query(
    `UPDATE enterprise_am_history SET ends_at = now()
      WHERE enterprise_id = $1 AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())`,
    [enterpriseId],
  );
  if (userId !== null)
    await c.query(
      `INSERT INTO enterprise_am_history (enterprise_id, user_id, starts_at, note, created_by_id)
       VALUES ($1, $2, now(), $3, $4)`,
      [enterpriseId, userId, note, byId],
    );
}

/** Runs the plan inside the caller's transaction; returns the History entries and created trunk IDs. */
export async function applyPlan(c: pg.PoolClient, plan: Plan, importId: number, userId: number) {
  await c.query("SET LOCAL statement_timeout = 0");
  const ids = new Map<Ent, (number | null)[]>();
  const entries: Entry[] = [];
  const resolve = (v: Value): Value => {
    if (v instanceof Ref) {
      const id = ids.get(v.entity)?.[v.row];
      if (id == null) throw new Error(`Unresolved link to ${v.entity} row ${v.row + 2}`);
      return id;
    }
    return Array.isArray(v) ? v.map(resolve) : v;
  };
  const insert = async (table: string, values: Record<string, Value>) => {
    const cols = Object.keys(values);
    const { rows } = await c.query(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      cols.map((k) => resolve(values[k])),
    );
    return Number(rows[0].id);
  };
  const refs: { entity: Ent; ext: string; id: number }[] = [];
  const TABLE: Record<Ent, string> = {
    departments: "departments",
    product_categories: "product_categories",
    number_lists: "number_lists",
    translation_rules: "translation_rules",
    hlr_rules: "hlr_rules",
    users: "users",
    enterprises: "enterprises",
    customer_trunks: "customer_trunks",
    vendor_trunks: "vendor_trunks",
    rate_tables: "rate_tables",
    rate_lines: "rate_lines",
    route_rules: "route_rules",
    opening_balances: "transactions",
  };
  const label = (v: Record<string, Value>) => (v.name ?? v.username ?? null) as string | null;
  // Number lists this import created or added to, by lower-case name (translation rules point at them by name).
  const listIds = new Map<string, number>();

  for (const info of IMPORT_ENTITIES) {
    const e = info.entity as Ent;
    const rows = plan.rows.get(e);
    if (!rows) continue;
    const out: (number | null)[] = rows.map((r) => r.existingId);
    ids.set(e, out);
    const table = TABLE[e];

    if (e === "number_lists") {
      // Team trial round 12: rows of one list go into one list; a list the import creates is one History entry (undo
      // archives it), values added to an existing list are one entry each (undo removes them).
      const created = new Set<number>();
      for (const r of rows) {
        if (r.action !== "create") continue;
        const name = String(r.values.name);
        let id = listIds.get(lower(name)) ?? r.existingId;
        if (id == null) {
          id = await insert("number_lists", { name, list_type: r.values.list_type, updated_by_id: userId });
          created.add(id);
          entries.push({ table, entity_id: id, field: "*", before: null, after: `Number lists: ${name}` });
        }
        listIds.set(lower(name), id);
        const vals = r.extra.entries as { value: string; content: string | null }[];
        const { rows: added } = await c.query(
          `INSERT INTO number_list_entries (number_list_id, value, content, created_by_id)
           SELECT $1, v, nullif(ct, ''), $4 FROM unnest($2::text[], $3::text[]) AS x(v, ct)
           ON CONFLICT DO NOTHING RETURNING id`,
          [id, vals.map((x) => x.value), vals.map((x) => x.content ?? ""), userId],
        );
        if (!created.has(id))
          for (const a of added)
            entries.push({
              table: "number_list_entries",
              entity_id: Number(a.id),
              field: "*",
              before: null,
              after: `Number list ${name}: entry`,
            });
      }
      continue;
    }

    if (e === "rate_lines") {
      // Bulk: one statement per 5,000 lines. Undoing the import archives their tables.
      const todo = rows.filter((r) => r.action === "create");
      for (let k = 0; k < todo.length; k += 5000) {
        const part = todo
          .slice(k, k + 5000)
          .map((r): Record<string, Value> => ({ ...r.values, rate_table_id: resolve(r.values.rate_table_id) }));
        const tableIds = part.map((v) => v.rate_table_id as number);
        const { rows: cur } = await c.query("SELECT id, currency FROM rate_tables WHERE id = ANY($1)", [
          [...new Set(tableIds)],
        ]);
        const currency = new Map(cur.map((x) => [Number(x.id), x.currency]));
        await c.query(
          `INSERT INTO rate_lines (rate_table_id, mccmnc_id, mccmnc, sender_id, rate, currency, valid_from, valid_to,
                                   is_blocked, change_type, rate_note, created_by_id)
           SELECT t, m, mm, s, r, cur, vf, vt, b, 'new', $11, $12
             FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::numeric[], $6::char(3)[],
                         $7::timestamptz[], $8::timestamptz[], $9::boolean[]) AS x(t, m, mm, s, r, cur, vf, vt, b)
            WHERE $10::boolean`,
          [
            tableIds,
            part.map((v) => v.mccmnc_id),
            part.map((v) => v.mccmnc),
            part.map((v) => v.sender_id),
            part.map((v) => v.rate),
            part.map((v) => currency.get(v.rate_table_id as number)),
            part.map((v) => v.valid_from),
            part.map((v) => v.valid_to),
            part.map((v) => v.is_blocked),
            true,
            `Imported from ${plan.sourceSystem}`,
            userId,
          ],
        );
      }
      continue;
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.action === "update" && r.existingId != null) {
        const after = Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, resolve(v)]));
        const cols = Object.keys(after);
        await c.query(
          `UPDATE ${table} SET ${cols.map((k, n) => `${k} = $${n + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
          [r.existingId, ...cols.map((k) => after[k])],
        );
        entries.push({ table, entity_id: r.existingId, field: "row", before: r.before, after });
        if (
          e === "enterprises" &&
          "account_manager_id" in after &&
          !sameId(after.account_manager_id, r.before.account_manager_id)
        )
          await setAmFromNow(
            c,
            r.existingId,
            after.account_manager_id == null ? null : Number(after.account_manager_id),
            `Imported from ${plan.sourceSystem}`,
            userId,
          );
        if (r.externalId) refs.push({ entity: e, ext: r.externalId, id: r.existingId });
        continue;
      }
      if (r.action === "skip" && r.existingId != null && r.externalId)
        refs.push({ entity: e, ext: r.externalId, id: r.existingId });
      if (r.action !== "create") continue;
      let id: number;
      const v = r.values;
      switch (e) {
        case "users":
          id = await insert("users", {
            ...v,
            password_hash: hashPassword(randomBytes(18).toString("base64")),
            password_changed_at: new Date().toISOString(),
            must_change_password: true,
            updated_by_id: userId,
          });
          break;
        case "enterprises": {
          id = await insert("enterprises", { ...v, created_by_id: userId, updated_by_id: userId });
          const am = resolve(v.account_manager_id ?? null);
          if (am != null) await setAmFromNow(c, id, Number(am), `Imported from ${plan.sourceSystem}`, userId);
          const sides = v.type === "reciprocal" ? ["customer", "vendor"] : [String(v.type)];
          for (const side of sides)
            await c.query(
              `INSERT INTO enterprise_billing (enterprise_id, side, currency, billing_cycle_id, billing_type, updated_by_id)
               VALUES ($1, $2, $3, 1, 'postpaid', $4)`,
              [id, side, r.extra.currency, userId],
            );
          for (const [type, emails] of Object.entries(r.extra.contacts as Record<string, string[]>))
            if (emails.length)
              await c.query(
                "INSERT INTO enterprise_contacts (enterprise_id, contact_type, emails) VALUES ($1, $2, $3)",
                [id, type, emails],
              );
          break;
        }
        case "customer_trunks":
        case "vendor_trunks":
          id = await insert(table, {
            ...v,
            status: plan.trunksInactive ? "inactive" : "active",
            created_by_id: userId,
            updated_by_id: userId,
          });
          break;
        case "rate_tables": {
          id = await insert("rate_tables", {
            ...v,
            description: `Imported from ${plan.sourceSystem}`,
            created_by_id: userId,
            updated_by_id: userId,
          });
          for (const t of r.extra.customerTrunks as Value[]) {
            const trunk = resolve(t) as number;
            await c.query(
              `INSERT INTO customer_trunk_rate_tables (customer_trunk_id, rate_table_id, position)
               SELECT $1, $2, coalesce(max(position), 0) + 1 FROM customer_trunk_rate_tables WHERE customer_trunk_id = $1
               ON CONFLICT DO NOTHING`,
              [trunk, id],
            );
          }
          break;
        }
        case "route_rules": {
          const vendors = r.extra.vendors as { trunk: Value; share: number | null }[];
          id = await insert("route_rules", {
            ...v,
            starts_at: new Date().toISOString(),
            stops_at: new Date(Date.now() + 10 * 365 * 86_400_000).toISOString(),
            route_type: vendors.length ? "static" : "block",
            hunt_policy: r.extra.percentage ? "percentage" : "top_down",
            max_route_level: Math.min(10, Math.max(1, vendors.length)),
            comment: `Imported from ${plan.sourceSystem}`,
            created_by_id: userId,
            updated_by_id: userId,
          });
          let level = 0;
          for (const vd of vendors)
            await c.query(
              `INSERT INTO route_rule_vendors (route_rule_id, level, vendor_trunk_id, share_pct)
               VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
              [id, r.extra.percentage ? 1 : Math.min(10, ++level), resolve(vd.trunk), vd.share],
            );
          break;
        }
        case "departments":
        case "product_categories":
          id = await insert(table, { ...v, updated_by_id: userId });
          break;
        case "translation_rules": {
          // The rule form's own write (targets included), with lists of this import by name.
          const input = translationInput(r.extra, (l) => (l ? (listIds.get(lower(l.name)) ?? l.id) : null));
          input.targets = (r.extra.targets as { type: string; trunkKind: string; id: Value }[]).map((t) => ({
            type: t.type,
            trunkKind: t.trunkKind,
            id: t.id === null ? null : (resolve(t.id) as number),
          })) as TranslationRuleInput["targets"];
          id = await insertRule(c, normalise(input), userId);
          break;
        }
        case "hlr_rules": {
          id = await insert("hlr_rules", { ...v, insert_at: "bottom", updated_by_id: userId });
          for (const t of r.extra.targets as { type: string; id: Value }[])
            await c.query(
              `INSERT INTO hlr_rule_targets (hlr_rule_id, target_type, target_id, insert_at, created_by_id)
               VALUES ($1, $2, $3, 'bottom', $4) ON CONFLICT DO NOTHING`,
              [id, t.type, t.id === null ? null : resolve(t.id), userId],
            );
          break;
        }
        case "opening_balances": {
          const ent = resolve(v.enterprise_id) as number;
          const amount = Number(v.amount);
          const { rows: fx } = await c.query(
            `SELECT bc.base_currency,
                    rate_per_eur_at(bc.base_currency, $3::date::timestamptz) / rate_per_eur_at($2, $3::date::timestamptz) AS rate
               FROM enterprises e JOIN business_companies bc ON bc.id = e.business_company_id WHERE e.id = $1`,
            [ent, v.currency, v.date],
          );
          const ex = Number(Number(fx[0]?.rate ?? 1).toFixed(8));
          id = await insert("transactions", {
            enterprise_id: ent,
            side: v.side,
            payment_mode: "bank_transfer",
            // Positive = the partner's credit (§7), negative = what the partner owes.
            payment_type: amount >= 0 ? "credit" : "debit",
            transaction_type: "adjustment",
            amount: Math.abs(amount),
            currency: v.currency,
            amount_base: Math.round(Math.abs(amount) * ex * 100) / 100,
            base_currency: fx[0] ? String(fx[0].base_currency).trim() : null,
            ex_rate: ex,
            payment_date: v.date,
            description: `Opening balance from ${plan.sourceSystem}`,
            created_by_id: userId,
            updated_by_id: userId,
          });
          break;
        }
        default:
          continue;
      }
      out[i] = id;
      entries.push({
        table,
        entity_id: id,
        field: "*",
        before: null,
        after: `${ENTITY.get(e)!.label}: ${label(v) ?? `#${id}`}`,
      });
      if (r.externalId) refs.push({ entity: e, ext: r.externalId, id });
    }
  }
  for (const ref of refs)
    await c.query(
      `INSERT INTO migration_refs (source_system, entity, external_id, record_id, import_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_system, entity, external_id) DO UPDATE SET record_id = EXCLUDED.record_id, import_id = EXCLUDED.import_id`,
      [plan.sourceSystem, ref.entity, ref.ext, ref.id, importId],
    );
  return { entries };
}

/** Tables a migration change may write (undo checks against it). */
export const MIGRATION_TABLES = new Set([
  "departments",
  "product_categories",
  "number_lists",
  "number_list_entries",
  "translation_rules",
  "hlr_rules",
  "users",
  "enterprises",
  "customer_trunks",
  "vendor_trunks",
  "rate_tables",
  "route_rules",
  "transactions",
]);
