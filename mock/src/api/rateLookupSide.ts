// Rate Lookup side by side (team trial round 1, §13.16): customer and vendor rate tables each on their
// own side with their own check-list filters (product category, trunk, country, MCCMNC). A side lists
// the destination codes its tables price now, with the number of tables and the rate range; a row opens
// into the tables pricing it. Everything is filtered, sorted and paged here (CLAUDE.md rule 3).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  LookupSide,
  LookupSideFilters,
  LookupSideLines,
  LookupSideLinesRequest,
  LookupSideOptions,
  LookupSidePage,
  LookupSideRequest,
  LookupSideRow,
} from "@sms/contract";
import { PLATFORM_CURRENCY, toPlatformSql } from "../currency.js";
import { withDb } from "../db.js";

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** `%` and `_` wildcards (§13.25); plain text matches anywhere. */
export function searchPattern(q: string): string {
  const t = q.trim();
  return /[%_]/.test(t) ? t : `%${t}%`;
}

/**
 * The rate tables of a side after its filters (live trunks only; a customer table counts when a live
 * trunk uses it, §5.4), and the conditions on its lines valid at $1 (blocked and sender-ID lines left
 * out). Picking the tables first keeps the scan of 1.4 million lines fast. Values from $2 on are pushed.
 */
function sideSql(f: LookupSideFilters, values: unknown[]): { tables: string; lineWhere: string } {
  const add = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const status = f.includeInactive ? "" : "AND t.status = 'active'";
  const trunkIds = f.trunkIds?.length ? ` AND t.id = ANY(${add(f.trunkIds)}::bigint[])` : "";
  const trunk =
    f.side === "vendor"
      ? `EXISTS (SELECT 1 FROM vendor_trunks t WHERE t.id = rt.vendor_trunk_id AND t.deleted_at IS NULL ${status}${trunkIds})`
      : `EXISTS (SELECT 1 FROM customer_trunk_rate_tables ctr JOIN customer_trunks t ON t.id = ctr.customer_trunk_id
                  WHERE ctr.rate_table_id = rt.id AND t.deleted_at IS NULL ${status}${trunkIds})`;
  const category = f.categoryIds?.length ? `AND rt.product_category_id = ANY(${add(f.categoryIds)}::bigint[])` : "";
  const tables = `SELECT rt.id FROM rate_tables rt
                   WHERE rt.kind = '${f.side === "vendor" ? "vendor" : "customer"}' AND rt.deleted_at IS NULL
                     ${category} AND ${trunk}`;
  let lineWhere = `l.valid_from <= $1 AND (l.valid_to IS NULL OR l.valid_to > $1) AND NOT l.is_blocked AND l.sender_id IS NULL`;
  if (f.mccmncs?.length) lineWhere += ` AND l.mccmnc = ANY(${add(f.mccmncs)}::text[])`;
  else if (f.mccs?.length) lineWhere += ` AND substring(l.mccmnc, 1, 3) = ANY(${add(f.mccs)}::text[])`;
  return { tables, lineWhere };
}

/** Per destination: tables, rate range in the table currency (when shared) and in the platform currency. */
function groupedSql(f: LookupSideFilters, values: unknown[]): string {
  const { tables, lineWhere } = sideSql(f, values);
  return `t AS (${tables}),
     g1 AS (SELECT l.mccmnc, l.currency, count(*)::int AS n, min(l.rate) AS mn, max(l.rate) AS mx
              FROM rate_lines l JOIN t ON t.id = l.rate_table_id
             WHERE ${lineWhere} GROUP BY 1, 2),
     g AS (SELECT g1.mccmnc, sum(g1.n)::int AS tables, min(g1.mn) AS min_rate, max(g1.mx) AS max_rate,
                  count(*)::int AS currencies, min(trim(g1.currency)) AS currency,
                  min(${toPlatformSql("g1.mn")}) AS min_conv, max(${toPlatformSql("g1.mx")}) AS max_conv
             FROM g1 JOIN currency_latest cl ON cl.iso = g1.currency GROUP BY 1)`;
}

const SORT: Record<NonNullable<LookupSideRequest["sort"]>, string> = {
  destination: "co.name {dir}, g.mccmnc {dir}",
  tables: "g.tables {dir}, co.name, g.mccmnc",
  minSys: "g.min_conv {dir}, co.name, g.mccmnc",
  maxSys: "g.max_conv {dir}, co.name, g.mccmnc",
};

export async function sidePage(pool: pg.Pool, input: LookupSideRequest): Promise<LookupSidePage> {
  const limit = input.limit ?? 100;
  const offset = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;
  const values: unknown[] = [input.asOf ? new Date(input.asOf) : new Date()];
  const grouped = groupedSql(input, values);
  let search = "";
  if (input.search?.trim()) {
    values.push(searchPattern(input.search));
    const p = `$${values.length}`;
    search = `WHERE co.name ILIKE ${p} OR m.network ILIKE ${p} OR g.mccmnc ILIKE ${p} OR co.iso ILIKE ${p}`;
  }
  const dir = input.dir === "desc" ? "DESC" : "ASC";
  const order = SORT[input.sort ?? "destination"].replaceAll("{dir}", dir);
  const { rows } = await pool.query(
    `WITH ${grouped}
     SELECT g.*, m.mcc, m.network, m.is_all_networks, co.name AS country, co.iso, count(*) OVER () AS total
       FROM g JOIN mccmnc m ON m.mccmnc = g.mccmnc AND m.deleted_at IS NULL
       JOIN countries co ON co.id = m.country_id
       ${search}
      ORDER BY ${order}
      LIMIT ${limit} OFFSET ${offset}`,
    values,
  );
  const total = rows.length ? Number(rows[0].total) : 0;
  return {
    rows: rows.map((r): LookupSideRow => {
      const one = r.currencies === 1;
      return {
        mccmnc: r.mccmnc,
        mcc: String(r.mcc).trim(),
        country: r.country,
        countryIso: String(r.iso).trim(),
        network: r.network,
        allNetworks: r.is_all_networks,
        tables: r.tables,
        minRate: one ? Number(r.min_rate) : null,
        maxRate: one ? Number(r.max_rate) : null,
        currency: one ? r.currency : null,
        minSys: round6(Number(r.min_conv)),
        maxSys: round6(Number(r.max_conv)),
      };
    }),
    total,
    nextCursor: offset + rows.length < total ? String(offset + rows.length) : null,
    platformCurrency: PLATFORM_CURRENCY,
  };
}

export async function sideLinesFor(pool: pg.Pool, input: LookupSideLinesRequest): Promise<LookupSideLines> {
  const values: unknown[] = [input.asOf ? new Date(input.asOf) : new Date(), input.mccmnc];
  const { tables, lineWhere } = sideSql({ ...input, mccmncs: undefined, mccs: undefined }, values);
  const status = input.includeInactive ? "" : "AND t.status = 'active'";
  const trunks =
    input.side === "vendor"
      ? `SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'enterpriseName', e.name))
           FROM vendor_trunks t JOIN enterprises e ON e.id = t.enterprise_id WHERE t.id = rt.vendor_trunk_id`
      : `SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'enterpriseName', e.name) ORDER BY t.name)
           FROM customer_trunk_rate_tables ctr JOIN customer_trunks t ON t.id = ctr.customer_trunk_id
           JOIN enterprises e ON e.id = t.enterprise_id
          WHERE ctr.rate_table_id = rt.id AND t.deleted_at IS NULL ${status}`;
  const { rows } = await pool.query(
    `WITH t AS (${tables}),
          x AS (SELECT l.mccmnc, l.rate_table_id AS table_id, l.rate, trim(l.currency) AS currency, l.valid_from,
                       ${toPlatformSql("l.rate")} AS conv
                  FROM rate_lines l JOIN t ON t.id = l.rate_table_id JOIN currency_latest cl ON cl.iso = l.currency
                 WHERE l.mccmnc = $2 AND ${lineWhere})
     SELECT x.*, rt.name AS table_name, pc.name AS category, (${trunks}) AS trunks, nx.rate AS next_rate, nx.valid_from AS next_from
       FROM x JOIN rate_tables rt ON rt.id = x.table_id
       LEFT JOIN product_categories pc ON pc.id = rt.product_category_id
       LEFT JOIN LATERAL (
         SELECT n.rate, n.valid_from FROM rate_lines n
          WHERE n.rate_table_id = x.table_id AND n.mccmnc = x.mccmnc AND n.sender_id IS NULL
            AND n.valid_from > $1 AND NOT n.is_blocked
          ORDER BY n.valid_from LIMIT 1) nx ON true
      ORDER BY x.conv, rt.name
      LIMIT 2000`,
    values,
  );
  return {
    mccmnc: input.mccmnc,
    lines: rows.map((r) => ({
      rateTableId: Number(r.table_id),
      rateTableName: r.table_name,
      category: r.category ?? null,
      trunks: ((r.trunks ?? []) as { id: number; name: string; enterpriseName: string }[]).map((t) => ({
        ...t,
        id: Number(t.id),
      })),
      rate: Number(r.rate),
      currency: r.currency,
      sysRate: round6(Number(r.conv)),
      effectiveFrom: (r.valid_from as Date).toISOString(),
      nextRate: r.next_rate === null ? null : Number(r.next_rate),
      nextFrom: r.next_from ? (r.next_from as Date).toISOString() : null,
    })),
    platformCurrency: PLATFORM_CURRENCY,
  };
}

const OPTIONS_TTL_MS = 60_000;
const optionsCache = new Map<LookupSide, { at: number; value: LookupSideOptions }>();

export async function sideOptions(pool: pg.Pool, side: LookupSide): Promise<LookupSideOptions> {
  const hit = optionsCache.get(side);
  if (hit && Date.now() - hit.at < OPTIONS_TTL_MS) return hit.value;
  const values: unknown[] = [new Date()];
  const { tables, lineWhere } = sideSql({ side, includeInactive: true }, values);
  const trunkTable = side === "vendor" ? "vendor_trunks" : "customer_trunks";
  const [cats, trunks, codes] = await Promise.all([
    pool.query("SELECT id, name FROM product_categories WHERE deleted_at IS NULL ORDER BY name"),
    pool.query(
      `SELECT t.id, t.name, e.name AS enterprise_name, t.status = 'active' AS active
         FROM ${trunkTable} t JOIN enterprises e ON e.id = t.enterprise_id
        WHERE t.deleted_at IS NULL ORDER BY t.name`,
    ),
    pool.query(
      `WITH t AS (${tables}),
            x AS (SELECT l.mccmnc, l.rate_table_id AS table_id FROM rate_lines l JOIN t ON t.id = l.rate_table_id
                   WHERE ${lineWhere}),
            g AS (SELECT mccmnc, count(*)::int AS tables FROM x GROUP BY mccmnc),
            c AS (SELECT substring(mccmnc, 1, 3) AS mcc, count(DISTINCT table_id)::int AS tables FROM x GROUP BY 1)
       SELECT m.mccmnc, trim(m.mcc) AS mcc, m.network, m.is_all_networks, co.name AS country, co.iso,
              coalesce(g.tables, 0) AS tables, coalesce(c.tables, 0) AS country_tables
         FROM mccmnc m JOIN countries co ON co.id = m.country_id
         LEFT JOIN g ON g.mccmnc = m.mccmnc
         LEFT JOIN c ON c.mcc = trim(m.mcc)
        WHERE m.deleted_at IS NULL
        ORDER BY co.name, m.is_all_networks DESC, m.mccmnc`,
      values,
    ),
  ]);
  const countries = new Map<string, LookupSideOptions["countries"][number]>();
  for (const r of codes.rows)
    if (!countries.has(r.mcc))
      countries.set(r.mcc, { mcc: r.mcc, name: r.country, iso: String(r.iso).trim(), tables: r.country_tables });
  const value: LookupSideOptions = {
    side,
    categories: cats.rows.map((r) => ({ id: Number(r.id), name: r.name })),
    trunks: trunks.rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      enterpriseName: r.enterprise_name,
      active: r.active,
    })),
    countries: [...countries.values()],
    codes: codes.rows.map((r) => ({
      mccmnc: r.mccmnc,
      mcc: r.mcc,
      network: r.network,
      allNetworks: r.is_all_networks,
      tables: r.tables,
    })),
  };
  optionsCache.set(side, { at: Date.now(), value });
  return value;
}

export function rateLookupSideOptions(request: FastifyRequest, reply: FastifyReply) {
  const { side } = request.query as { side: LookupSide };
  return withDb(reply, (pool) => sideOptions(pool, side));
}

export function rateLookupSide(request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, (pool) => sidePage(pool, request.body as LookupSideRequest));
}

export function rateLookupSideLines(request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, (pool) => sideLinesFor(pool, request.body as LookupSideLinesRequest));
}
