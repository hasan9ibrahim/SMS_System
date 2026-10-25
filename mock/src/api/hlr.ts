// HLR (§6.5, §13.24): providers (credentials, response mapping, per-destination prices, live
// status and 24-hour stats), rules (provider + DNID pattern, applied straight to customer trunks
// like translation rules, §13.2) and policies (per destination, an ordered provider list or
// "auto", with cache times) that route rules use in their HLR action. Every save is one undoable
// change (§13.10); delete archives and is blocked while something uses the record (§13.29).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  HlrPolicyDetail,
  HlrPolicyEntry,
  HlrPolicyInput,
  HlrPolicyTestInput,
  HlrPolicyTestResult,
  HlrProviderDetail,
  HlrProviderInput,
  HlrProviderRateInput,
  HlrRuleDetail,
  HlrRuleInput,
  HlrTarget,
  HlrTargetInput,
  IdList,
  ImportRequest,
  ListQuery,
  RuleUsedBy,
} from "@sms/contract";
import { db as defaultDb, withDb } from "../db.js";
import { chRows, edrNowSql } from "../edr.js";
import { production } from "../mode.js";
import { hlrLiveStatusSql, hlrProviderRateList, hlrUsedBySql } from "../lists/defs.js";
import { runList } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { compile } from "../routing/translate.js";
import { archiveGate } from "./enterprises.js";
import { ImportRun, csvCell, load, notFound, parseCsv, setArchived } from "./masterData.js";
import { dependencies, iso, recordChange, same, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { mccmncLookup } from "./translationRules.js";
import { inTransaction } from "./views.js";
import { ruleTargetDependencies } from "./ruleTargets.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };

const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });
const conflict = (reply: FastifyReply, detail: string) => sendProblem(reply, 409, detail);

// ---------------------------------------------------------------- stats (§13.24)

const REFRESH_MS = 5 * 60_000;
/**
 * The generated EDRs mark every lookup accomplished and carry no response time, so the mock
 * gives each provider a fixed health profile: success = accomplished share x factor, response =
 * timeout x factor. The backend measures both on the real traffic.
 */
const HEALTH = [
  { success: 0.992, response: 0.18 },
  { success: 0.975, response: 0.3 },
  { success: 0.94, response: 0.25 },
  { success: 0.89, response: 0.86 },
  { success: 0.45, response: 0.4 },
  { success: 0.96, response: 0.22 },
];
/** The fake data's profile; production uses the measured success only (backend step 11). */
const health = (id: number): { success: number; response: number | null } =>
  production ? { success: 1, response: null } : HEALTH[(id - 1) % HEALTH.length]!;

/** Pulls the last 24 hours per provider from the EDR store into hlr_provider_stats. */
export async function refreshHlrStats(pool: Db = defaultDb()): Promise<number | null> {
  const rows = await chRows<{
    p: number;
    n: string;
    live: string;
    cached: string;
    ok: string;
    ported: string;
    cost: number;
  }>(
    `SELECT hlr_provider_id AS p, countIf(hlr_fetch_type != 'none') AS n, countIf(hlr_fetch_type = 'live') AS live,
            countIf(hlr_fetch_type = 'cached') AS cached, countIf(hlr_fetch_type = 'live' AND hlr_is_accomplished = 1) AS ok,
            countIf(hlr_is_ported = 1) AS ported, toFloat64(sum(hlr_cost_sys)) AS cost
       FROM edr
      WHERE submit_time > ${edrNowSql()} - INTERVAL 24 HOUR AND hlr_provider_id > 0
      GROUP BY p`,
    30_000,
  );
  if (!rows) return null;
  const byId = new Map(rows.map((r) => [Number(r.p), r]));
  const { rows: providers } = await pool.query("SELECT id, timeout_ms FROM hlr_providers");
  for (const p of providers) {
    const id = Number(p.id);
    const r = byId.get(id);
    const h = health(id);
    const live = Number(r?.live ?? 0);
    const success = live ? Math.round((Number(r!.ok) / live) * h.success * 1000) / 10 : null;
    await pool.query(
      `INSERT INTO hlr_provider_stats (hlr_provider_id, lookups, live_lookups, cached_lookups, success_pct, avg_response_ms, cost_sys, ported, refreshed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (hlr_provider_id) DO UPDATE SET lookups = $2, live_lookups = $3, cached_lookups = $4, success_pct = $5,
         avg_response_ms = $6, cost_sys = $7, ported = $8, refreshed_at = now()`,
      [
        id,
        Number(r?.n ?? 0),
        live,
        Number(r?.cached ?? 0),
        success,
        // The switch does not record lookup times yet: none in production rather than an invented one.
        live && h.response !== null ? Math.round(Number(p.timeout_ms) * h.response) : null,
        Number(r?.cost ?? 0),
        Number(r?.ported ?? 0),
      ],
    );
  }
  return providers.length;
}

let timer: NodeJS.Timeout | null = null;
export function startHlrRefresh() {
  if (timer) return;
  const run = () => void refreshHlrStats().catch(() => undefined);
  setTimeout(run, 6_000).unref();
  timer = setInterval(run, REFRESH_MS);
  timer.unref();
}

// ---------------------------------------------------------------- providers

const PROVIDER_COLUMNS: [string, string][] = [
  ["name", "name"],
  ["providerType", "provider_type"],
  ["url", "url"],
  ["username", "username"],
  ["extraHeaders", "extra_headers"],
  ["postData", "post_data"],
  ["currency", "currency"],
  ["defaultRate", "default_rate"],
  ["cacheDays", "cache_days"],
  ["timeoutMs", "timeout_ms"],
  ["dailyBudget", "daily_budget"],
  ["status", "status"],
  ["responseMapping", "response_mapping"],
];
type ProviderFields = Omit<HlrProviderInput, "password">;

export async function loadHlrProvider(db: Db, id: number): Promise<HlrProviderDetail | null> {
  const { rows } = await db.query(
    `SELECT hp.*, (hp.password IS NOT NULL AND hp.password <> '') AS password_set, ${hlrLiveStatusSql} AS live_status,
            hs.lookups, hs.live_lookups, hs.cached_lookups, hs.success_pct, hs.avg_response_ms, hs.cost_sys, hs.ported,
            (SELECT count(*)::int FROM hlr_rules x WHERE x.hlr_provider_id = hp.id AND x.deleted_at IS NULL) AS rules,
            (SELECT count(*)::int FROM hlr_policies x WHERE x.deleted_at IS NULL AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(x.entries) e, jsonb_array_elements_text(e -> 'providerIds') pid
                WHERE pid::bigint = hp.id)) AS policies,
            ub.username AS updated_by
       FROM hlr_providers hp LEFT JOIN hlr_provider_stats hs ON hs.hlr_provider_id = hp.id
       LEFT JOIN users ub ON ub.id = hp.updated_by_id WHERE hp.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    name: r.name,
    providerType: r.provider_type,
    url: r.url,
    username: r.username ?? null,
    extraHeaders: r.extra_headers ?? null,
    postData: r.post_data ?? null,
    currency: String(r.currency).trim(),
    defaultRate: Number(r.default_rate),
    cacheDays: Number(r.cache_days),
    timeoutMs: Number(r.timeout_ms),
    dailyBudget: r.daily_budget === null ? null : Number(r.daily_budget),
    status: r.status,
    responseMapping: r.response_mapping,
    passwordSet: r.password_set,
    stats: {
      liveStatus: r.live_status,
      lookups: Number(r.lookups ?? 0),
      liveLookups: Number(r.live_lookups ?? 0),
      cachedLookups: Number(r.cached_lookups ?? 0),
      successPct: r.success_pct === null ? null : Number(r.success_pct),
      avgResponseMs: r.avg_response_ms === null ? null : Number(r.avg_response_ms),
      cost: Number(r.cost_sys ?? 0),
      ported: Number(r.ported ?? 0),
    },
    rules: r.rules,
    policies: r.policies,
    updatedBy: r.updated_by ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

export function getHlrProvider(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadHlrProvider(pool, id)) ?? notFound(reply, "HLR provider", id));
}

async function checkProvider(db: Db, input: HlrProviderInput, exceptId: number): Promise<FieldError[] | string> {
  const errors: FieldError[] = [];
  if (!input.name.trim()) errors.push({ path: "/name", message: "required" });
  if (!input.url.includes("{DNID}") && !(input.postData ?? "").includes("{DNID}"))
    errors.push({ path: "/url", message: "put {DNID} where the number goes (in the URL or the POST data)" });
  for (const [i, line] of (input.extraHeaders ?? "").split(/\r?\n/).entries())
    if (line.trim() && !/^[A-Za-z0-9-]+:\s*\S/.test(line))
      errors.push({ path: "/extraHeaders", message: `line ${i + 1}: write it as "Name: value"` });
  const { rows: cur } = await db.query("SELECT 1 FROM currencies WHERE iso = $1", [input.currency]);
  if (!cur[0]) errors.push({ path: "/currency", message: "unknown currency" });
  if (errors.length) return errors;
  const { rows } = await db.query("SELECT deleted_at FROM hlr_providers WHERE lower(name) = lower($1) AND id <> $2", [
    input.name.trim(),
    exceptId,
  ]);
  if (rows[0])
    return `A provider named "${input.name.trim()}" exists${rows[0].deleted_at ? " (deleted; restore it instead)" : ""}`;
  return [];
}

const providerValues = (input: HlrProviderInput): ProviderFields => {
  const { password: _password, ...rest } = input;
  return { ...rest, name: input.name.trim() };
};

const providerParam = (field: string, v: unknown) => (field === "responseMapping" ? JSON.stringify(v) : v);

export function createHlrProvider(request: FastifyRequest, reply: FastifyReply) {
  const input = request.body as HlrProviderInput;
  return withDb(reply, async (pool) => {
    const check = await checkProvider(pool, input, 0);
    if (typeof check === "string") return conflict(reply, check);
    if (check.length) return badInput(reply, check);
    const v = providerValues(input);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const cols = PROVIDER_COLUMNS.map(([, col]) => col);
      const { rows } = await c.query(
        `INSERT INTO hlr_providers (${cols.join(", ")}, password, updated_by_id)
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, $${cols.length + 1}, $${cols.length + 2}) RETURNING id`,
        [
          ...PROVIDER_COLUMNS.map(([api]) => providerParam(api, v[api as keyof ProviderFields])),
          input.password || null,
          me.id,
        ],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "hlr_provider",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: v.name } }],
        note: `Added HLR provider ${v.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadHlrProvider(pool, id), change });
  });
}

export function updateHlrProvider(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const input = request.body as HlrProviderInput;
  return withDb(reply, async (pool) => {
    const before = await loadHlrProvider(pool, id);
    if (!before) return notFound(reply, "HLR provider", id);
    if (before.archivedAt) return sendProblem(reply, 400, "This provider is deleted; restore it before editing");
    const v = providerValues(input);
    const diff: DiffEntry[] = PROVIDER_COLUMNS.filter(
      ([api]) => !same(before[api as keyof ProviderFields] ?? null, v[api as keyof ProviderFields] ?? null),
    ).map(([api]) => ({
      entity_id: id,
      field: api,
      before: before[api as keyof ProviderFields] ?? null,
      after: v[api as keyof ProviderFields] ?? null,
    }));
    // The password is never stored in the change log (§13.22): logged as changed, not undoable.
    const passwordChanged = input.password !== null;
    if (passwordChanged)
      diff.push({ entity_id: id, field: "password", before: "(hidden)", after: input.password ? "(hidden)" : null });
    if (!diff.length) return { record: before, change: null };
    const check = await checkProvider(pool, input, id);
    if (typeof check === "string") return conflict(reply, check);
    if (check.length) return badInput(reply, check);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      for (const d of diff) await applyProviderField(c, id, d.field, d.after, me.id);
      if (passwordChanged)
        await c.query("UPDATE hlr_providers SET password = $2 WHERE id = $1", [id, input.password || null]);
      return recordChange(c, {
        entityType: "hlr_provider",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed HLR provider ${v.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadHlrProvider(pool, id), change };
  });
}

async function applyProviderField(c: pg.PoolClient, id: number, field: string, value: unknown, userId: number) {
  const col = PROVIDER_COLUMNS.find(([api]) => api === field)?.[1];
  if (!col) return; // password: not undoable
  await c.query(`UPDATE hlr_providers SET ${col} = $2, updated_by_id = $3, updated_at = now() WHERE id = $1`, [
    id,
    providerParam(field, value),
    userId,
  ]);
}

async function providerDependencies(db: Db, id: number) {
  const count = async (sql: string) => Number((await db.query(sql, [id])).rows[0].n);
  const [rules, policies] = await Promise.all([
    count("SELECT count(*) AS n FROM hlr_rules WHERE hlr_provider_id = $1 AND deleted_at IS NULL"),
    count(
      `SELECT count(*) AS n FROM hlr_policies x WHERE x.deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(x.entries) e, jsonb_array_elements_text(e -> 'providerIds') pid
          WHERE pid::bigint = $1)`,
    ),
  ]);
  return dependencies([
    { key: "hlr_rules", label: "HLR rules", count: rules, blocking: true, detail: null },
    { key: "hlr_policies", label: "HLR policies", count: policies, blocking: true, detail: null },
  ]);
}

export function getHlrProviderDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    if (!(await loadHlrProvider(pool, id))) return notFound(reply, "HLR provider", id);
    return providerDependencies(pool, id);
  });
}

export function archiveHlrProvider(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadHlrProvider(pool, id);
    if (!before) return notFound(reply, "HLR provider", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(reply, (request.body ?? {}) as ArchiveRequest, await providerDependencies(pool, id));
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "hlr_providers",
      entityType: "hlr_provider",
      archive: true,
      note: gate.note ?? `Deleted HLR provider ${before.name}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadHlrProvider(pool, id), change: r.change };
  });
}

export function restoreHlrProvider(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadHlrProvider(pool, id);
    if (!before) return notFound(reply, "HLR provider", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This provider is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "hlr_providers",
      entityType: "hlr_provider",
      archive: false,
      note: null,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadHlrProvider(pool, id), change: r.change };
  });
}

// ---------------------------------------------------------------- provider prices (§6.5 Rate)

export function queryHlrProviderRates(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const top = query.filter?.logic === "and" || !query.filter ? (query.filter?.conditions ?? []) : [];
  if (!top.some((c) => !("logic" in c) && c.field === "providerId" && c.op === "eq"))
    return sendProblem(reply, 400, "Invalid list query", {
      errors: [{ path: "/filter", message: "the filter needs a top-level providerId eq condition" }],
    });
  const errors = checkListQuery(query, listFields.hlr_provider_rates);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, (pool) => runList(pool, hlrProviderRateList, query));
}

async function liveProvider(db: Db, reply: FastifyReply, id: number) {
  const { rows } = await db.query("SELECT name, deleted_at FROM hlr_providers WHERE id = $1", [id]);
  if (!rows[0]) return notFound(reply, "HLR provider", id);
  if (rows[0].deleted_at) return sendProblem(reply, 400, "This provider is deleted; restore it before editing");
  return rows[0].name as string;
}

export function setHlrProviderRate(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = request.body as HlrProviderRateInput;
  return withDb(reply, async (pool) => {
    const name = await liveProvider(pool, reply, id);
    if (typeof name !== "string") return name;
    const { rows: m } = await pool.query("SELECT mccmnc FROM mccmnc WHERE id = $1 AND deleted_at IS NULL", [
      body.destinationId,
    ]);
    if (!m[0]) return badInput(reply, [{ path: "/destinationId", message: "unknown MCCMNC code" }]);
    const { rows: old } = await pool.query(
      "SELECT id, rate FROM hlr_provider_rates WHERE hlr_provider_id = $1 AND mccmnc_id = $2 AND deleted_at IS NULL",
      [id, body.destinationId],
    );
    const me = await getCurrentUser();
    if (old[0] && Number(old[0].rate) === body.rate) {
      const rec = await load(pool, hlrProviderRateList, Number(old[0].id));
      return { record: rec, change: null };
    }
    const { rateId, change } = await inTransaction(pool, async (c) => {
      let rateId: number;
      let diff: DiffEntry[];
      if (old[0]) {
        rateId = Number(old[0].id);
        await c.query("UPDATE hlr_provider_rates SET rate = $2, updated_by_id = $3, updated_at = now() WHERE id = $1", [
          rateId,
          body.rate,
          me.id,
        ]);
        diff = [{ entity_id: rateId, field: "rate", before: Number(old[0].rate), after: body.rate }];
      } else {
        const { rows } = await c.query(
          "INSERT INTO hlr_provider_rates (hlr_provider_id, mccmnc_id, rate, updated_by_id) VALUES ($1, $2, $3, $4) RETURNING id",
          [id, body.destinationId, body.rate, me.id],
        );
        rateId = Number(rows[0].id);
        diff = [{ entity_id: rateId, field: "*", before: null, after: { mccmnc: m[0].mccmnc, rate: body.rate } }];
      }
      const change = await recordChange(c, {
        entityType: "hlr_provider_rate",
        entityIds: [rateId],
        changeType: old[0] ? "edit" : "create",
        diff,
        note: `HLR price ${name} · ${m[0].mccmnc} = ${body.rate}`,
        userId: me.id,
        ip: request.ip,
      });
      return { rateId, change };
    });
    return { record: await load(pool, hlrProviderRateList, rateId), change };
  });
}

export function deleteHlrProviderRates(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { ids } = request.body as IdList;
  return withDb(reply, async (pool) => {
    const name = await liveProvider(pool, reply, id);
    if (typeof name !== "string") return name;
    const { rows } = await pool.query(
      "SELECT id FROM hlr_provider_rates WHERE id = ANY($1) AND hlr_provider_id = $2 AND deleted_at IS NULL",
      [ids, id],
    );
    if (!rows.length) return { change: null };
    const live = rows.map((r) => Number(r.id));
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query("UPDATE hlr_provider_rates SET deleted_at = now(), updated_by_id = $2 WHERE id = ANY($1)", [
        live,
        me.id,
      ]);
      return recordChange(c, {
        entityType: "hlr_provider_rate",
        entityIds: live,
        changeType: "delete",
        diff: live.map((x) => ({ entity_id: x, field: "archived", before: false, after: true })),
        note: `Removed ${live.length} HLR price${live.length === 1 ? "" : "s"} of ${name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { change };
  });
}

export function importHlrProviderRates(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = request.body as ImportRequest;
  const { header, rows } = parseCsv(body.csv);
  const missing = ["mccmnc", "rate"].filter((c) => !header.includes(c));
  if (missing.length)
    return sendProblem(reply, 400, `The file needs the column(s) ${missing.join(", ")} in its header row`, {
      errors: missing.map((m) => ({ path: "/csv", message: `missing column ${m}` })),
    });
  return withDb(reply, async (pool) => {
    const name = await liveProvider(pool, reply, id);
    if (typeof name !== "string") return name;
    const run = new ImportRun(rows.length);
    const { rows: codes } = await pool.query("SELECT id, mccmnc FROM mccmnc WHERE deleted_at IS NULL");
    const codeId = new Map(codes.map((c) => [c.mccmnc as string, Number(c.id)]));
    const { rows: live } = await pool.query(
      `SELECT r.id, r.rate, m.mccmnc FROM hlr_provider_rates r JOIN mccmnc m ON m.id = r.mccmnc_id
        WHERE r.hlr_provider_id = $1 AND r.deleted_at IS NULL`,
      [id],
    );
    const existing = new Map(live.map((r) => [r.mccmnc as string, r]));
    const seen = new Map<string, number>();
    const inserts: { mccmncId: number; code: string; rate: number }[] = [];
    const updates: { id: number; before: number; rate: number }[] = [];
    for (const { line, values } of rows) {
      const code = values.mccmnc ?? "";
      const rate = Number((values.rate ?? "").replace(",", "."));
      const mccmncId = codeId.get(code);
      if (mccmncId === undefined) {
        run.error(line, code || null, `MCCMNC ${code || "(empty)"} is not a live code`);
        continue;
      }
      if (!(values.rate ?? "").trim() || !Number.isFinite(rate) || rate < 0 || rate > 1) {
        run.error(line, code, "rate must be a number from 0 to 1");
        continue;
      }
      if (seen.has(code)) {
        run.error(line, code, `also on line ${seen.get(code)}`);
        continue;
      }
      seen.set(code, line);
      const old = existing.get(code);
      if (!old) {
        inserts.push({ mccmncId, code, rate });
        run.added++;
      } else if (Number(old.rate) !== rate) {
        updates.push({ id: Number(old.id), before: Number(old.rate), rate });
        run.updated++;
      } else run.unchanged++;
    }
    const removes =
      body.mode === "replace" ? [...existing].filter(([code]) => !seen.has(code)).map(([, r]) => Number(r.id)) : [];
    run.archived = removes.length;
    if (body.dryRun || run.errors.length) return run.result(false, body.dryRun, null);
    if (!inserts.length && !updates.length && !removes.length) return run.result(true, false, null);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      const diff: DiffEntry[] = [];
      for (const v of inserts) {
        const { rows: ins } = await c.query(
          "INSERT INTO hlr_provider_rates (hlr_provider_id, mccmnc_id, rate, updated_by_id) VALUES ($1, $2, $3, $4) RETURNING id",
          [id, v.mccmncId, v.rate, me.id],
        );
        diff.push({ entity_id: Number(ins[0].id), field: "*", before: null, after: { mccmnc: v.code, rate: v.rate } });
      }
      for (const u of updates) {
        await c.query("UPDATE hlr_provider_rates SET rate = $2, updated_by_id = $3, updated_at = now() WHERE id = $1", [
          u.id,
          u.rate,
          me.id,
        ]);
        diff.push({ entity_id: u.id, field: "rate", before: u.before, after: u.rate });
      }
      if (removes.length) {
        await c.query("UPDATE hlr_provider_rates SET deleted_at = now(), updated_by_id = $2 WHERE id = ANY($1)", [
          removes,
          me.id,
        ]);
        diff.push(...removes.map((x) => ({ entity_id: x, field: "archived", before: false, after: true })));
      }
      return recordChange(c, {
        entityType: "hlr_provider_rate",
        entityIds: diff.map((d) => d.entity_id),
        changeType: "import",
        diff,
        note: `HLR price import (${name}): ${run.added} added, ${run.updated} changed, ${run.archived} removed`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return run.result(true, false, change);
  });
}

export function exportHlrProviderRates(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const { rows: p } = await pool.query("SELECT name, currency FROM hlr_providers WHERE id = $1", [id]);
    if (!p[0]) return notFound(reply, "HLR provider", id);
    const { rows } = await pool.query(
      `SELECT m.mccmnc, co.name AS country, CASE WHEN m.is_all_networks THEN '' ELSE m.network END AS network, r.rate
         FROM hlr_provider_rates r JOIN mccmnc m ON m.id = r.mccmnc_id JOIN countries co ON co.id = m.country_id
        WHERE r.hlr_provider_id = $1 AND r.deleted_at IS NULL ORDER BY co.name, m.mccmnc`,
      [id],
    );
    const cur = String(p[0].currency).trim();
    const lines = rows.map((r) => [r.mccmnc, r.country, r.network, Number(r.rate), cur].map(csvCell).join(","));
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="hlr_rates_${String(p[0].name).replace(/[^\w.-]+/g, "_")}.csv"`,
      )
      .send(["mccmnc,country,network,rate,currency", ...lines].join("\r\n") + "\r\n");
  });
}

// ---------------------------------------------------------------- rules (§6.5, §13.2)

const RULE_COLUMNS: [string, string][] = [
  ["name", "name"],
  ["providerId", "hlr_provider_id"],
  ["dnidPattern", "dnid_pattern"],
  ["status", "status"],
  ["insertAt", "insert_at"],
];
const targetKey = (t: HlrTargetInput) => `${t.type}:${t.id ?? ""}`;
const plainTargets = (ts: HlrTargetInput[]) =>
  ts.map((t) => ({ type: t.type, id: t.id })).sort((a, b) => (targetKey(a) < targetKey(b) ? -1 : 1));

async function ruleTargets(db: Db, id: number): Promise<HlrTarget[]> {
  const { rows } = await db.query(
    `SELECT tg.target_type, tg.target_id, COALESCE(ct.name, e.name, pc.name) AS label
       FROM hlr_rule_targets tg
       LEFT JOIN customer_trunks ct ON tg.target_type = 'trunk' AND ct.id = tg.target_id
       LEFT JOIN enterprises e ON tg.target_type = 'enterprise' AND e.id = tg.target_id
       LEFT JOIN product_categories pc ON tg.target_type = 'category' AND pc.id = tg.target_id
      WHERE tg.hlr_rule_id = $1
      ORDER BY array_position(ARRAY['all','category','enterprise','trunk'], tg.target_type), label`,
    [id],
  );
  return rows.map((r) => ({
    type: r.target_type,
    id: r.target_id === null ? null : Number(r.target_id),
    label: r.target_type === "all" ? "All customer trunks" : (r.label ?? `#${r.target_id}`),
  }));
}

export async function loadHlrRule(db: Db, id: number): Promise<HlrRuleDetail | null> {
  const { rows } = await db.query(
    `SELECT r.*, p.name AS provider_name, ub.username AS updated_by, ${hlrUsedBySql("r")} AS used_by
       FROM hlr_rules r JOIN hlr_providers p ON p.id = r.hlr_provider_id LEFT JOIN users ub ON ub.id = r.updated_by_id
      WHERE r.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    name: r.name,
    providerId: Number(r.hlr_provider_id),
    providerName: r.provider_name,
    dnidPattern: r.dnid_pattern,
    status: r.status,
    insertAt: r.insert_at,
    targets: await ruleTargets(db, id),
    usedBy: Number(r.used_by),
    updatedBy: r.updated_by ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

export function getHlrRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadHlrRule(pool, id)) ?? notFound(reply, "HLR rule", id));
}

async function checkHlrRule(db: Db, input: HlrRuleInput): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  if (!input.name.trim()) errors.push({ path: "/name", message: "required" });
  if (!compile(input.dnidPattern)) errors.push({ path: "/dnidPattern", message: "not a valid regular expression" });
  const { rows } = await db.query("SELECT 1 FROM hlr_providers WHERE id = $1 AND deleted_at IS NULL", [
    input.providerId,
  ]);
  if (!rows[0]) errors.push({ path: "/providerId", message: "unknown or deleted provider" });
  const seen = new Set<string>();
  for (const [i, t] of input.targets.entries()) {
    if (seen.has(targetKey(t))) errors.push({ path: `/targets/${i}`, message: "listed twice" });
    seen.add(targetKey(t));
    if ((t.type === "all") !== (t.id === null))
      errors.push({ path: `/targets/${i}/id`, message: t.type === "all" ? "must be null" : "required" });
    if (t.id === null) continue;
    const table =
      t.type === "trunk" ? "customer_trunks" : t.type === "enterprise" ? "enterprises" : "product_categories";
    const { rows: ok } = await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [t.id]);
    if (!ok[0]) errors.push({ path: `/targets/${i}/id`, message: `unknown ${t.type}` });
  }
  return errors;
}

async function writeHlrTargets(
  c: pg.PoolClient,
  id: number,
  targets: HlrTargetInput[],
  insertAt: string,
  userId: number,
) {
  await c.query("DELETE FROM hlr_rule_targets WHERE hlr_rule_id = $1", [id]);
  if (!targets.length) return;
  await c.query(
    `INSERT INTO hlr_rule_targets (hlr_rule_id, target_type, target_id, insert_at, created_by_id)
     SELECT $1, t, x, $4, $5 FROM unnest($2::text[], $3::bigint[]) AS u(t, x)`,
    [id, targets.map((t) => t.type), targets.map((t) => t.id), insertAt, userId],
  );
}

async function applyRuleField(c: pg.PoolClient, id: number, field: string, value: unknown, userId: number) {
  if (field === "targets") {
    const { rows } = await c.query("SELECT insert_at FROM hlr_rules WHERE id = $1", [id]);
    await writeHlrTargets(c, id, (value as HlrTargetInput[]) ?? [], rows[0]?.insert_at ?? "bottom", userId);
    return;
  }
  const col = RULE_COLUMNS.find(([api]) => api === field)?.[1];
  if (!col) return;
  await c.query(`UPDATE hlr_rules SET ${col} = $2, updated_by_id = $3, updated_at = now() WHERE id = $1`, [
    id,
    value,
    userId,
  ]);
  if (field === "insertAt")
    await c.query("UPDATE hlr_rule_targets SET insert_at = $2 WHERE hlr_rule_id = $1", [id, value]);
}

const normaliseRule = (input: HlrRuleInput): HlrRuleInput => ({
  ...input,
  name: input.name.trim(),
  targets: plainTargets(input.targets),
});

export function createHlrRule(request: FastifyRequest, reply: FastifyReply) {
  const input = normaliseRule(request.body as HlrRuleInput);
  return withDb(reply, async (pool) => {
    const errors = await checkHlrRule(pool, input);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO hlr_rules (name, hlr_provider_id, dnid_pattern, status, insert_at, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.name, input.providerId, input.dnidPattern, input.status, input.insertAt, me.id],
      );
      const id = Number(rows[0].id);
      await writeHlrTargets(c, id, input.targets, input.insertAt, me.id);
      const change = await recordChange(c, {
        entityType: "hlr_rule",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: input.name } }],
        note: `Added HLR rule ${input.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadHlrRule(pool, id), change });
  });
}

export function updateHlrRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const input = normaliseRule(request.body as HlrRuleInput);
  return withDb(reply, async (pool) => {
    const before = await loadHlrRule(pool, id);
    if (!before) return notFound(reply, "HLR rule", id);
    if (before.archivedAt) return sendProblem(reply, 400, "This rule is deleted; restore it before editing");
    const diff: DiffEntry[] = RULE_COLUMNS.filter(
      ([api]) => !same(before[api as keyof HlrRuleDetail], input[api as keyof HlrRuleInput]),
    ).map(([api]) => ({
      entity_id: id,
      field: api,
      before: before[api as keyof HlrRuleDetail],
      after: input[api as keyof HlrRuleInput],
    }));
    const beforeTargets = plainTargets(before.targets);
    if (!same(beforeTargets, input.targets))
      diff.push({ entity_id: id, field: "targets", before: beforeTargets, after: input.targets });
    if (!diff.length) return { record: before, change: null };
    const errors = await checkHlrRule(pool, input);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      for (const d of diff) await applyRuleField(c, id, d.field, d.after, me.id);
      return recordChange(c, {
        entityType: "hlr_rule",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed HLR rule ${input.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadHlrRule(pool, id), change };
  });
}

export function getHlrRuleUsedBy(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool): Promise<RuleUsedBy | FastifyReply> => {
    const { rows: exists } = await pool.query("SELECT 1 FROM hlr_rules WHERE id = $1", [id]);
    if (!exists[0]) return notFound(reply, "HLR rule", id);
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (t.id) t.id, t.name, e.name AS enterprise_name, tg.target_type AS via,
              COALESCE(s.enabled, true) AS enabled
         FROM hlr_rule_targets tg
         JOIN customer_trunks t ON t.deleted_at IS NULL
          AND (tg.target_type = 'all' OR (tg.target_type = 'trunk' AND tg.target_id = t.id)
               OR (tg.target_type = 'enterprise' AND tg.target_id = t.enterprise_id)
               OR (tg.target_type = 'category' AND tg.target_id = t.product_category_id))
         JOIN enterprises e ON e.id = t.enterprise_id
         LEFT JOIN hlr_rule_trunk_settings s ON s.hlr_rule_id = tg.hlr_rule_id AND s.customer_trunk_id = t.id
        WHERE tg.hlr_rule_id = $1
        ORDER BY t.id, array_position(ARRAY['trunk','enterprise','category','all'], tg.target_type)`,
      [id],
    );
    return {
      trunks: rows
        .map((r) => ({
          kind: "customer" as const,
          id: Number(r.id),
          name: r.name,
          enterpriseName: r.enterprise_name,
          via: r.via,
          enabled: r.enabled,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

export function archiveHlrRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadHlrRule(pool, id);
    if (!before) return notFound(reply, "HLR rule", id);
    if (before.archivedAt) return { record: before, change: null };
    // Assigned to a live trunk or enterprise: cannot be deleted (team trial round 3).
    const gate = await archiveGate(
      reply,
      (request.body ?? {}) as ArchiveRequest,
      await ruleTargetDependencies(pool, "hlr", id, before.usedBy),
    );
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "hlr_rules",
      entityType: "hlr_rule",
      archive: true,
      note: gate.note ?? `Deleted HLR rule ${before.name} (ran on ${before.usedBy} trunks)`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadHlrRule(pool, id), change: r.change };
  });
}

export function restoreHlrRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadHlrRule(pool, id);
    if (!before) return notFound(reply, "HLR rule", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This rule is not deleted");
    const { rows } = await pool.query("SELECT deleted_at FROM hlr_providers WHERE id = $1", [before.providerId]);
    if (rows[0]?.deleted_at) return conflict(reply, `Its provider ${before.providerName} is deleted; restore it first`);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query("UPDATE hlr_rules SET deleted_at = NULL, updated_by_id = $2, updated_at = now() WHERE id = $1", [
        id,
        me.id,
      ]);
      return recordChange(c, {
        entityType: "hlr_rule",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: "archived", before: true, after: false }],
        note: "Restored",
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadHlrRule(pool, id), change };
  });
}

// ---------------------------------------------------------------- policies (§13.24)

export async function loadHlrPolicy(db: Db, id: number): Promise<HlrPolicyDetail | null> {
  const { rows } = await db.query(
    `SELECT hpo.*, ub.username AS updated_by,
            (SELECT count(*)::int FROM route_rules x WHERE x.deleted_at IS NULL
                AND (x.hlr_action ->> 'policy_id')::bigint = hpo.id) AS used_by
       FROM hlr_policies hpo LEFT JOIN users ub ON ub.id = hpo.updated_by_id WHERE hpo.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const entries = r.entries as HlrPolicyEntry[];
  const ids = [...new Set(entries.flatMap((e) => e.providerIds))];
  const { rows: names } = await db.query("SELECT id, name FROM hlr_providers WHERE id = ANY($1) ORDER BY name", [ids]);
  return {
    id: Number(r.id),
    name: r.name,
    status: r.status,
    entries,
    providers: names.map((n) => ({ id: Number(n.id), name: n.name })),
    usedBy: r.used_by,
    updatedBy: r.updated_by ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

export function getHlrPolicy(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadHlrPolicy(pool, id)) ?? notFound(reply, "HLR policy", id));
}

/** Countries first by code, catch-all last; auto keeps its minimum, ordered drops it. */
export function normaliseEntries(entries: HlrPolicyEntry[]): HlrPolicyEntry[] {
  return entries
    .map((e) => ({ ...e, minSuccessPct: e.mode === "auto" ? e.minSuccessPct : null }))
    .sort((a, b) => (a.code === null ? 1 : b.code === null ? -1 : a.code.localeCompare(b.code)));
}

async function checkPolicy(db: Db, input: HlrPolicyInput, exceptId: number): Promise<FieldError[] | string> {
  const errors: FieldError[] = [];
  if (!input.name.trim()) errors.push({ path: "/name", message: "required" });
  const seen = new Map<string | null, number>();
  input.entries.forEach((e, i) => {
    if (seen.has(e.code))
      errors.push({
        path: `/entries/${i}/code`,
        message: e.code === null ? "only one catch-all" : `${e.code} is also entry ${seen.get(e.code)! + 1}`,
      });
    seen.set(e.code, i);
    if (new Set(e.providerIds).size !== e.providerIds.length)
      errors.push({ path: `/entries/${i}/providerIds`, message: "a provider is listed twice" });
    if (e.mode === "auto" && e.minSuccessPct === null)
      errors.push({ path: `/entries/${i}/minSuccessPct`, message: "auto needs a minimum success rate" });
  });
  const codes = input.entries.map((e) => e.code).filter((c): c is string => c !== null);
  if (codes.length) {
    const { rows } = await db.query(
      `SELECT c FROM unnest($1::text[]) AS c WHERE NOT EXISTS (SELECT 1 FROM mccmnc m WHERE m.deleted_at IS NULL
          AND m.mccmnc = c)`,
      [codes],
    );
    for (const r of rows)
      errors.push({ path: `/entries/${seen.get(r.c)}/code`, message: `${r.c} is not a live MCCMNC code or MCC` });
  }
  const ids = [...new Set(input.entries.flatMap((e) => e.providerIds))];
  const { rows: providers } = await db.query("SELECT id FROM hlr_providers WHERE id = ANY($1) AND deleted_at IS NULL", [
    ids,
  ]);
  const live = new Set(providers.map((p) => Number(p.id)));
  input.entries.forEach((e, i) => {
    const bad = e.providerIds.filter((p) => !live.has(p));
    if (bad.length)
      errors.push({ path: `/entries/${i}/providerIds`, message: `unknown or deleted provider ${bad.join(", ")}` });
  });
  if (errors.length) return errors;
  const { rows } = await db.query(
    "SELECT 1 FROM hlr_policies WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> $2",
    [input.name.trim(), exceptId],
  );
  return rows[0] ? `A policy named "${input.name.trim()}" exists` : [];
}

async function applyPolicyField(c: pg.PoolClient, id: number, field: string, value: unknown, userId: number) {
  const col = ({ name: "name", status: "status", entries: "entries" } as Record<string, string>)[field];
  if (!col) return;
  await c.query(`UPDATE hlr_policies SET ${col} = $2, updated_by_id = $3, updated_at = now() WHERE id = $1`, [
    id,
    field === "entries" ? JSON.stringify(value ?? []) : value,
    userId,
  ]);
}

export function createHlrPolicy(request: FastifyRequest, reply: FastifyReply) {
  const raw = request.body as HlrPolicyInput;
  const input = { ...raw, name: raw.name.trim(), entries: normaliseEntries(raw.entries) };
  return withDb(reply, async (pool) => {
    // Checked in the order sent, so error paths point at the rows the user sees.
    const check = await checkPolicy(pool, { ...raw, name: input.name }, 0);
    if (typeof check === "string") return conflict(reply, check);
    if (check.length) return badInput(reply, check);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        "INSERT INTO hlr_policies (name, status, entries, updated_by_id) VALUES ($1, $2, $3, $4) RETURNING id",
        [input.name, input.status, JSON.stringify(input.entries), me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "hlr_policy",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: input.name } }],
        note: `Added HLR policy ${input.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadHlrPolicy(pool, id), change });
  });
}

export function updateHlrPolicy(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const raw = request.body as HlrPolicyInput;
  const input = { ...raw, name: raw.name.trim(), entries: normaliseEntries(raw.entries) };
  return withDb(reply, async (pool) => {
    const before = await loadHlrPolicy(pool, id);
    if (!before) return notFound(reply, "HLR policy", id);
    if (before.archivedAt) return sendProblem(reply, 400, "This policy is deleted; restore it before editing");
    const diff: DiffEntry[] = (["name", "status", "entries"] as const)
      .filter((f) => !same(before[f], input[f]))
      .map((f) => ({ entity_id: id, field: f, before: before[f], after: input[f] }));
    if (!diff.length) return { record: before, change: null };
    const check = await checkPolicy(pool, { ...raw, name: input.name }, id);
    if (typeof check === "string") return conflict(reply, check);
    if (check.length) return badInput(reply, check);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      for (const d of diff) await applyPolicyField(c, id, d.field, d.after, me.id);
      return recordChange(c, {
        entityType: "hlr_policy",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed HLR policy ${input.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadHlrPolicy(pool, id), change };
  });
}

async function policyDependencies(db: Db, id: number) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n, string_agg('#' || id, ', ' ORDER BY id) FILTER (WHERE true) AS ids FROM (
       SELECT id FROM route_rules WHERE deleted_at IS NULL AND (hlr_action ->> 'policy_id')::bigint = $1 ORDER BY id) x`,
    [id],
  );
  return dependencies([
    {
      key: "route_rules",
      label: "Route rules (HLR action)",
      count: rows[0].n,
      blocking: true,
      detail: rows[0].n ? String(rows[0].ids).split(", ").slice(0, 10).join(", ") : null,
    },
  ]);
}

export function getHlrPolicyDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    if (!(await loadHlrPolicy(pool, id))) return notFound(reply, "HLR policy", id);
    return policyDependencies(pool, id);
  });
}

export function archiveHlrPolicy(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadHlrPolicy(pool, id);
    if (!before) return notFound(reply, "HLR policy", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(reply, (request.body ?? {}) as ArchiveRequest, await policyDependencies(pool, id));
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "hlr_policies",
      entityType: "hlr_policy",
      archive: true,
      note: gate.note ?? `Deleted HLR policy ${before.name}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadHlrPolicy(pool, id), change: r.change };
  });
}

export function restoreHlrPolicy(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadHlrPolicy(pool, id);
    if (!before) return notFound(reply, "HLR policy", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This policy is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "hlr_policies",
      entityType: "hlr_policy",
      archive: false,
      note: null,
      restoreClash: async (db) => {
        const { rows } = await db.query(
          "SELECT 1 FROM hlr_policies WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> $2",
          [before.name, id],
        );
        return rows[0] ? `A live policy is named "${before.name}"` : null;
      },
    });
    if ("reply" in r) return r.reply;
    return { record: await loadHlrPolicy(pool, id), change: r.change };
  });
}

/** The entry that applies to a network: its own code, else its country's MCC, else the catch-all. */
export function entryFor(entries: HlrPolicyEntry[], mccmnc: string | null): HlrPolicyEntry | null {
  if (mccmnc) {
    const own = entries.find((e) => e.code === mccmnc);
    if (own) return own;
    const country = entries.find((e) => e.code === mccmnc.slice(0, 3));
    if (country) return country;
  }
  return entries.find((e) => e.code === null) ?? null;
}

/**
 * Provider order for an entry: as listed, or for "auto" the providers meeting the minimum
 * success rate by price, then the others by price. Inactive, down or deleted providers are
 * kept in the list with the reason they would be skipped.
 */
export function orderProviders<
  P extends { providerId: number; rate: number; successPct: number | null; liveStatus: string; deleted: boolean },
>(entry: HlrPolicyEntry, providers: P[]): (P & { skipped: string | null })[] {
  const byId = new Map(providers.map((p) => [p.providerId, p]));
  const listed = entry.providerIds.map((id) => byId.get(id)).filter((p): p is P => !!p);
  const meets = (p: P) => entry.minSuccessPct === null || (p.successPct ?? 0) >= entry.minSuccessPct;
  const ordered =
    entry.mode === "auto" ? [...listed].sort((a, b) => Number(meets(b)) - Number(meets(a)) || a.rate - b.rate) : listed;
  return ordered.map((p) => ({
    ...p,
    skipped: p.deleted
      ? "deleted"
      : p.liveStatus === "inactive"
        ? "inactive"
        : p.liveStatus === "down"
          ? "down"
          : entry.mode === "auto" && !meets(p)
            ? `success under ${entry.minSuccessPct} %`
            : null,
  }));
}

export function testHlrPolicy(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { receiver } = request.body as HlrPolicyTestInput;
  return withDb(reply, async (pool): Promise<HlrPolicyTestResult | FastifyReply> => {
    const policy = await loadHlrPolicy(pool, id);
    if (!policy) return notFound(reply, "HLR policy", id);
    const mccmnc = (await mccmncLookup(pool))(receiver);
    const { rows: dest } = mccmnc
      ? await pool.query(
          `SELECT m.id, m.mcc, co.name AS country, CASE WHEN m.is_all_networks THEN 'All networks' ELSE m.network END AS network
             FROM mccmnc m JOIN countries co ON co.id = m.country_id WHERE m.mccmnc = $1`,
          [mccmnc],
        )
      : { rows: [] as Record<string, unknown>[] };
    const d = dest[0];
    const entry = entryFor(policy.entries, mccmnc);
    if (!entry) return { mccmnc, destination: d ? `${d.country} · ${d.network}` : null, entry: null, providers: [] };
    // Price: the network's own, else its country's "all networks" price, else the default.
    const { rows } = await pool.query(
      `SELECT hp.id, hp.name, hp.currency, hp.default_rate, hp.deleted_at, hs.success_pct, ${hlrLiveStatusSql} AS live_status,
              (SELECT r.rate FROM hlr_provider_rates r JOIN mccmnc m ON m.id = r.mccmnc_id
                WHERE r.hlr_provider_id = hp.id AND r.deleted_at IS NULL
                  AND (m.mccmnc = $2 OR (m.is_all_networks AND m.mcc = $3))
                ORDER BY m.is_all_networks LIMIT 1) AS rate
         FROM hlr_providers hp LEFT JOIN hlr_provider_stats hs ON hs.hlr_provider_id = hp.id
        WHERE hp.id = ANY($1)`,
      [entry.providerIds, mccmnc, mccmnc?.slice(0, 3) ?? null],
    );
    // Success for this destination over 7 days where the EDR store has it, else the provider's.
    const perDest = mccmnc
      ? await chRows<{ p: number; live: string; ok: string }>(
          `SELECT hlr_provider_id AS p, countIf(hlr_fetch_type = 'live') AS live,
                  countIf(hlr_fetch_type = 'live' AND hlr_is_accomplished = 1) AS ok
             FROM edr WHERE c_mccmnc = '${mccmnc.replace(/\D/g, "")}' AND hlr_provider_id IN (${entry.providerIds.join(",")})
              AND submit_time > ${edrNowSql()} - INTERVAL 7 DAY
            GROUP BY p`,
        )
      : null;
    const destPct = new Map(
      (perDest ?? [])
        .filter((r) => Number(r.live) >= 20)
        .map((r) => {
          const h = health(Number(r.p));
          return [Number(r.p), Math.round((Number(r.ok) / Number(r.live)) * h.success * 1000) / 10];
        }),
    );
    const providers = orderProviders(
      entry,
      rows.map((r) => ({
        providerId: Number(r.id),
        name: r.name as string,
        rate: Number(r.rate ?? r.default_rate),
        currency: String(r.currency).trim(),
        successPct: destPct.get(Number(r.id)) ?? (r.success_pct === null ? null : Number(r.success_pct)),
        liveStatus: r.live_status as HlrPolicyTestResult["providers"][number]["liveStatus"],
        deleted: r.deleted_at !== null,
      })),
    ).map(({ deleted: _deleted, ...p }) => p);
    return { mccmnc, destination: d ? `${d.country} · ${d.network}` : null, entry, providers };
  });
}

// ---------------------------------------------------------------- undo (§13.10)

/** Puts one field of an HLR record back (provider passwords are never undone). */
export async function applyHlrField(
  c: pg.PoolClient,
  entityType: string,
  id: number,
  field: string,
  value: unknown,
  userId: number,
) {
  if (entityType === "hlr_provider") await applyProviderField(c, id, field, value, userId);
  else if (entityType === "hlr_rule") await applyRuleField(c, id, field, value, userId);
  else if (entityType === "hlr_policy") await applyPolicyField(c, id, field, value, userId);
}

export function getHlrRuleDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const rule = await loadHlrRule(pool, id);
    if (!rule) return notFound(reply, "HLR rule", id);
    return ruleTargetDependencies(pool, "hlr", id, rule.usedBy);
  });
}
