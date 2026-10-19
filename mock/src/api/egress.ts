// Vendor skip on egress block (§6.3, §6.4, decided 2026-10-18): when the vendor routing picked has its own
// egress translation rules that block the message, that vendor is skipped and routing runs again without
// it, up to ten times. Shared by the rule Test, Simulate on Route rules and the Route simulator.
import type pg from "pg";
import type { EgressSkip, TrunkRulesTestInput } from "@sms/contract";
import type { MessageContext } from "../routing/evaluate.js";
import { runTrunkRules } from "./translationRules.js";

type Vendor = { vendorTrunkId: number; name: string } | null | undefined;

export async function skipEgressBlocked<T>(
  pool: pg.Pool,
  m: MessageContext,
  message: TrunkRulesTestInput["message"],
  run: (m: MessageContext) => T,
  vendorOf: (result: T) => Vendor,
): Promise<{ result: T; skipped: EgressSkip[] }> {
  let result = run(m);
  const skipped: EgressSkip[] = [];
  const blocked = new Set<number>();
  for (let i = 0; i < 10; i++) {
    const v = vendorOf(result);
    if (!v) break;
    const egress = await runTrunkRules(pool, "vendor", v.vendorTrunkId, message);
    if (!egress?.blocked) break;
    blocked.add(v.vendorTrunkId);
    skipped.push({ vendorTrunkId: v.vendorTrunkId, vendorTrunk: v.name, result: egress });
    result = run({ ...m, egressBlocked: blocked });
  }
  return { result, skipped };
}
