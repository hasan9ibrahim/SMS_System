// Live routing (§6.3, team trial round 1): the traffic simulator's messages follow today's route rules.
// Each sending customer trunk's route map (the same engine as the Route map page and Rate Lookup) is
// computed in the background, one trunk at a time, and refreshed every 10 minutes; until a trunk's map is
// ready its messages keep the vendor of the stored EDR they copy.
import { db } from "../db.js";
import { routeMapFor } from "../api/routeMap.js";

/** Where one destination of one customer trunk goes today. */
export interface LiveRoute {
  vendorTrunkId: number;
  vendorEnterpriseId: number;
  vendorBillingType: string;
  /** Vendor cost per message, platform currency. */
  cost: number;
  ruleId: number;
  routeType: string;
  decidedBy: string;
}

const REFRESH_MS = 10 * 60_000;
const tables = new Map<number, { at: number; byCode: Map<string, LiveRoute> }>();
const queue: number[] = [];
const queued = new Set<number>();
let working = false;
let vendors: Map<number, { enterpriseId: number; billingType: string }> | null = null;

async function vendorInfo() {
  if (vendors) return vendors;
  const { rows } = await db().query("SELECT id, enterprise_id, billing_type FROM vendor_trunks");
  vendors = new Map(
    rows.map((r) => [Number(r.id), { enterpriseId: Number(r.enterprise_id), billingType: String(r.billing_type) }]),
  );
  return vendors;
}

async function work() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const trunkId = queue.shift()!;
      queued.delete(trunkId);
      try {
        const [rows, info] = await Promise.all([routeMapFor(db(), trunkId), vendorInfo()]);
        const byCode = new Map<string, LiveRoute>();
        for (const r of rows) {
          if (r.status !== "routed" || r.vendorTrunkId === null || r.vendorCost === null || r.ruleId === null) continue;
          const v = info.get(r.vendorTrunkId);
          byCode.set(r.mccmnc, {
            vendorTrunkId: r.vendorTrunkId,
            vendorEnterpriseId: v?.enterpriseId ?? 0,
            vendorBillingType: v?.billingType ?? "submit",
            cost: r.vendorCost,
            ruleId: r.ruleId,
            routeType: r.routeType ?? "static",
            decidedBy: r.decidedBy ?? "top_down",
          });
        }
        tables.set(trunkId, { at: Date.now(), byCode });
      } catch (err) {
        console.warn(`live routing for trunk ${trunkId}: ${(err as Error).message}`);
        tables.set(trunkId, { at: Date.now(), byCode: tables.get(trunkId)?.byCode ?? new Map() });
      }
    }
  } finally {
    working = false;
  }
}

/**
 * Today's route for a customer trunk and destination (its network code, else its country's code), or
 * undefined while the trunk's map is being computed or when nothing routes it. Asks for a (re)computation
 * when the map is missing or older than 10 minutes.
 */
export function liveRoute(trunkId: number, mccmnc: string, mcc: string): LiveRoute | undefined {
  const t = tables.get(trunkId);
  if ((!t || Date.now() - t.at > REFRESH_MS) && !queued.has(trunkId)) {
    queued.add(trunkId);
    queue.push(trunkId);
    void work();
  }
  return t?.byCode.get(mccmnc) ?? t?.byCode.get(mcc);
}

/** Rules or rates changed: every map is computed again on its next use. */
export function invalidateLiveRoutes() {
  for (const t of tables.values()) t.at = 0;
  vendors = null;
}
