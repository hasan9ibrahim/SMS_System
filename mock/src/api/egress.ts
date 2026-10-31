// Vendor skip on egress block (§6.3, §6.4, decided 2026-10-18): when the vendor routing picked has its own
// egress translation rules that block the message, that vendor is skipped and routing runs again without
// it, up to ten times. The same when its Sender ID line for the sender it would receive (after that translation) is
// blocked (§6.2, blocked means blocked, decided 2026-10-30), and when it cannot take the message as it would get it
// (§5.5 capability filter: sender, TON / NPI, data coding, multipart, Max Msg Len; S-3.9, S-4.4, S-4.7), as in the
// switch's router. A vendor trunk set to auto TON / NPI gets them fixed after its egress translation (S-4.7), and any
// vendor gets the single equivalent TON / NPI its allowed lists take instead of being passed over (fitTonNpi): its
// price, sender check and capability filter use the values it gets. A sender it refuses (Refuse invalid senders) passes
// it over; when every vendor passed over refused the sender, the switch refuses the message 0x0A (`senderOnly`).
// Shared by the rule Test, Simulate on Route rules and the Route simulator.
import type pg from "pg";
import type { EgressSkip, TrunkRulesTestInput, TrunkRulesTestResult } from "@sms/contract";
import type { MessageContext } from "../routing/evaluate.js";
import { incapable, refusedSender, type MessageForm, type VendorCapabilities } from "../routing/coding.js";
import { fitTonNpi, withTonNpiMode, type Addresses, type TonNpiField, type TonNpiMode } from "../routing/tonNpi.js";
import { runTrunkTranslation } from "./translationRules.js";
import { vendorPrice } from "./linePrice.js";

type Vendor = { vendorTrunkId: number; name: string } | null | undefined;

/** TON / NPI as the message has them before the vendor's egress translation; null or left out = not given. */
export interface TonNpiValues {
  senderTon?: number | null;
  senderNpi?: number | null;
  destTon?: number | null;
  destNpi?: number | null;
}

/** What the capability filter looks at besides the vendor's egress result (routing/coding.ts). */
export interface CapabilityInput extends TonNpiValues {
  /** The message as the customer sent it: text and data_coding (and the trunk's Default Coding). */
  form: MessageForm;
  /** The TON / NPI fields the customer trunk's ingress rules set: they win over a vendor's auto TON / NPI (S-4.7). */
  pinned?: ReadonlySet<TonNpiField>;
}

/** A vendor trunk's capability filter (§5.5), its TON / NPI mode and whether it refuses invalid senders (S-4.7). */
export async function vendorCapabilities(
  pool: pg.Pool,
  vendorTrunkId: number,
): Promise<(VendorCapabilities & { tonNpiMode: TonNpiMode }) | null> {
  const { rows } = await pool.query(
    `SELECT allowed_data_codings, allowed_src_ton, allowed_src_npi, allowed_dst_ton, allowed_dst_npi, max_msg_len,
            support_multipart, ton_npi_mode, refuse_invalid_senders FROM vendor_trunks WHERE id = $1`,
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
    refuseInvalidSenders: r.refuse_invalid_senders !== false,
    tonNpiMode: r.ton_npi_mode === "auto" ? "auto" : "as_sent",
  };
}

/**
 * What a vendor would get (switch router.ex egress/2): the message after its egress translation, the TON / NPI its
 * rules do not set as `asSent` has them, then fixed when the vendor is set to auto (S-4.7); a field a translation
 * rule set (`pinned`: the ingress rules', plus this vendor's own) stays as the rule left it. Then, where its allowed
 * lists do not take the values, the single equivalent they take (fitTonNpi).
 */
export async function vendorView(
  pool: pg.Pool,
  vendorTrunkId: number,
  message: TrunkRulesTestInput["message"],
  asSent: TonNpiValues = {},
  pinned: ReadonlySet<TonNpiField> = new Set(),
): Promise<{
  egress: TrunkRulesTestResult | null;
  caps: Awaited<ReturnType<typeof vendorCapabilities>>;
  got: Addresses & { text: string };
}> {
  const [t, caps] = await Promise.all([
    runTrunkTranslation(pool, "vendor", vendorTrunkId, message),
    vendorCapabilities(pool, vendorTrunkId),
  ]);
  const egress = t?.result ?? null;
  const after = egress?.after;
  const fixed = withTonNpiMode(
    caps?.tonNpiMode,
    {
      sender: after?.sender ?? message.sender,
      receiver: after?.receiver ?? message.receiver,
      text: after?.text ?? message.text,
      senderTon: after?.senderTon ?? asSent.senderTon ?? null,
      senderNpi: after?.senderNpi ?? asSent.senderNpi ?? null,
      destTon: after?.destTon ?? asSent.destTon ?? null,
      destNpi: after?.destNpi ?? asSent.destNpi ?? null,
    },
    new Set([...pinned, ...(t?.pinned ?? [])]),
  );
  return { egress, caps, got: caps ? fitTonNpi(fixed, caps) : fixed };
}

export async function skipEgressBlocked<T>(
  pool: pg.Pool,
  m: MessageContext,
  message: TrunkRulesTestInput["message"],
  run: (m: MessageContext) => T,
  vendorOf: (result: T) => Vendor,
  capability: CapabilityInput | null = null,
): Promise<{ result: T; skipped: EgressSkip[]; senderOnly: boolean }> {
  let result = run(m);
  const skipped: EgressSkip[] = [];
  const blocked = new Set<number>();
  const rateBlocked = new Set<number>();
  const cannot = new Map<number, string>();
  // The vendors passed over for their sender (S-4.7): when they are all there were, the message is refused 0x0A.
  const forSender = new Set<number>();
  for (let i = 0; i < 10; i++) {
    const v = vendorOf(result);
    if (!v) break;
    const { egress, caps, got } = await vendorView(
      pool,
      v.vendorTrunkId,
      message,
      capability ?? {},
      capability?.pinned,
    );
    if (egress?.blocked) {
      blocked.add(v.vendorTrunkId);
      skipped.push({ vendorTrunkId: v.vendorTrunkId, vendorTrunk: v.name, result: egress });
    } else if (m.mccmnc && (await vendorPrice(pool, v.vendorTrunkId, m.mccmnc, got.sender)) === "blocked") {
      rateBlocked.add(v.vendorTrunkId);
    } else {
      // The values the vendor gets: its egress translation's when it sets them, else as sent; fixed when it is set
      // to auto (S-4.7).
      const msg = {
        form: capability?.form ?? { text: got.text, dataCoding: 0 },
        text: got.text,
        sender: got.sender,
        senderTon: got.senderTon,
        senderNpi: got.senderNpi,
        destTon: got.destTon,
        destNpi: got.destNpi,
      };
      const why = caps && capability ? incapable(caps, msg) : null;
      if (!why) break;
      cannot.set(v.vendorTrunkId, why);
      if (why === refusedSender(caps!, msg)) forSender.add(v.vendorTrunkId);
    }
    result = run({ ...m, egressBlocked: blocked, rateBlocked, incapable: cannot });
  }
  const senderOnly = forSender.size > 0 && forSender.size === cannot.size && !blocked.size && !rateBlocked.size;
  return { result, skipped, senderOnly };
}
