// Automatic TON / NPI after translation (docs/SMPP_SCENARIOS.md S-4.7, contract TonNpiMode), as the switch sets it
// (backend/apps/sms_switch/lib/sms/switch/message/address.ex auto/2), for the Route Simulator, the rule Test and
// Simulate. A trunk set to auto takes TON / NPI from the address as it stands after its translation (ingress on a
// customer trunk, egress on a vendor trunk); as_sent keeps them as the message has them.
//   * source: + then digits → the + taken off, TON 1 / NPI 1; 9 or more digits → TON 1 / NPI 1; 3-8 digits (a short
//     code) → TON 3 / NPI 0; anything else but 1-2 digits (alphanumeric) → TON 5 / NPI 0. Auto cannot fix a length
//     or characters: an alphanumeric sender is still at most 11 printable ASCII characters (senderProblem).
//   * destination: a full international number (8-15 digits, an optional leading + taken off) → TON 1 / NPI 1;
//     anything else as it is.
//   * a translation rule that sets Sender or Destination TON / NPI wins over auto for that field; the + stays on an
//     address whose TON a rule set.
// Whatever the mode, a TON / NPI a vendor's allowed lists do not take is replaced by the single equivalent they take
// (fitTonNpi, address.ex fit/2) before the vendor is passed over. Which senders a vendor refuses: senderRefusal.

export type TonNpiMode = "as_sent" | "auto";
export type TonNpiField = "senderTon" | "senderNpi" | "destTon" | "destNpi";

/** The addresses and TON / NPI a message goes with; null = not given. */
export interface Addresses {
  sender: string;
  receiver: string;
  senderTon: number | null;
  senderNpi: number | null;
  destTon: number | null;
  destNpi: number | null;
}

const fixSource = (sender: string): [string, number, number] | null => {
  if (/^\+[0-9]+$/.test(sender)) return [sender.slice(1), 1, 1];
  if (/^[0-9]{9,}$/.test(sender)) return [sender, 1, 1];
  if (/^[0-9]{3,8}$/.test(sender)) return [sender, 3, 0];
  if (sender === "" || /^[0-9]+$/.test(sender)) return null;
  return [sender, 5, 0];
};

const fixDestination = (receiver: string): [string, number, number] | null =>
  /^\+?[0-9]{8,15}$/.test(receiver) ? [receiver.replace(/^\+/, ""), 1, 1] : null;

/** The addresses as a trunk set to auto sends them; `pinned`: the fields a translation rule set, which stay. */
export function autoTonNpi<T extends Addresses>(a: T, pinned: ReadonlySet<TonNpiField> = new Set()): T {
  const out = { ...a };
  const src = fixSource(a.sender);
  if (src) {
    if (!pinned.has("senderTon")) [out.sender, out.senderTon] = [src[0], src[1]];
    if (!pinned.has("senderNpi")) out.senderNpi = src[2];
  }
  const dst = fixDestination(a.receiver);
  if (dst) {
    if (!pinned.has("destTon")) [out.receiver, out.destTon] = [dst[0], dst[1]];
    if (!pinned.has("destNpi")) out.destNpi = dst[2];
  }
  return out;
}

/** A vendor trunk's allowed TON / NPI lists; null = any. */
export interface TonNpiLists {
  allowedSrcTon: number[] | null;
  allowedSrcNpi: number[] | null;
  allowedDstTon: number[] | null;
  allowedDstNpi: number[] | null;
}

const takes = (list: number[] | null, value: number | null) => list === null || value === null || list.includes(value);

/**
 * The addresses with the single unambiguous equivalent TON / NPI a vendor's allowed lists take, where they do not take
 * the values it has (S-4.7, whatever the TON / NPI mode; switch address.ex fit/2): an alphanumeric sender 5 / 0, an
 * international one (9 or more digits, or + then digits, the + taken off) 1 / 1, a full international destination
 * 1 / 1. A short code has no single equivalent. A value not given (null) is not checked.
 */
export function fitTonNpi<T extends Addresses>(a: T, lists: TonNpiLists): T {
  const out = { ...a };
  const src = fixSource(a.sender);
  if (
    src &&
    src[1] !== 3 &&
    !(takes(lists.allowedSrcTon, a.senderTon) && takes(lists.allowedSrcNpi, a.senderNpi)) &&
    takes(lists.allowedSrcTon, src[1]) &&
    takes(lists.allowedSrcNpi, src[2])
  )
    [out.sender, out.senderTon, out.senderNpi] = src;
  const dst = fixDestination(a.receiver);
  if (
    dst &&
    !(takes(lists.allowedDstTon, a.destTon) && takes(lists.allowedDstNpi, a.destNpi)) &&
    takes(lists.allowedDstTon, dst[1]) &&
    takes(lists.allowedDstNpi, dst[2])
  )
    [out.receiver, out.destTon, out.destNpi] = dst;
  return out;
}

/** `a` as a trunk in `mode` sends it. */
export const withTonNpiMode = <T extends Addresses>(
  mode: TonNpiMode | null | undefined,
  a: T,
  pinned?: ReadonlySet<TonNpiField>,
): T => (mode === "auto" ? autoTonNpi(a, pinned) : a);

/** The TON / NPI fields the rules that applied in a translation run set (a match that did not block). */
export function pinnedBy(
  rules: readonly {
    id: number;
    senderTon: number | null;
    senderNpi: number | null;
    destTon: number | null;
    destNpi: number | null;
  }[],
  steps: readonly { ruleId: number; matched: boolean; blocked: boolean }[],
): Set<TonNpiField> {
  const applied = new Set(steps.filter((s) => s.matched && !s.blocked).map((s) => s.ruleId));
  const out = new Set<TonNpiField>();
  for (const r of rules)
    if (applied.has(r.id))
      for (const f of ["senderTon", "senderNpi", "destTon", "destNpi"] as const) if (r[f] !== null) out.add(f);
  return out;
}

/**
 * A sender SMPP cannot carry, whatever the vendor (switch address.ex protocol_problem/3, refused at intake): a TON or
 * NPI SMPP does not define (null or left out: 0), or no sender.
 */
export function senderProtocolProblem(
  sender: string,
  ton: number | null | undefined,
  npi: number | null | undefined,
): string | null {
  const t = ton ?? 0;
  const n = npi ?? 0;
  if (!Number.isInteger(t) || t < 0 || t > 6) return `source TON ${t} is not an SMPP type of number`;
  if (![0, 1, 3, 4, 6, 8, 9, 10, 14, 18].includes(n)) return `source NPI ${n} is not an SMPP numbering plan`;
  if (sender === "") return "there is no sender";
  return null;
}

/**
 * A sender a handset cannot show (a vendor trunk's Refuse invalid senders; address.ex handset_problem/2): a numeric
 * one over 20 digits, an alphanumeric one (or any with TON 5) over 11 characters or not printable ASCII.
 */
export function senderHandsetProblem(sender: string, ton: number | null | undefined): string | null {
  if (sender === "") return null;
  if (ton !== 5 && /^\+?[0-9]+$/.test(sender))
    return sender.replace(/^\+/, "").length > 20 ? `the sender ${sender} is longer than 20 digits` : null;
  if ([...sender].length > 11) return `the sender ${JSON.stringify(sender)} is longer than 11 characters`;
  if (!/^[\x20-\x7E]+$/.test(sender)) return `the sender ${JSON.stringify(sender)} is not printable ASCII`;
  return null;
}

/** Both checks: why a sender cannot go to a vendor that refuses invalid senders, or null (address.ex source_problem/3). */
export const senderProblem = (
  sender: string,
  ton: number | null | undefined,
  npi: number | null | undefined,
): string | null => senderProtocolProblem(sender, ton, npi) ?? senderHandsetProblem(sender, ton);

/**
 * Why a vendor refuses a sender, or null (switch router.ex refuses_sender?/4, S-2.10, S-4.7): one SMPP cannot carry
 * or longer than the 20 characters a source_addr holds, always; one a handset cannot show, unless the vendor trunk's
 * Refuse invalid senders is off.
 */
export function senderRefusal(
  sender: string,
  ton: number | null | undefined,
  npi: number | null | undefined,
  refuseInvalidSenders = true,
): string | null {
  return (
    senderProtocolProblem(sender, ton, npi) ??
    (Buffer.byteLength(sender, "utf8") > 20
      ? `the sender ${JSON.stringify(sender)} is longer than 20 characters`
      : null) ??
    (refuseInvalidSenders ? senderHandsetProblem(sender, ton) : null)
  );
}
