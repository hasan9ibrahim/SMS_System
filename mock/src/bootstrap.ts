/**
 * Go-live bootstrap (backend step 14): fills an empty production database with the reference data every screen needs
 * and creates the first administrator. Nothing here is fake: currencies, billing cycles and product categories are the
 * spec's lists (§5.5, §7), countries, MCC/MNC and the country dial codes come from the real MCC/MNC list
 * (data/mccmnc.csv, §6.1), departments and access groups are the starting set an administrator then edits (§11).
 *
 *   node bootstrap.mjs --admin-username jdoe --admin-email jdoe@example.org --admin-first-name J --admin-last-name Doe
 *                      [--summary-emails rates@example.org,noc@example.org] [--admin-without-code]
 *
 * Run once after the first deploy (docs/GO_LIVE.md). Safe to run again: a table that already has rows is left as it is,
 * and the administrator is only created while there is none. The schema must exist (the deploy's migrations).
 * Connection settings: POSTGRES_* as for the service (/etc/sms/service.env).
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import pg from "pg";
import { PG_CONFIG, PG_SCHEMA } from "./db.js";
import { hashPassword } from "./admin/passwords.js";
import { BILLING_CYCLES, CATEGORIES, CURRENCIES, loadMccmncCsv, regionOf } from "./generator/reference.js";
import { ACCESS_GROUPS, DEPARTMENTS } from "./generator/admin.js";

export interface BootstrapOptions {
  /** withoutCode: no e-mailed sign-in code (only while platform e-mail is not set up, e.g. the lab; §13.28). */
  admin?: { username: string; email: string; firstName: string; lastName: string; withoutCode?: boolean };
  /** The weekly Cleanup Center summary (§13.19); the migration's placeholder addresses are removed when not given. */
  summaryEmails?: string[];
  log?: (line: string) => void;
}

export interface BootstrapResult {
  filled: string[];
  /** The administrator's temporary password, shown once (it must be changed at first sign-in). */
  adminPassword: string | null;
}

/** A temporary password that meets the password rules (upper, lower, digit, symbol, length). */
export function temporaryPassword(): string {
  const body = randomBytes(12).toString("base64url").replace(/[-_]/g, "x");
  return `${body}#7Aa`;
}

export async function bootstrap(c: pg.ClientBase, opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const log = opts.log ?? (() => {});
  const { rows: schema } = await c.query(`SELECT to_regclass('${PG_SCHEMA}.users') AS t`);
  if (!schema[0]?.t) throw new Error(`schema ${PG_SCHEMA} not found: run the deploy (migrations) first`);
  await c.query(`SET search_path = ${PG_SCHEMA}, public`);
  const filled: string[] = [];
  const empty = async (table: string) => {
    const { rows } = await c.query(`SELECT NOT EXISTS (SELECT 1 FROM ${table}) AS e`);
    if (!rows[0].e) log(`${table}: has rows, left as it is`);
    return rows[0].e as boolean;
  };
  const fill = async (table: string, run: () => Promise<number>) => {
    if (!(await empty(table))) return;
    const n = await run();
    filled.push(table);
    log(`${table}: ${n} rows`);
  };

  await c.query("BEGIN");
  try {
    await fill("currencies", async () => {
      for (const x of CURRENCIES)
        await c.query("INSERT INTO currencies (iso, name, symbol) VALUES ($1, $2, $3)", [x.iso, x.name, x.symbol]);
      return CURRENCIES.length;
    });
    // Starting exchange rates per EUR (§7), so conversions are not 1:1 before the FX provider's first fetch.
    await fill("currency_rates", async () => {
      const eur = CURRENCIES.find((x) => x.iso === "EUR")!.perUsd;
      const others = CURRENCIES.filter((x) => x.iso !== "EUR");
      for (const x of others)
        await c.query("INSERT INTO currency_rates (iso, rate_per_eur, valid_from) VALUES ($1, $2, now())", [
          x.iso,
          Number((x.perUsd / eur).toFixed(8)),
        ]);
      return others.length;
    });
    await fill("billing_cycles", async () => {
      for (const b of BILLING_CYCLES)
        await c.query(
          `INSERT INTO billing_cycles (name, billing_type, week_day, usage_days, due_days) VALUES ($1, $2, $3, $4, $5)`,
          [b.name, b.billing_type, b.week_day, b.usage_days, b.due_days],
        );
      return BILLING_CYCLES.length;
    });
    await fill("product_categories", async () => {
      for (const x of CATEGORIES) await c.query("INSERT INTO product_categories (name) VALUES ($1)", [x.name]);
      return CATEGORIES.length;
    });
    await fill("countries", () => masterData(c));
    await fill("departments", async () => {
      for (const name of DEPARTMENTS)
        await c.query("INSERT INTO departments (name, description) VALUES ($1, $2)", [name, `${name} department`]);
      return DEPARTMENTS.length;
    });
    await fill("access_groups", async () => {
      for (const g of ACCESS_GROUPS)
        await c.query("INSERT INTO access_groups (name, permissions, description) VALUES ($1, $2, $3)", [
          g.name,
          JSON.stringify(g.permissions),
          g.description,
        ]);
      return ACCESS_GROUPS.length;
    });

    // The user the background jobs act as (jobs/system.ts): it cannot sign in (no usable password, inactive).
    const { rowCount: system } = await c.query(
      `INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, status, otp_method)
       VALUES ('system', 'System', 'Jobs', 'system@localhost', '!', now(), 'inactive', 'off')
       ON CONFLICT (username) DO NOTHING`,
    );
    if (system) filled.push("system user");

    let adminPassword: string | null = null;
    const { rows: admins } = await c.query("SELECT 1 FROM users WHERE is_admin AND username <> 'system' LIMIT 1");
    if (admins.length) log("administrator: one exists, none created");
    else if (opts.admin) {
      const a = opts.admin;
      adminPassword = temporaryPassword();
      const hash = hashPassword(adminPassword);
      const { rows: group } = await c.query("SELECT id FROM access_groups WHERE name = 'Administrator'");
      const { rows: dept } = await c.query("SELECT id FROM departments WHERE name = 'Admin'");
      const { rows: u } = await c.query(
        `INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, is_admin,
                            must_change_password, temp_password_expires_at, otp_method, access_group_id, department_id)
         VALUES ($1, $2, $3, $4, $5, now(), true, true, now() + interval '24 hours', $8, $6, $7) RETURNING id`,
        [
          a.username,
          a.firstName,
          a.lastName,
          a.email,
          hash,
          group[0]?.id ?? null,
          dept[0]?.id ?? null,
          a.withoutCode ? "off" : "email",
        ],
      );
      await c.query("INSERT INTO password_history (user_id, password_hash, changed_at) VALUES ($1, $2, now())", [
        u[0].id,
        hash,
      ]);
      filled.push("administrator");
      log(`administrator: ${a.username} created`);
    } else log("administrator: none yet; run again with --admin-username and the other --admin-* options");

    const placeholder = "{rates@example.com,noc@example.com}";
    // First run only (the migration's placeholder addresses are still there): Cleanup Center changes wait for an
    // approval in production (product owner 2026-10-26).
    await c.query(
      `UPDATE cleanup_settings SET require_approval = true WHERE id = 1 AND summary_emails = '${placeholder}'::text[]`,
    );
    const { rowCount: cleanup } = await c.query(
      `UPDATE cleanup_settings SET summary_emails = $1
        WHERE id = 1 AND ($2::boolean OR summary_emails = '${placeholder}'::text[])`,
      [opts.summaryEmails ?? [], opts.summaryEmails !== undefined],
    );
    if (cleanup) filled.push("cleanup summary e-mails");

    await c.query("COMMIT");
    return { filled, adminPassword };
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  }
}

/**
 * Countries, the MCC/MNC master with one "All networks" code per MCC, and the dial-code Master Table (profile "All"):
 * each country's dial code points at its All networks code. Network prefixes are added by the team (or an import),
 * as there is no reliable public list of them. Same rules as the generator (generator/reference.ts) without the
 * fake values: destination DLR targets are left empty.
 */
async function masterData(c: pg.ClientBase): Promise<number> {
  const raw = loadMccmncCsv();
  const countryId = new Map<string, number>();
  const countries: { id: number; iso: string; dial: string; mccs: string[] }[] = [];
  const nets = new Map<string, number>(); // `${mcc}:${countryId}` → networks on it
  for (const r of raw) {
    let id = countryId.get(r.country);
    if (id === undefined) {
      const { rows } = await c.query(
        "INSERT INTO countries (name, iso, dial_code, region) VALUES ($1, $2, $3, $4) RETURNING id",
        [r.country, r.iso, r.dial, regionOf(r.iso, r.mcc)],
      );
      id = Number(rows[0].id);
      countryId.set(r.country, id);
      countries.push({ id, iso: r.iso, dial: r.dial, mccs: [] });
    }
    const country = countries.find((x) => x.id === id)!;
    if (!country.mccs.includes(r.mcc)) country.mccs.push(r.mcc);
    nets.set(`${r.mcc}:${id}`, (nets.get(`${r.mcc}:${id}`) ?? 0) + 1);
    await c.query(
      `INSERT INTO mccmnc (mcc, mnc, mccmnc, country_id, network, is_all_networks) VALUES ($1, $2, $3, $4, $5, false)`,
      [r.mcc, r.mnc, r.code, id, r.network],
    );
  }
  // A shared MCC (e.g. 310 for the US and Guam) belongs to the country with most networks on it.
  const owner = new Map<string, { id: number; n: number }>();
  for (const [key, n] of nets) {
    const [mcc = "", id = ""] = key.split(":");
    const cur = owner.get(mcc);
    if (!cur || n > cur.n) owner.set(mcc, { id: Number(id), n });
  }
  const usedDial = new Set<string>();
  for (const country of countries) {
    let first: number | null = null;
    for (const mcc of country.mccs) {
      if (owner.get(mcc)?.id !== country.id) continue;
      const { rows } = await c.query(
        `INSERT INTO mccmnc (mcc, mnc, mccmnc, country_id, network, is_all_networks)
         VALUES ($1::text, '', $1::text, $2, 'All networks', true) RETURNING id`,
        [mcc, country.id],
      );
      first ??= Number(rows[0].id);
    }
    if (first !== null && country.dial && !usedDial.has(country.dial)) {
      usedDial.add(country.dial);
      await c.query("INSERT INTO dial_codes (profile, prefix, mccmnc_id) VALUES ('All', $1, $2)", [country.dial, first]);
    }
  }
  return countries.length;
}

// ---------------------------------------------------------------- command line

async function main() {
  const { values: a } = parseArgs({
    options: {
      "admin-username": { type: "string" },
      "admin-email": { type: "string" },
      "admin-first-name": { type: "string" },
      "admin-last-name": { type: "string" },
      "summary-emails": { type: "string" },
      "admin-without-code": { type: "boolean", default: false },
    },
  });
  const adminArgs = [a["admin-username"], a["admin-email"], a["admin-first-name"], a["admin-last-name"]];
  if (adminArgs.some(Boolean) && !adminArgs.every(Boolean))
    throw new Error("give all of --admin-username, --admin-email, --admin-first-name and --admin-last-name");
  const client = new pg.Client(PG_CONFIG);
  await client.connect();
  try {
    const result = await bootstrap(client, {
      admin: adminArgs.every(Boolean)
        ? {
            username: a["admin-username"]!.trim(),
            email: a["admin-email"]!.trim(),
            firstName: a["admin-first-name"]!.trim(),
            lastName: a["admin-last-name"]!.trim(),
            withoutCode: a["admin-without-code"],
          }
        : undefined,
      summaryEmails:
        a["summary-emails"] === undefined
          ? undefined
          : a["summary-emails"]
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
      log: (line) => console.log(line),
    });
    console.log(result.filled.length ? `filled: ${result.filled.join(", ")}` : "nothing to do");
    if (result.adminPassword) {
      console.log(`\nTemporary password (valid 24 hours, shown once): ${result.adminPassword}`);
      console.log(
        a["admin-without-code"]
          ? "Sign in, then choose a new password. Turn the sign-in code on (Admin › Users) once e-mail works."
          : "Sign in, enter the code e-mailed to the administrator, then choose a new password.",
      );
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && /bootstrap\.(ts|mjs)$/.test(process.argv[1])) {
  main().catch((err: Error) => {
    console.error(`bootstrap: ${err.message}`);
    process.exit(1);
  });
}
