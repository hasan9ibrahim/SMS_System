// Vendor skip on egress block (§6.3, §6.4, decided 2026-10-18): when the vendor routing picked has its own
// egress translation rules that block the message, that vendor is skipped and routing runs again without
// it, up to ten times. The same when its Sender ID line for the sender it would receive (after that translation) is
// blocked (§6.2, blocked means blocked, decided 2026-10-30), and when it cannot take the message as it would get it
// (§5.5 capability filter: TON / NPI, data coding, multipart, Max Msg Len; S-3.9, S-4.4), as in the switch's router.
// Shared by the rule Test, Simulate on Route rules and the Route simulator.
import type pg from "pg";
import type { EgressSkip, TrunkRulesTestInput } from "@sms/contract";
import type { MessageContext } from "../routing/evaluate.js";
import { incapable, type MessageForm, type VendorCapabilities } from "../routing/coding.js";
import { runTrunkRules } from "./translationRules.js";
import { vendorPrice } from "./linePrice.js";

type Vendor = { vendorTrunkId: number; name: string } | null | undefined;

/** What the capability filter looks at besides the vendor's egress result (routing/coding.ts). */
export interface CapabilityInput {
  /** The message as the customer sent it: text and data_coding (and the trunk's Default Coding). */
  form: MessageForm;
  /** TON / NPI as sent; null or left out = not given, so not checked (the rule Test and Simulate have none). */
  senderTon?: number | null;
  senderNpi?: number | null;
  destTon?: number | null;
  destNpi?: number | null;
}

/** A vendor trunk's capability filter (§5.5). */
export async function vendorCapabilities(pool: pg.Pool, vendorTrunkId: number): Promise<VendorCapabilities | null> {
  const { rows } = await pool.query(
    `SELECT allowed_data_codings, allowed_src_ton, allowed_src_npi, allowed_dst_ton, allowed_dst_npi, max_msg_len,
            support_multipart FROM vendor_trunks WHERE id = $1`,
    [vendorTrunkId],
  );
  const r = rows[0];
  if (!r) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(Number) : null);
  return {
    allowedDataCodings: list(r.allowed_data_codings),
    allowedSrcTon: list(r.allowed_src_ton),
    allowedSrcNpi: list(r.allowed_src_npi),
    allowedDstTon: list(r.allowed_dst_ton),
    allowedDstNpi: list(r.allowed_dst_npi),
    maxMsgLen: r.max_msg_len === null ? null : Number(r.max_msg_len),
    supportMultipart: r.support_multipart !== false,
  };
}

export async function skipEgressBlocked<T>(
  pool: pg.Pool,
  m: MessageContext,
  message: TrunkRulesTestInput["message"],
  run: (m: MessageContext) => T,
  vendorOf: (result: T) => Vendor,
  capability: CapabilityInput | null = null,
): Promise<{ result: T; skipped: EgressSkip[] }> {
  let result = run(m);
  const skipped: EgressSkip[] = [];
  const blocked = new Set<number>();
  const rateBlocked = new Set<number>();
  const cannot = new Map<number, string>();
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
    } else {
      const caps = capability ? await vendorCapabilities(pool, v.vendorTrunkId) : null;
      // The values the vendor gets: its egress translation's when it sets them, else as sent.
      const why =
        caps && capability
          ? incapable(caps, {
              form: capability.form,
              text: egress?.after.text ?? message.text,
              senderTon: egress?.after.senderTon ?? capability.senderTon,
              senderNpi: egress?.after.senderNpi ?? capability.senderNpi,
              destTon: egress?.after.destTon ?? capability.destTon,
              destNpi: egress?.after.destNpi ?? capability.destNpi,
            })
          : null;
      if (!why) break;
      cannot.set(v.vendorTrunkId, why);
    }
    result = run({ ...m, egressBlocked: blocked, rateBlocked, incapable: cannot });
  }
  return { result, skipped };
}
