// Vendor skip on egress block (§6.3, §6.4, decided 2026-10-18): when the vendor routing picked has its own
// egress translation rules that block the message, that vendor is skipped and routing runs again without
// it, up to ten times. The same when its Sender ID line for the sender it would receive (after that translation) is
// blocked (§6.2, blocked means blocked, decided 2026-10-30), as in the switch's router. Shared by the rule Test,
// Simulate on Route rules and the Route simulator.
import type pg from "pg";
import type { EgressSkip, TrunkRulesTestInput } from "@sms/contract";
import type { MessageContext } from "../routing/evaluate.js";
import { runTrunkRules } from "./translationRules.js";
import { vendorPrice } from "./linePrice.js";

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
  const rateBlocked = new Set<number>();
  for (let i = 0; i < 10; i++) {
    const v = vendorOf(result);
    if (!v) break;
    const egress = await runTrunkRules(pool, "vendor", v.vendorTrunkId, message);
    if (egress?.blocked) {
      blocked.add(v.vendorTrunkId);
      skipped.push({ vendorTrunkId: v.vendorTrunkId, vendorTrunk: v.name, result: egress });
    } else if (
      m.mccmnc &&
      (await vendorPrice(pool, v.vendorTrunkId, m.mccmnc, egress?.after.sender ?? message.sender)) === "blocked"
    ) {
      rateBlocked.add(v.vendorTrunkId);
    } else break;
    result = run({ ...m, egressBlocked: blocked, rateBlocked });
  }
  return { result, skipped };
}
