/**
 * EDR generator (spec §9.1). Produces message attempts over the last N days that
 * follow the generated configuration:
 *   customer trunk (weighted by client size) -> destination from its rate tables
 *   -> customer rate valid at send time (sender-specific line, then MCCMNC, then
 *   country "All networks") -> route rule by priority (§6.3, §13.8, §13.27)
 *   -> vendor and vendor rate valid at send time -> submit / receipt outcome from
 *   the vendor's quality, with re-route attempts -> billing flags per billing type.
 * Rates, costs and the AM of both sides are copied into the row at send time
 * (§13.29, §13.30). Rows are emitted in time order as ClickHouse TabSeparated.
 */
import { WeightedPicker, type Rng } from "./rng.js";
import { buildCoverage } from "./rules.js";
import { messageText } from "./names.js";
import {
  allNetworksCodeOf,
  amAt,
  fxPerUsd,
  versionAt,
  DAY,
  HOUR,
  type CustomerTrunk,
  type Mccmnc,
  type RateVersion,
  type RouteRule,
  type VendorTrunk,
  type World,
} from "./world.js";

export const EDR_COLUMNS = [
  "edr_id",
  "start_time",
  "submit_time",
  "submit_resp_time",
  "delivery_time",
  "msg_type",
  "business_company_id",
  "product_category_id",
  "c_enterprise_id",
  "c_trunk_id",
  "c_am_user_id",
  "c_ip",
  "c_port",
  "c_session_id",
  "c_bind_type",
  "c_protocol",
  "c_message_id",
  "c_src_ton",
  "c_src_npi",
  "c_dst_ton",
  "c_dst_npi",
  "c_coding",
  "src_addr",
  "dst_addr",
  "routed_dst_addr",
  "message_text",
  "c_mccmnc",
  "c_mcc",
  "c_mnc",
  "c_country_iso",
  "c_billing_type",
  "c_rate_table_id",
  "c_rate_line_id",
  "c_rate",
  "c_currency",
  "c_ex_rate",
  "c_sys_rate",
  "c_translation_rule_ids",
  "c_msg_status",
  "receipt_session_id",
  "receipt_held_ms",
  "v_enterprise_id",
  "v_trunk_id",
  "v_am_user_id",
  "v_ip",
  "v_port",
  "v_message_id",
  "v_mccmnc",
  "v_billing_type",
  "v_rate_table_id",
  "v_rate_line_id",
  "v_rate",
  "v_currency",
  "v_ex_rate",
  "v_sys_rate",
  "v_translation_rule_ids",
  "route_rule_id",
  "route_rule_group_id",
  "route_type",
  "route_level",
  "route_decided_by",
  "measured_tps",
  "revenue_checked",
  "dlr_reroute",
  "repush_request_id",
  "attempt_no",
  "is_final_attempt",
  "is_submit_success",
  "command_status",
  "msg_status",
  "delivery_error",
  "network_error",
  "registered_delivery",
  "msg_count",
  "udh",
  "delivery_delay_ms",
  "is_buffered",
  "is_customer_billable",
  "is_vendor_billable",
  "revenue",
  "cost",
  "revenue_sys",
  "cost_sys",
  "hlr_provider_id",
  "hlr_fetch_type",
  "hlr_is_ported",
  "hlr_is_accomplished",
  "hlr_error_code",
  "hlr_cost_sys",
  "v_src_addr",
] as const;

export interface EdrWriter {
  write(chunk: string, rows: number): Promise<void>;
  close(): Promise<void>;
}

export interface EdrOptions {
  count: number;
  days: number;
  chunkRows?: number;
  onProgress?: (done: number, total: number) => void;
}

const SUBMIT_ERRORS = [8, 88, 69, 11, 20];
const SUBMIT_ERROR_WEIGHTS = [30, 25, 20, 15, 10];
const FAIL_STATS = ["UNDELIV", "EXPIRED", "REJECTD", "UNKNOWN", "DELETED"];
const FAIL_STAT_WEIGHTS = [50, 25, 13, 10, 2];
const FAIL_ERR: Record<string, string> = {
  UNDELIV: "001",
  EXPIRED: "002",
  REJECTD: "003",
  UNKNOWN: "000",
  DELETED: "004",
};

const NULL = "\\N";
const esc = (s: string) =>
  /[\t\n\\]/.test(s) ? s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n") : s;
// DateTime64(3) text 'YYYY-MM-DD hh:mm:ss.sss'; the date part is cached per day (hot path).
let dtDay = -1;
let dtDayStr = "";
const p2 = (n: number) => (n < 10 ? "0" + n : String(n));
const dt = (t: number) => {
  const day = Math.floor(t / DAY);
  if (day !== dtDay) {
    dtDay = day;
    dtDayStr = new Date(day * DAY).toISOString().slice(0, 10);
  }
  const ms = t - day * DAY;
  const msPart = ms % 1000;
  const sec = Math.floor(ms / 1000);
  return `${dtDayStr} ${p2(Math.floor(sec / 3600))}:${p2(Math.floor(sec / 60) % 60)}:${p2(sec % 60)}.${msPart < 10 ? "00" : msPart < 100 ? "0" : ""}${msPart}`;
};
const dec = (x: number) => x.toFixed(6);
/**
 * The Sender ID sent to the vendor (team trial round 2): vendor trunks with egress translation rules turn numeric
 * Sender IDs into the trunk's own short number, like the "Random numeric sender" / template rules; others pass the
 * customer's Sender ID on unchanged. Deterministic (no random draws), so the EDR stream stays as before.
 */
const vendorSender = (sender: string, v: { id: number; translationRuleIds: number[] }) =>
  v.translationRuleIds.length && /^\+?[0-9]+$/.test(sender) ? String(10000 + ((v.id * 7919) % 90000)) : sender;
const dec8 = (x: number) => x.toFixed(8);

/** Diurnal shape of A2P traffic (UTC hour), weekday factor and slow growth. */
function bucketWeight(t: number, start: number): number {
  const d = new Date(t);
  const h = d.getUTCHours();
  const diurnal =
    0.35 + 0.65 * Math.max(0, Math.sin(((h - 3) / 24) * 2 * Math.PI)) ** 1.5 + (h >= 6 && h <= 18 ? 0.25 : 0);
  const dow = d.getUTCDay();
  const week = dow === 0 || dow === 6 ? 0.78 : 1;
  const growth = 1 + 0.005 * ((t - start) / DAY);
  return diurnal * week * growth;
}

/** Stable pseudo-random in [0,1) from two integers, for per vendor/destination quality offsets. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

interface Routed {
  vendor: VendorTrunk;
  version: RateVersion;
  rule: RouteRule | null;
  level: number;
  decidedBy: string;
}

export async function generateEdrs(world: World, rng: Rng, writer: EdrWriter, opts: EdrOptions): Promise<number> {
  const end = world.anchor;
  const start = end - opts.days * DAY;
  const chunkRows = opts.chunkRows ?? 50_000;
  const coverage = buildCoverage(world);
  const bcBase = new Map(world.businessCompanies.map((b) => [b.id, b.baseCurrency]));
  // Country "All networks" fallback key; '' (never a key) when the MCC belongs to another country.
  const allCode = (m: Mccmnc) => allNetworksCodeOf(world, m) ?? "";

  // ---- customer trunks with traffic ----
  const trunks = world.customerTrunks.filter(
    (t) => t.rateTableIds.length > 0 && (t.status === "active" || t.deletedAt),
  );
  const trunkPicker = new WeightedPicker(
    trunks,
    trunks.map((t) => world.enterpriseById.get(t.enterpriseId)!.size * t.share),
  );
  const destPickers = new Map<number, WeightedPicker<Mccmnc>>();
  const destPickerFor = (t: CustomerTrunk) => {
    let p = destPickers.get(t.id);
    if (p) return p;
    const nets = new Map<number, Mccmnc>();
    for (const tid of t.rateTableIds) {
      for (const key of world.rateTableById.get(tid)!.lines.keys()) {
        if (key.includes("|")) continue;
        const m = world.mccmncByCode.get(key)!;
        if (!m.isAllNetworks) nets.set(m.id, m);
        else
          for (const id of world.countryById.get(m.countryId)!.mccmncIds) {
            const n = world.mccmncById.get(id)!;
            if (n.mcc === m.mcc) nets.set(n.id, n);
          }
      }
    }
    const focus = new Set(t.focusCountryIds);
    const list = [...nets.values()];
    p = new WeightedPicker(
      list,
      list.map((m) => {
        const c = world.countryById.get(m.countryId)!;
        return c.weight * m.weight * (focus.has(c.id) ? 10 : 1);
      }),
    );
    destPickers.set(t.id, p);
    return p;
  };

  // ---- route rule index: per destination code, candidates sorted by priority ----
  const byCode = new Map<string, RouteRule[]>();
  const catchAll: RouteRule[] = [];
  for (const r of world.routeRules) {
    if (r.mccmncs.length === 0) catchAll.push(r);
    for (const code of r.mccmncs) {
      const l = byCode.get(code) ?? [];
      l.push(r);
      byCode.set(code, l);
    }
  }
  const sortRules = (a: RouteRule, b: RouteRule) => b.priority - a.priority || a.id - b.id;
  const rulesFor = new Map<string, RouteRule[]>();
  const candidatesFor = (m: Mccmnc) => {
    let l = rulesFor.get(m.code);
    if (!l) {
      l = [...(byCode.get(m.code) ?? []), ...(byCode.get(allCode(m)) ?? []), ...catchAll].sort(sortRules);
      rulesFor.set(m.code, l);
    }
    return l;
  };
  const warmup = new Map<number, { day: number; count: number }>();
  const patterns = new Map<number, RegExp>();

  const vendorLive = (v: VendorTrunk, t: number) =>
    v.insertedAt <= t && (v.deletedAt === null || t < v.deletedAt) && (v.status === "active" || v.deletedAt !== null);
  const vendorRate = (v: VendorTrunk, m: Mccmnc, t: number): RateVersion | null => {
    const table = world.rateTableById.get(v.rateTableId)!;
    const ver = versionAt(table.lines.get(m.code), t) ?? versionAt(table.lines.get(allCode(m)), t);
    return ver && !ver.blocked ? ver : null;
  };
  const sysCost = (v: VendorTrunk, ver: RateVersion, t: number) =>
    ver.rate / fxPerUsd(world, world.rateTableById.get(v.rateTableId)!.currency, t);

  // Least-cost ranking per destination, cached for the current hour (messages are
  // generated in time order). A cached option is used only if still valid at t.
  type Option = { v: VendorTrunk; ver: RateVersion; usd: number };
  let lcrHour = -1;
  const lcrCache = new Map<string, Option[]>();
  const rankVendors = (m: Mccmnc, t: number, categories: number[]): Option[] => {
    const options: Option[] = [];
    for (const id of [...(coverage.get(m.code) ?? []), ...(coverage.get(allCode(m)) ?? [])]) {
      const v = world.vendorTrunkById.get(id)!;
      if (!vendorLive(v, t) || (categories.length && !categories.includes(v.categoryId))) continue;
      const ver = vendorRate(v, m, t);
      if (ver) options.push({ v, ver, usd: sysCost(v, ver, t) });
    }
    return options.sort((a, b) => a.usd - b.usd);
  };
  const dynamicPick = (m: Mccmnc, t: number, categories: number[], exclude: Set<number>): Routed | null => {
    const hour = Math.floor(t / HOUR);
    if (hour !== lcrHour) {
      lcrHour = hour;
      lcrCache.clear();
    }
    const key = `${m.code}|${categories.join(",")}`;
    let ranked = lcrCache.get(key);
    if (!ranked) {
      ranked = rankVendors(m, hour * HOUR, categories);
      lcrCache.set(key, ranked);
    }
    const valid = (o: Option) => !exclude.has(o.v.id) && o.ver.from <= t && t < o.ver.to && vendorLive(o.v, t);
    let top = ranked.filter(valid).slice(0, 3);
    if (top.length === 0) top = rankVendors(m, t, categories).filter(valid).slice(0, 3);
    if (!top.length) return null;
    const o = rng.weighted(top, [60, 25, 15].slice(0, top.length));
    return { vendor: o.v, version: o.ver, rule: null, level: top.indexOf(o) + 1, decidedBy: "lcr" };
  };

  const route = (
    t: number,
    trunk: CustomerTrunk,
    m: Mccmnc,
    sender: string,
    dst: string,
    tps: number,
    exclude: Set<number>,
  ): { blocked: RouteRule } | Routed | null => {
    for (const r of candidatesFor(m)) {
      if (r.status !== "active" || (r.deletedAt !== null && t >= r.deletedAt) || t < r.startsAt || t >= r.stopsAt)
        continue;
      if (r.categoryIds.length && !r.categoryIds.includes(trunk.categoryId)) continue;
      if (r.customerTrunkMode === "inclusive" && !r.customerTrunkIds.includes(trunk.id)) continue;
      if (r.customerTrunkMode === "exclusive" && r.customerTrunkIds.includes(trunk.id)) continue;
      if (r.senderPattern) {
        let re = patterns.get(r.id);
        if (!re) {
          re = new RegExp(r.senderPattern);
          patterns.set(r.id, re);
        }
        const hit = re.test(sender);
        if (hit === r.senderPatternNegate) continue;
      }
      if (r.tpsCondition) {
        const { op, value } = r.tpsCondition;
        const ok = op === ">" ? tps > value : op === ">=" ? tps >= value : op === "<" ? tps < value : tps <= value;
        if (!ok) continue;
      }
      if (r.routeType === "block") return { blocked: r };
      if (r.routeType === "dynamic") {
        const d = dynamicPick(m, t, r.vendorCategoryIds, exclude);
        if (d) return { ...d, rule: r };
        continue;
      }
      // static / qbr: whitelist, then warm-up, then the normal split (§13.27)
      const order: { v: VendorTrunk; level: number; by: string }[] = [];
      if (r.whitelist && r.whitelist.numbers.has(dst))
        order.push({ v: world.vendorTrunkById.get(r.whitelist.vendorTrunkId)!, level: 1, by: "whitelist" });
      const first = r.vendors[0];
      if (first?.warmupCount) {
        const day = Math.floor(t / DAY);
        const w = warmup.get(r.id) ?? { day, count: 0 };
        if (w.day !== day) {
          w.day = day;
          w.count = 0;
        }
        warmup.set(r.id, w);
        if (w.count < first.warmupCount) {
          w.count++;
          order.push({ v: world.vendorTrunkById.get(first.vendorTrunkId)!, level: 1, by: "warmup" });
        }
      }
      const primary = r.vendors.filter((v) => !v.isBackup);
      if (r.routeType === "qbr") {
        const ranked = primary
          .map((v) => world.vendorTrunkById.get(v.vendorTrunkId)!)
          .sort((a, b) => b.quality.dlr + b.quality.asr - (a.quality.dlr + a.quality.asr));
        ranked.forEach((v, i) => order.push({ v, level: i + 1, by: "qbr" }));
      } else if (r.huntPolicy === "percentage" && primary.length > 1) {
        const pick = rng.weighted(
          primary,
          primary.map((v) => v.sharePct ?? 1),
        );
        order.push({ v: world.vendorTrunkById.get(pick.vendorTrunkId)!, level: 1, by: "split" });
        for (const v of primary)
          if (v !== pick) order.push({ v: world.vendorTrunkById.get(v.vendorTrunkId)!, level: 1, by: "split" });
      } else {
        for (const v of primary)
          order.push({ v: world.vendorTrunkById.get(v.vendorTrunkId)!, level: v.level, by: "split" });
      }
      for (const v of r.vendors)
        if (v.isBackup) order.push({ v: world.vendorTrunkById.get(v.vendorTrunkId)!, level: v.level, by: "backup" });
      for (const o of order) {
        if (exclude.has(o.v.id) || !vendorLive(o.v, t)) continue;
        const ver = vendorRate(o.v, m, t);
        if (ver) return { vendor: o.v, version: ver, rule: r, level: o.level, decidedBy: o.by };
      }
      // No usable vendor in this rule: fall through to the next rule.
    }
    return null;
  };

  // ---- time buckets (hourly), counts proportional to the traffic shape ----
  const buckets: { from: number; to: number; w: number }[] = [];
  for (let b = Math.floor(start / HOUR) * HOUR; b < end; b += HOUR) {
    const from = Math.max(b, start);
    const to = Math.min(b + HOUR, end);
    buckets.push({ from, to, w: bucketWeight(b, start) * ((to - from) / HOUR) });
  }
  const totalW = buckets.reduce((s, b) => s + b.w, 0);

  let seq = 0;
  let written = 0;
  let lines: string[] = [];
  // Up to two chunks in flight so generation does not wait on each insert.
  const inflight: Promise<void>[] = [];
  const flush = async () => {
    if (!lines.length) return;
    const chunk = lines.join("\n") + "\n";
    const n = lines.length;
    lines = [];
    if (inflight.length >= 2) await inflight.shift();
    inflight.push(writer.write(chunk, n));
    written += n;
    opts.onProgress?.(written, opts.count);
  };

  let carry = 0;
  for (const b of buckets) {
    const exact = (opts.count * b.w) / totalW + carry;
    const n = Math.floor(exact);
    carry = exact - n;
    const times: number[] = new Array(n);
    for (let i = 0; i < n; i++) times[i] = b.from + Math.floor(rng.next() * (b.to - b.from));
    times.sort((x, y) => x - y);

    for (const t0 of times) {
      // pick a trunk that exists and carries traffic at t0
      let trunk = trunkPicker.pick(rng);
      for (let k = 0; k < 10 && (trunk.insertedAt > t0 || (trunk.deletedAt !== null && t0 >= trunk.deletedAt)); k++)
        trunk = trunkPicker.pick(rng);
      if (trunk.insertedAt > t0 || (trunk.deletedAt !== null && t0 >= trunk.deletedAt)) continue;
      const ent = world.enterpriseById.get(trunk.enterpriseId)!;
      const m = destPickerFor(trunk).pick(rng);
      const country = world.countryById.get(m.countryId)!;
      const base = bcBase.get(ent.businessCompanyId)!;
      const baseFx = fxPerUsd(world, base, t0);
      const sender = rng.pick(trunk.senders);
      const prefix = rng.pick(m.prefixes);
      const dst = prefix + rng.digits(Math.max(4, (country.dialCode === "1" ? 11 : 12) - prefix.length));
      const ucs2 = rng.chance(country.ucs2Share);
      const coding = ucs2 ? 8 : 0;
      const msgCount = ucs2 ? rng.weighted([1, 2, 3], [60, 30, 10]) : rng.weighted([1, 2, 3], [86, 10, 4]);
      const alpha = /[A-Za-z]/.test(sender);
      const text = messageText(rng, alpha ? sender : "Service", trunk.otp);
      const tps = Number((trunk.tps * rng.float(0.03, 0.9)).toFixed(1));
      const ipIdx = rng.int(0, trunk.hostIps.length - 1);
      const dayIdx = Math.floor(t0 / DAY);
      const bind = trunk.bindType === "AUTO" ? "TR" : trunk.bindType;
      const session = `c${trunk.id}-${ipIdx}-${dayIdx % 1000}-${rng.int(0, 2)}`;
      const cMsgId = (++seq).toString(16).padStart(14, "0") + rng.hex(4);
      const cAm = amAt(ent, t0);

      // customer rating: first rate table with a line wins (§5.4, §6.2)
      let cTable = 0;
      let cVer: RateVersion | null = null;
      let cCcy = ent.customerCurrency ?? "USD";
      for (const tid of trunk.rateTableIds) {
        const table = world.rateTableById.get(tid)!;
        const v =
          versionAt(table.lines.get(`${sender}|${m.code}`), t0) ??
          versionAt(table.lines.get(m.code), t0) ??
          versionAt(table.lines.get(allCode(m)), t0);
        if (v) {
          cTable = tid;
          cVer = v;
          cCcy = table.currency;
          break;
        }
      }
      const cEx = fxPerUsd(world, cCcy, t0) / baseFx;
      const cRate = cVer?.rate ?? 0;
      const cSys = cRate / cEx;

      // HLR rules are checked top to bottom; the first DNID match picks the provider (§13.2).
      const hlrProvider = trunk.hlrRules.find((r) => dst.startsWith(r.dnidPrefix))?.providerId ?? 0;
      const hlrType = hlrProvider ? (rng.chance(0.6) ? "cached" : "live") : "none";
      const hlrCost = hlrType === "live" ? world.hlrProviders[hlrProvider - 1]!.rateUsd / baseFx : 0;
      const hlrPorted = hlrProvider && rng.chance(0.08) ? 1 : 0;

      const common = (submitAt: number) => [rng.uuid(), dt(t0), dt(submitAt)];
      const cust = [
        "MT",
        String(ent.businessCompanyId),
        String(trunk.categoryId),
        String(ent.id),
        String(trunk.id),
        String(cAm),
        trunk.hostIps[ipIdx],
        String(rng.int(30000, 65000)),
        session,
        bind,
        trunk.protocol,
        cMsgId,
        alpha ? "5" : sender.length <= 6 ? "3" : "1",
        alpha ? "0" : "1",
        "1",
        "1",
        String(coding),
        esc(sender),
        dst,
        dst,
        esc(text),
        m.code,
        m.mcc,
        m.mnc,
        country.iso,
        trunk.billingType,
        String(cTable),
        String(cVer?.id ?? 0),
        dec(cRate),
        cCcy,
        dec8(cEx),
        dec(cSys),
        `[${trunk.translationRuleIds.slice(0, 3).join(",")}]`,
      ];

      // reject before routing: no rate or blocked line
      if (!cVer || cVer.blocked) {
        const row = [
          ...common(t0),
          dt(t0 + rng.int(1, 30)),
          NULL,
          ...cust,
          "REJECTD",
          session,
          "0",
          "0",
          "0",
          "0",
          "0.0.0.0",
          "0",
          "",
          "",
          "",
          "0",
          "0",
          dec(0),
          "",
          dec8(0),
          dec(0),
          "[]",
          "0",
          "0",
          "",
          "0",
          "",
          String(tps),
          dec(cSys),
          "0",
          "0",
          "1",
          "1",
          "0",
          cVer ? "69" : "11",
          "REJECTD",
          cVer ? "BLOCKED_RATE" : "NO_RATE",
          "0",
          "1",
          String(msgCount),
          "",
          "0",
          "0",
          "0",
          "0",
          dec(0),
          dec(0),
          dec(0),
          dec(0),
          String(hlrProvider),
          hlrType,
          String(hlrPorted),
          hlrProvider ? "1" : "0",
          "0",
          dec(hlrCost),
          "", // not sent to a vendor
        ];
        lines.push(row.join("\t"));
        if (lines.length >= chunkRows) await flush();
        continue;
      }

      const tried = new Set<number>();
      let attempt = 1;
      let submitAt = t0 + rng.int(1, 40);
      for (;;) {
        const r = route(submitAt, trunk, m, sender, dst, tps, tried);
        if (!r || "blocked" in r) {
          const blockedRule = r && "blocked" in r ? r.blocked : null;
          const row = [
            ...common(submitAt),
            dt(submitAt + rng.int(1, 30)),
            NULL,
            ...cust,
            "REJECTD",
            session,
            "0",
            "0",
            "0",
            "0",
            "0.0.0.0",
            "0",
            "",
            "",
            "",
            "0",
            "0",
            dec(0),
            "",
            dec8(0),
            dec(0),
            "[]",
            String(blockedRule?.id ?? 0),
            "0" /* route rule groups removed (R4) */,
            blockedRule ? "block" : "",
            "0",
            "",
            String(tps),
            dec(cSys),
            "0",
            "0",
            String(attempt),
            "1",
            "0",
            "69",
            "REJECTD",
            blockedRule ? "BLOCKED_ROUTE" : "NO_ROUTE",
            "0",
            "1",
            String(msgCount),
            "",
            "0",
            "0",
            "0",
            "0",
            dec(0),
            dec(0),
            dec(0),
            dec(0),
            String(hlrProvider),
            hlrType,
            String(hlrPorted),
            hlrProvider ? "1" : "0",
            "0",
            dec(attempt === 1 ? hlrCost : 0),
            "", // not sent to a vendor
          ];
          lines.push(row.join("\t"));
          break;
        }
        const v = r.vendor;
        tried.add(v.id);
        const vEnt = world.enterpriseById.get(v.enterpriseId)!;
        const vTable = world.rateTableById.get(v.rateTableId)!;
        const vEx = fxPerUsd(world, vTable.currency, submitAt) / baseFx;
        const vRate = r.version.rate;
        const vSys = vRate / vEx;
        const destQ = hash01(v.id, Number(m.mcc)) - 0.5;
        const asr = Math.min(0.999, v.quality.asr + destQ * 0.04);
        const dlr = Math.min(0.995, Math.max(0.2, v.quality.dlr + destQ * 0.16));
        const success = rng.chance(asr);
        const respAt = submitAt + Math.round(rng.logNormal(success ? 120 : 300, 0.6));
        const firstId = !success
          ? ""
          : v.msgIdType === "decimal"
            ? String(1e9 + seq * 7 + attempt)
            : v.msgIdType === "hexadecimal"
              ? (seq * 7 + attempt).toString(16).toUpperCase()
              : rng.hex(20);
        // One vendor ID per part of a multipart message, comma separated (team trial round 2); derived from the
        // first so the random sequence (and the rest of the seed) does not change.
        const vMsgId =
          !firstId || msgCount === 1
            ? firstId
            : Array.from({ length: msgCount }, (_, i) =>
                i === 0
                  ? firstId
                  : v.msgIdType === "decimal"
                    ? String(Number(firstId) + i * 3)
                    : v.msgIdType === "hexadecimal"
                      ? ((seq * 7 + attempt) * 4 + i).toString(16).toUpperCase()
                      : `${firstId.slice(0, -2)}${(parseInt(firstId.slice(-2), 16) ^ i).toString(16).padStart(2, "0")}`,
              ).join(",");

        let status = "";
        let deliveryAt: number | null = null;
        let err = "";
        let cmd = 0;
        let retry = false;
        let dlrReroute = 0;
        if (!success) {
          cmd = rng.weighted(SUBMIT_ERRORS, SUBMIT_ERROR_WEIGHTS);
          status = "REJECTD";
          err = `SUBMIT_${cmd}`;
          retry = attempt < 3 && rng.chance(0.6);
        } else {
          const delay = Math.round(rng.logNormal(v.quality.delayMedianS * 1000, 0.8));
          if (respAt + delay > end) status = "ENROUTE";
          else {
            deliveryAt = respAt + delay;
            if (rng.chance(dlr)) {
              status = "DELIVRD";
              err = "000";
            } else {
              status = rng.weighted(FAIL_STATS, FAIL_STAT_WEIGHTS);
              err = FAIL_ERR[status] ?? "000";
              if (attempt < 3 && v.rerouteOn.includes(status) && rng.chance(0.3)) {
                retry = true;
                dlrReroute = 1;
              }
            }
          }
        }
        const isFinal = !retry;
        const reported = success && status !== "ENROUTE";
        const billableFor = (bt: string) =>
          bt === "attempt" ? true : bt === "submit" ? success : bt === "reported" ? reported : status === "DELIVRD";
        const cBill = isFinal && billableFor(trunk.billingType) ? 1 : 0;
        const vBill = billableFor(v.billingType) ? 1 : 0;
        const revenue = cBill ? cRate * msgCount : 0;
        const cost = vBill ? vRate * msgCount : 0;
        const held = deliveryAt && rng.chance(0.01) ? rng.int(1000, HOUR) : 0;
        const receiptSession = bind === "TX" ? `c${trunk.id}-${ipIdx}-rx` : session;

        const row = [
          ...common(submitAt),
          dt(respAt),
          deliveryAt ? dt(deliveryAt) : NULL,
          ...cust,
          isFinal ? status : "",
          deliveryAt ? receiptSession : "",
          String(held),
          String(vEnt.id),
          String(v.id),
          String(amAt(vEnt, submitAt)),
          v.host,
          String(v.port),
          vMsgId,
          m.code,
          v.billingType,
          String(vTable.id),
          String(r.version.id),
          dec(vRate),
          vTable.currency,
          dec8(vEx),
          dec(vSys),
          `[${v.translationRuleIds.slice(0, 2).join(",")}]`,
          String(r.rule?.id ?? 0),
          "0" /* route rule groups removed (R4) */,
          r.rule?.routeType ?? "dynamic",
          String(r.level),
          r.decidedBy,
          String(tps),
          dec(cSys),
          String(dlrReroute),
          "0",
          String(attempt),
          isFinal ? "1" : "0",
          success ? "1" : "0",
          String(cmd),
          status,
          err,
          status === "DELIVRD" || !deliveryAt ? "0" : String(rng.int(1, 255)),
          "1",
          String(msgCount),
          msgCount > 1 ? `050003${rng.hex(2)}0${msgCount}01` : "",
          String(deliveryAt ? deliveryAt - submitAt : 0),
          rng.chance(0.005) ? "1" : "0",
          String(cBill),
          String(vBill),
          dec(revenue),
          dec(cost),
          dec(revenue / cEx),
          dec(cost / vEx),
          String(hlrProvider),
          attempt === 1 ? hlrType : "none",
          String(hlrPorted),
          hlrProvider ? "1" : "0",
          "0",
          dec(attempt === 1 ? hlrCost : 0),
          esc(vendorSender(sender, v)),
        ];
        lines.push(row.join("\t"));
        if (!retry) break;
        attempt++;
        submitAt = (deliveryAt ?? respAt) + rng.int(50, 2000);
        if (submitAt >= end) break;
      }
      if (lines.length >= chunkRows) await flush();
    }
  }
  await flush();
  await Promise.all(inflight);
  await writer.close();
  return written;
}
