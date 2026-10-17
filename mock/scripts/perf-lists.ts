// Readiness check (build step 6, CLAUDE.md rule 4): times every list endpoint of the contract at the
// seeded volume, the way a grid uses it: first page with total, next page (scroll), quick search and a
// sort on the second column. Run with the full profile loaded:
//   node --env-file=../.env --import tsx scripts/perf-lists.ts [budget-ms]
// Path parameters are filled with the lowest live ID of the record they name.
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db } from "../src/db.js";

const BUDGET = Number(process.argv[2] ?? 1000);
const app = await buildServer({ socket: false });

/** A live ID for each path parameter (by the path segment before it). */
async function idFor(segment: string): Promise<number | null> {
  const table = segment.replaceAll("-", "_");
  try {
    const { rows } = await db().query(`SELECT min(id) AS id FROM ${table}`);
    return rows[0]?.id == null ? null : Number(rows[0].id);
  } catch {
    return null;
  }
}

/** Lists that must be scoped to one parent: the field and the busiest parent (worst case). */
const SCOPES: Record<string, { field: string; sql: string }> = {
  queryRateLines: {
    field: "rateTableId",
    sql: "SELECT rate_table_id AS v FROM rate_lines GROUP BY 1 ORDER BY count(*) DESC LIMIT 1",
  },
  queryRateNotificationLines: {
    field: "rnId",
    sql: "SELECT rn_id AS v FROM rate_notification_lines GROUP BY 1 ORDER BY count(*) DESC LIMIT 1",
  },
  queryDialCodes: {
    field: "profileId",
    sql: "SELECT dp.id AS v FROM dial_codes d JOIN dial_code_profiles dp ON dp.name = d.profile GROUP BY 1 ORDER BY count(*) DESC LIMIT 1",
  },
  queryRouteMap: {
    field: "customerTrunkId",
    sql: "SELECT id AS v FROM customer_trunks WHERE deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1",
  },
  queryQbrStats: { field: "side", sql: "SELECT 'customer' AS v" },
  queryNumberListEntries: {
    field: "numberListId",
    sql: "SELECT number_list_id AS v FROM number_list_entries GROUP BY 1 ORDER BY count(*) DESC LIMIT 1",
  },
  queryHlrProviderRates: {
    field: "providerId",
    sql: "SELECT hlr_provider_id AS v FROM hlr_provider_rates GROUP BY 1 ORDER BY count(*) DESC LIMIT 1",
  },
  queryTeamTimeline: {
    field: "userId",
    sql: "SELECT user_id AS v FROM audit_log GROUP BY 1 ORDER BY count(*) DESC LIMIT 1",
  },
};
/** Report lists take report parameters; they are timed by their own tests. */
const SKIP = new Set(["queryBillingReport", "queryEnterpriseReport"]);

interface Result {
  op: string;
  status: number;
  first: number;
  next: number | null;
  search: number | null;
  sort: number | null;
  rows: number;
  total: number | null;
  note: string;
}
const timed = async (url: string, payload: object) => {
  const t = performance.now();
  const r = await app.inject({ method: "POST", url, payload });
  return { ms: Math.round(performance.now() - t), r };
};

const results: Result[] = [];
for (const op of operations.filter((o) => o.method === "POST" && o.path.endsWith("/query"))) {
  let path = op.path;
  let missing = "";
  for (const m of path.matchAll(/\/([a-z-]+)\/\{(\w+)\}/g)) {
    const id = await idFor(m[1]!);
    if (id == null) missing = m[1]!;
    else path = path.replace(`{${m[2]}}`, String(id));
  }
  if (missing) {
    results.push({
      op: op.operationId,
      status: 0,
      first: 0,
      next: null,
      search: null,
      sort: null,
      rows: 0,
      total: null,
      note: `no ${missing} id`,
    });
    continue;
  }
  if (SKIP.has(op.operationId)) continue;
  const url = `${API_PREFIX}${path}`;
  const scope = SCOPES[op.operationId];
  let filter: object | undefined;
  if (scope) {
    const { rows } = await db()
      .query(scope.sql)
      .catch(() => ({ rows: [] as { v: unknown }[] }));
    if (rows[0]) filter = { logic: "and", conditions: [{ field: scope.field, op: "eq", value: rows[0].v }] };
  }
  const base = { limit: 100, withTotal: true, ...(filter ? { filter } : {}) };
  // Warm caches and connections once, like a page that was opened before.
  await app.inject({ method: "POST", url, payload: { ...base, limit: 1, withTotal: false } });
  const first = await timed(url, base);
  const res: Result = {
    op: op.operationId,
    status: first.r.statusCode,
    first: first.ms,
    next: null,
    search: null,
    sort: null,
    rows: 0,
    total: null,
    note: "",
  };
  if (first.r.statusCode !== 200) {
    const p = first.r.json();
    res.note =
      `${p.title ?? ""} ${(p.errors ?? []).map((e: { path: string; message: string }) => `${e.path} ${e.message}`).join("; ")}`.slice(
        0,
        110,
      );
    results.push(res);
    continue;
  }
  const page = first.r.json();
  res.rows = page.rows.length;
  res.total = page.total ?? null;
  if (page.nextCursor) res.next = (await timed(url, { ...base, withTotal: false, cursor: page.nextCursor })).ms;
  const s = await timed(url, { ...base, search: "ab" });
  res.search = s.r.statusCode === 200 ? s.ms : -s.r.statusCode;
  const fields = await app.inject({ method: "GET", url: `${API_PREFIX}/meta/lists/${listOf(op.path)}/fields` });
  const sortable =
    fields.statusCode === 200
      ? (fields.json().fields ?? []).filter((f: { sortable?: boolean }) => f.sortable !== false)
      : [];
  // Every sortable column, worst one reported (a user can click any header).
  for (const f of sortable as { field: string }[]) {
    const so = await timed(url, { ...base, withTotal: false, sort: [{ field: f.field, dir: "desc" }] });
    const ms = so.r.statusCode === 200 ? so.ms : -so.r.statusCode;
    if (res.sort == null || ms > res.sort || ms < 0) {
      res.sort = ms;
      res.note = `worst sort: ${f.field}${ms < 0 ? ` (${so.r.statusCode})` : ""}`;
    }
  }
  results.push(res);
}

function listOf(path: string) {
  return path
    .split("/")
    .filter((p) => p && !p.startsWith("{") && p !== "query")
    .pop()!
    .replaceAll("-", "_");
}

results.sort(
  (a, b) =>
    Math.max(b.first, b.next ?? 0, b.search ?? 0, b.sort ?? 0) -
    Math.max(a.first, a.next ?? 0, a.search ?? 0, a.sort ?? 0),
);
const pad = (v: unknown, n: number) => String(v ?? "—").padStart(n);
console.log(`${"operation".padEnd(34)} status  first   next search   sort   total  note`);
for (const r of results) {
  const worst = Math.max(r.first, r.next ?? 0, r.search ?? 0, r.sort ?? 0);
  console.log(
    `${(worst > BUDGET ? "! " : "  ") + r.op.padEnd(32)} ${pad(r.status, 6)} ${pad(r.first, 6)} ${pad(r.next, 6)} ${pad(r.search, 6)} ${pad(r.sort, 6)} ${pad(r.total, 7)}  ${r.note}`,
  );
}
const slow = results.filter((r) => Math.max(r.first, r.next ?? 0, r.search ?? 0, r.sort ?? 0) > BUDGET);
const failed = results.filter((r) => r.status !== 200);
console.log(
  `\n${results.length} list endpoints · ${slow.length} over ${BUDGET} ms · ${failed.length} not answering 200`,
);
await app.close();
await closeDb();
