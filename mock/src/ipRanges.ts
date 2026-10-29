// Allowed client addresses of a customer trunk (§5.4, team trial round 9): an address (192.0.2.10, 2001:db8::1), a
// network (192.0.2.0/24 or 192.0.2.0/255.255.255.0) or a range (192.0.2.10-192.0.2.50, or 192.0.2.10-50 for the last
// part). They are stored as PostgreSQL inet[] and matched by the switch as networks (Sms.Switch.Customer.IpRange), so a range is saved as the
// networks that cover exactly it: 192.0.2.10-192.0.2.13 becomes 192.0.2.10/31 and 192.0.2.12/31.
import { isIP } from "node:net";

/** The most networks one range may become (a range of IPv4 addresses needs at most 62). */
export const MAX_RANGE_NETWORKS = 64;

interface Addr {
  v: 4 | 6;
  n: bigint;
}

const bitsOf = (v: 4 | 6) => (v === 4 ? 32 : 128);

function parseAddr(text: string): Addr | null {
  const t = text.trim();
  const v = isIP(t);
  if (v === 4) return { v: 4, n: t.split(".").reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n) };
  if (v !== 6) return null;
  // An IPv4 tail (::ffff:192.0.2.1) as two groups.
  let s = t.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const four = parseAddr(tail[1]!)!.n;
    s = `${s.slice(0, -tail[1]!.length)}${(four >> 16n).toString(16)}:${(four & 0xffffn).toString(16)}`;
  }
  const [head = "", rest] = s.split("::");
  const left = head ? head.split(":") : [];
  const right = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

function formatAddr(a: Addr): string {
  if (a.v === 4) return [24n, 16n, 8n, 0n].map((s) => String((a.n >> s) & 0xffn)).join(".");
  const groups = Array.from({ length: 8 }, (_, i) => ((a.n >> BigInt(112 - i * 16)) & 0xffffn).toString(16));
  // The longest run of zero groups as "::".
  let best = { at: -1, len: 1 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  if (best.at < 0) return groups.join(":");
  return `${groups.slice(0, best.at).join(":")}::${groups.slice(best.at + best.len).join(":")}`;
}

const network = (a: Addr, prefix: number): string =>
  prefix === bitsOf(a.v) ? formatAddr(a) : `${formatAddr(a)}/${prefix}`;

/** A dotted IPv4 mask (255.255.255.0) as its prefix length (24); NaN when its ones are not contiguous. */
function maskPrefix(text: string): number {
  const m = parseAddr(text);
  if (!m || m.v !== 4) return NaN;
  const ones = m.n.toString(2).padStart(32, "0");
  return /^1*0*$/.test(ones) ? ones.indexOf("0") < 0 ? 32 : ones.indexOf("0") : NaN;
}

/** The fewest networks covering exactly lo..hi. */
function cover(v: 4 | 6, lo: bigint, hi: bigint): string[] {
  const bits = bitsOf(v);
  const out: string[] = [];
  let at = lo;
  while (at <= hi && out.length <= MAX_RANGE_NETWORKS) {
    // The largest block that starts at `at` (aligned) and ends inside the range.
    let size = 0;
    while (size < bits && (at & ((1n << BigInt(size + 1)) - 1n)) === 0n && at + (1n << BigInt(size + 1)) - 1n <= hi)
      size++;
    out.push(network({ v, n: at }, bits - size));
    at += 1n << BigInt(size);
  }
  return out;
}

/** One typed entry as stored networks, or why it is not an address, network or range. */
export function hostEntry(text: string): { networks: string[] } | { error: string } {
  const t = text.trim();
  const slash = t.split("/");
  if (slash.length === 2) {
    const a = parseAddr(slash[0]!);
    const prefix = /^\d{1,3}$/.test(slash[1]!.trim()) ? Number(slash[1]) : a?.v === 4 ? maskPrefix(slash[1]!) : NaN;
    if (!a || !(prefix >= 0 && prefix <= bitsOf(a.v)))
      return { error: "not a network (e.g. 192.0.2.0/24 or 192.0.2.0/255.255.255.0)" };
    // The network's own address: 192.0.2.7/24 is saved as 192.0.2.0/24.
    const host = BigInt(bitsOf(a.v) - prefix);
    return { networks: [network({ v: a.v, n: (a.n >> host) << host }, prefix)] };
  }
  const dash = t.split("-");
  if (dash.length === 2) {
    const lo = parseAddr(dash[0]!);
    let hi = parseAddr(dash[1]!);
    // 192.0.2.10-50: the last part only.
    if (!hi && lo?.v === 4 && /^\d{1,3}$/.test(dash[1]!.trim()) && Number(dash[1]) <= 255)
      hi = { v: 4, n: (lo.n & ~0xffn) | BigInt(Number(dash[1])) };
    if (!lo || !hi || lo.v !== hi.v) return { error: "not a range (e.g. 192.0.2.10-192.0.2.50)" };
    if (hi.n < lo.n) return { error: "the range ends before it starts" };
    const networks = cover(lo.v, lo.n, hi.n);
    if (networks.length > MAX_RANGE_NETWORKS) return { error: "split this range in smaller ones" };
    return { networks };
  }
  const a = parseAddr(t);
  return a ? { networks: [formatAddr(a)] } : { error: "not an IP address, network or range" };
}

/** Every typed entry as stored networks, without repeats; errors by the entry's index. */
export function hostNetworks(entries: string[]): { networks: string[]; errors: { index: number; message: string }[] } {
  const networks: string[] = [];
  const errors: { index: number; message: string }[] = [];
  entries.forEach((e, index) => {
    const r = hostEntry(e);
    if ("error" in r) errors.push({ index, message: r.error });
    else for (const n of r.networks) if (!networks.includes(n)) networks.push(n);
  });
  return { networks, errors };
}

/** SQL: an inet as typed back: a single address without its /32 or /128, a network with its prefix. */
export const inetText = (x: string) =>
  `CASE WHEN masklen(${x}) = CASE family(${x}) WHEN 4 THEN 32 ELSE 128 END THEN host(${x}) ELSE text(${x}) END`;
