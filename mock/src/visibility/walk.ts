// Backstop for names outside the list engine (§13.17): record details, lookups and reports answer with
// pairs such as enterpriseId + enterpriseName or vendorTrunkId + vendorTrunk. For a viewer whose policy
// masks others, those names are replaced by neutral IDs before the answer is sent, so the same ID
// appears everywhere. Lists are masked in SQL (lists/engine.ts), which this repeats harmlessly.
import { db } from "../db.js";
import type { Viewer } from "./policy.js";

interface Maps {
  at: number;
  type: Map<number, string>;
  customerTrunk: Map<number, number>;
  vendorTrunk: Map<number, number>;
}
let maps: Promise<Maps> | null = null;
let mapsAt = 0;

function loadMaps(): Promise<Maps> {
  if (maps && Date.now() - mapsAt < 60_000) return maps;
  mapsAt = Date.now();
  maps = (async () => {
    const pool = db();
    const [e, c, v] = await Promise.all([
      pool.query("SELECT id, type FROM enterprises"),
      pool.query("SELECT id, enterprise_id FROM customer_trunks"),
      pool.query("SELECT id, enterprise_id FROM vendor_trunks"),
    ]);
    return {
      at: Date.now(),
      type: new Map(e.rows.map((r) => [Number(r.id), r.type as string])),
      customerTrunk: new Map(c.rows.map((r) => [Number(r.id), Number(r.enterprise_id)])),
      vendorTrunk: new Map(v.rows.map((r) => [Number(r.id), Number(r.enterprise_id)])),
    };
  })().catch((err) => {
    maps = null;
    throw err;
  });
  return maps;
}

const LABEL: Record<string, string> = { customer: "Customer", vendor: "Vendor" };
/** id key → the name keys next to it, and how to find the owning enterprise. */
const PAIRS: {
  id: string;
  names: string[];
  kind: "enterprise" | "customerTrunk" | "vendorTrunk";
  vendorName?: string[];
}[] = [
  { id: "enterpriseId", names: ["enterpriseName", "enterprise"], kind: "enterprise" },
  { id: "customerEnterpriseId", names: ["customerName", "customerEnterprise"], kind: "enterprise" },
  { id: "vendorEnterpriseId", names: ["vendorName", "vendorEnterprise"], kind: "enterprise" },
  {
    id: "customerTrunkId",
    names: ["customerTrunkName", "customerTrunk"],
    kind: "customerTrunk",
    vendorName: ["customer", "enterprise"],
  },
  {
    id: "vendorTrunkId",
    names: ["vendorTrunkName", "vendorTrunk"],
    kind: "vendorTrunk",
    vendorName: ["vendor", "vendorName"],
  },
  { id: "routedVendorTrunkId", names: ["routedVendor"], kind: "vendorTrunk" },
];

export async function maskPayload(payload: unknown, v: Viewer): Promise<unknown> {
  if (payload === null || typeof payload !== "object") return payload;
  const m = await loadMaps();
  const own = new Set(v.own);
  const enterpriseLabel = (id: number) => `${LABEL[m.type.get(id) ?? ""] ?? "Enterprise"} #${id}`;
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number) => {
    if (node === null || typeof node !== "object" || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    for (const p of PAIRS) {
      const id = o[p.id];
      if (typeof id !== "number") continue;
      const enterprise =
        p.kind === "enterprise" ? id : (p.kind === "customerTrunk" ? m.customerTrunk : m.vendorTrunk).get(id);
      if (enterprise === undefined || own.has(enterprise)) continue;
      const label =
        p.kind === "enterprise"
          ? enterpriseLabel(id)
          : `${p.kind === "customerTrunk" ? "Customer" : "Vendor"} trunk #${id}`;
      for (const k of p.names) if (typeof o[k] === "string") o[k] = label;
      // The enterprise name next to a trunk ID ("vendor" beside vendorTrunkId).
      for (const k of p.vendorName ?? [])
        if (typeof o[k] === "string" && !(`${k}Id` in o)) o[k] = enterpriseLabel(enterprise);
    }
    for (const x of Object.values(o)) if (x !== null && typeof x === "object") walk(x, depth + 1);
  };
  walk(payload, 0);
  return payload;
}
