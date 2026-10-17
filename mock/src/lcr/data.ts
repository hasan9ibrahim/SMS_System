// Data behind LCR (§13.23): QBR quality per vendor trunk and destination, vendor tiers, live TPS
// against each trunk's limit, and the LCR profiles of Least cost rules.
import type pg from "pg";
import { runningSimulator } from "../live/socket.js";
import type { LcrProfileCore } from "./rank.js";

type Db = pg.Pool | pg.PoolClient;

export interface Quality {
  asr: number | null;
  dlr: number | null;
  delayS: number | null;
  attempts: number;
}

/** Effective vendor QBR stats (overrides win) per destination code and vendor trunk. */
export async function qbrQuality(db: Db, codes: string[]): Promise<Map<string, Map<number, Quality>>> {
  const out = new Map<string, Map<number, Quality>>();
  if (!codes.length) return out;
  const { rows } = await db.query(
    `SELECT m.mccmnc, q.trunk_id, q.attempts,
            CASE WHEN q.overridden THEN coalesce(q.override_asr, q.asr) ELSE q.asr END AS asr,
            CASE WHEN q.overridden THEN coalesce(q.override_dlr, q.dlr) ELSE q.dlr END AS dlr,
            CASE WHEN q.overridden THEN coalesce(q.override_add_s, q.add_s) ELSE q.add_s END AS delay
       FROM qbr_stats q JOIN mccmnc m ON m.id = q.mccmnc_id
      WHERE q.side = 'vendor' AND m.mccmnc = ANY($1)`,
    [codes],
  );
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  for (const r of rows) {
    const m = out.get(r.mccmnc) ?? new Map<number, Quality>();
    m.set(Number(r.trunk_id), { asr: num(r.asr), dlr: num(r.dlr), delayS: num(r.delay), attempts: Number(r.attempts) });
    out.set(r.mccmnc, m);
  }
  return out;
}

/** The quality of a destination, falling back to its country's "all networks" code. */
export const qualityFor = (q: Map<string, Map<number, Quality>>, code: string) =>
  q.get(code) ?? q.get(code.slice(0, 3)) ?? new Map<number, Quality>();

let tierCache: { at: number; tiers: Map<number, { tier: string; limit: number }> } | null = null;
/** Each vendor trunk's tier (its enterprise's) and TPS limit, cached a minute. */
export async function vendorTiers(db: Db): Promise<Map<number, { tier: string; limit: number }>> {
  if (tierCache && Date.now() - tierCache.at < 60_000) return tierCache.tiers;
  const { rows } = await db.query(
    "SELECT vt.id, e.tier, vt.tps FROM vendor_trunks vt JOIN enterprises e ON e.id = vt.enterprise_id",
  );
  tierCache = {
    at: Date.now(),
    tiers: new Map(rows.map((r) => [Number(r.id), { tier: r.tier, limit: Number(r.tps) }])),
  };
  return tierCache.tiers;
}

/** TPS now per vendor trunk from the live traffic simulator; empty when it is not running. */
export function tpsNow(): Map<number, number> {
  const sim = runningSimulator();
  return new Map((sim?.vendors ?? []).map((v) => [v.id, Math.round(v.tps * 10) / 10]));
}

/** A vendor at 95 % or more of its limit counts as at its limit. */
export const atLimit = (tps: number | undefined, limit: number | undefined) =>
  tps !== undefined && limit !== undefined && limit > 0 && tps >= limit * 0.95;

export function mapProfile(r: Record<string, unknown>): LcrProfileCore {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    vendorTrunkMode: r.vendor_trunk_mode as LcrProfileCore["vendorTrunkMode"],
    vendorTrunkIds: ((r.vendor_trunk_ids as string[]) ?? []).map(Number),
    tiers: (r.tiers as LcrProfileCore["tiers"]) ?? [],
    minAsr: num(r.min_asr),
    minDlr: num(r.min_dlr),
    maxDelayS: num(r.max_delay_s),
    maxRate: num(r.max_rate),
    vendorCount: Number(r.vendor_count),
    split: r.split as LcrProfileCore["split"],
    shares: ((r.shares as number[]) ?? []).map(Number),
    tieBreaker: r.tie_breaker as LcrProfileCore["tieBreaker"],
    excludeAtTpsLimit: r.exclude_at_tps_limit as boolean,
    qualityWeighted: r.quality_weighted as boolean,
    weights: r.weights as LcrProfileCore["weights"],
  };
}

/** Live LCR profiles by ID (archived and inactive ones are not used by rules). */
export async function loadLcrProfiles(db: Db): Promise<Map<number, LcrProfileCore>> {
  const { rows } = await db.query("SELECT * FROM lcr_profiles WHERE deleted_at IS NULL AND status = 'active'");
  return new Map(rows.map((r) => [Number(r.id), mapProfile(r)]));
}
