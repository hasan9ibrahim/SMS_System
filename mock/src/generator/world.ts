/**
 * In-memory model of the generated configuration. Generators fill it and write
 * the matching rows to the sink; the EDR generator reads it to produce traffic
 * that is consistent with trunks, rate history, route rules and AM history.
 * All timestamps here are epoch milliseconds (UTC).
 */
export interface Country {
  id: number;
  name: string;
  iso: string;
  dialCode: string;
  region: string;
  /** relative SMS traffic share */
  weight: number;
  /** reference termination price in USD (fake) */
  basePriceUsd: number;
  /** networks of this country (not including the all-networks code) */
  mccmncIds: number[];
  /** country-level "All networks" code; 0 when the country shares its MCC with a bigger one (e.g. Guam) */
  allNetworksId: number;
  /** destinations where Unicode (UCS2) traffic is common */
  ucs2Share: number;
}

export interface Mccmnc {
  id: number;
  mcc: string;
  mnc: string;
  code: string;
  countryId: number;
  network: string;
  isAllNetworks: boolean;
  /** share of the country's traffic */
  weight: number;
  /** price factor vs the country base price */
  priceFactor: number;
  /** fake dial-code prefixes (start with the real country dial code) */
  prefixes: string[];
}

export interface User {
  id: number;
  username: string;
  first: string;
  last: string;
  departmentId: number;
  department: string;
  businessCompanyId: number;
  isAccountManager: boolean;
  isAdmin: boolean;
}

export interface BusinessCompany {
  id: number;
  name: string;
  baseCurrency: string;
}

export interface AmPeriod {
  userId: number;
  start: number;
  end: number; // Infinity when open
}

export type EnterpriseType = "customer" | "vendor" | "reciprocal";

export interface Enterprise {
  id: number;
  businessCompanyId: number;
  name: string;
  alias: string;
  domain: string;
  type: EnterpriseType;
  tier: "tier1" | "tier2" | "tier3";
  status: "active" | "inactive";
  countryId: number;
  insertedAt: number;
  deletedAt: number | null;
  amHistory: AmPeriod[];
  /** traffic weight (Zipf), drives EDR volume and invoice amounts */
  size: number;
  customerCurrency: string | null;
  vendorCurrency: string | null;
  customerBillingType: "prepaid" | "postpaid" | null;
  /** Billing time zone (§13.31): invoice and report days are cut at midnight here. */
  billingTimezone: string;
}

export type BillingType = "attempt" | "submit" | "reported" | "delivery";

export interface CustomerTrunk {
  id: number;
  enterpriseId: number;
  name: string;
  username: string;
  categoryId: number;
  protocol: "smpp" | "http";
  billingType: BillingType;
  bindType: "TX" | "RX" | "TR" | "AUTO";
  hostIps: string[];
  port: number;
  tps: number;
  status: "active" | "inactive";
  insertedAt: number;
  deletedAt: number | null;
  rateTableIds: number[];
  senders: string[];
  /** share of the enterprise's traffic */
  share: number;
  /** countries this client sends most to */
  focusCountryIds: number[];
  /** HLR rules that run on this trunk, in order (direct and inherited, §13.2) */
  hlrRules: { ruleId: number; providerId: number; dnidPrefix: string }[];
  /** translation rules that run on this trunk, in order (direct and inherited, §13.2) */
  translationRuleIds: number[];
  otp: boolean;
}

export interface VendorQuality {
  asr: number; // submit success probability
  dlr: number; // delivered | submitted
  delayMedianS: number;
}

export interface VendorTrunk {
  id: number;
  enterpriseId: number;
  name: string;
  categoryId: number;
  billingType: BillingType;
  host: string;
  port: number;
  tps: number;
  msgIdType: "default" | "decimal" | "hexadecimal";
  rerouteOn: string[];
  status: "active" | "inactive";
  insertedAt: number;
  deletedAt: number | null;
  rateTableId: number;
  quality: VendorQuality;
  isDirect: boolean;
  /** egress translation rules that run on this trunk, in order (direct and inherited, §13.2) */
  translationRuleIds: number[];
}

export interface RateVersion {
  id: number;
  from: number;
  to: number; // Infinity when open-ended
  rate: number;
  blocked: boolean;
}

export interface RateTable {
  id: number;
  kind: "customer" | "vendor";
  name: string;
  categoryId: number;
  currency: string;
  vendorTrunkId: number | null;
  insertedAt: number;
  /** key = mccmnc code, or `${senderId}|${mccmnc}` for sender-specific lines; versions sorted by `from` */
  lines: Map<string, RateVersion[]>;
}

export interface RouteVendor {
  level: number;
  vendorTrunkId: number;
  sharePct: number | null;
  isBackup: boolean;
  warmupCount: number | null;
}

export interface RouteRule {
  id: number;
  name: string;
  priority: number;
  status: "active" | "inactive";
  startsAt: number;
  stopsAt: number;
  deletedAt: number | null;
  groupId: number | null;
  categoryIds: number[]; // empty = all
  customerTrunkMode: "all" | "inclusive" | "exclusive";
  customerTrunkIds: number[];
  mccmncs: string[]; // empty = all; 3-digit = whole country
  senderPattern: string | null;
  senderPatternNegate: boolean;
  routeType: "block" | "static" | "dynamic" | "qbr";
  huntPolicy: "top_down" | "round_robin" | "percentage";
  vendors: RouteVendor[];
  vendorCategoryIds: number[]; // dynamic/qbr scope, empty = all
  margin: number;
  whitelist: { vendorTrunkId: number; numbers: Set<string> } | null;
  tpsCondition: { op: string; value: number } | null;
  hlrPolicy: boolean;
}

/** What a translation or HLR rule applies to (§13.2, option A: the rule keeps its targets). */
export interface RuleTarget {
  ruleId: number;
  type: "trunk" | "enterprise" | "category" | "all";
  trunkKind: "customer" | "vendor";
  targetId: number | null;
  insertAt: "top" | "bottom";
}

/** Per-trunk order and on/off of one rule; order belongs to the trunk. */
export interface TrunkRuleSetting {
  position: number | null;
  enabled: boolean;
}

export interface RuleSet {
  activeRuleIds: Set<number>;
  targets: RuleTarget[];
  /** key `${trunkKind}:${trunkId}:${ruleId}` */
  settings: Map<string, TrunkRuleSetting>;
}

export interface TrunkRef {
  id: number;
  enterpriseId: number;
  categoryId: number;
}

export function targetMatches(t: RuleTarget, kind: "customer" | "vendor", trunk: TrunkRef): boolean {
  if (t.trunkKind !== kind) return false;
  switch (t.type) {
    case "trunk":
      return t.targetId === trunk.id;
    case "enterprise":
      return t.targetId === trunk.enterpriseId;
    case "category":
      return t.targetId === trunk.categoryId;
    case "all":
      return true;
  }
}

/**
 * Rules that run on a trunk, in execution order: rules reaching the trunk through any
 * target (direct trunk, its enterprise, its category or all trunks), minus inactive rules
 * and rules switched off for this trunk. Order: unpositioned 'top' rules, then positioned
 * rules by position, then the remaining rules; ties by rule id. A trunk created later
 * gets every enterprise, category and all-trunk rule without any extra row.
 */
export function rulesForTrunk(set: RuleSet, kind: "customer" | "vendor", trunk: TrunkRef): number[] {
  const top = new Map<number, boolean>();
  for (const t of set.targets) {
    if (!set.activeRuleIds.has(t.ruleId) || !targetMatches(t, kind, trunk)) continue;
    top.set(t.ruleId, (top.get(t.ruleId) ?? false) || t.insertAt === "top");
  }
  const rank = (ruleId: number): [number, number] => {
    const s = set.settings.get(`${kind}:${trunk.id}:${ruleId}`);
    if (s?.position != null) return [1, s.position];
    return [top.get(ruleId) ? 0 : 2, 0];
  };
  return [...top.keys()]
    .filter((id) => set.settings.get(`${kind}:${trunk.id}:${id}`)?.enabled !== false)
    .sort((a, b) => {
      const [ga, pa] = rank(a);
      const [gb, pb] = rank(b);
      return ga - gb || pa - pb || a - b;
    });
}

export interface World {
  anchor: number;
  historyStart: number;
  currencies: string[];
  /** units of currency per 1 USD, daily history keyed by currency, sorted ascending by time */
  fx: Map<string, { t: number; rate: number }[]>;
  categories: { id: number; name: string }[];
  countries: Country[];
  countryById: Map<number, Country>;
  mccmnc: Mccmnc[];
  mccmncById: Map<number, Mccmnc>;
  mccmncByCode: Map<string, Mccmnc>;
  businessCompanies: BusinessCompany[];
  users: User[];
  accountManagers: User[];
  enterprises: Enterprise[];
  enterpriseById: Map<number, Enterprise>;
  customerTrunks: CustomerTrunk[];
  customerTrunkById: Map<number, CustomerTrunk>;
  vendorTrunks: VendorTrunk[];
  vendorTrunkById: Map<number, VendorTrunk>;
  rateTables: RateTable[];
  rateTableById: Map<number, RateTable>;
  routeRules: RouteRule[];
  hlrProviders: { id: number; name: string; rateUsd: number }[];
  numberLists: { id: number; name: string; type: string; entries: string[] }[];
  translationRules: RuleSet;
  hlrRules: RuleSet & { rules: Map<number, { providerId: number; dnidPrefix: string }> };
}

/** Version valid at time t, or null. Versions are sorted by `from`. */
export function versionAt(versions: RateVersion[] | undefined, t: number): RateVersion | null {
  if (!versions) return null;
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i]!;
    if (v.from <= t) return t < v.to ? v : null;
  }
  return null;
}

/** The country-level code (MCC) that covers network m, or null when that MCC belongs to another country. */
export function allNetworksCodeOf(world: World, m: Mccmnc): string | null {
  const all = world.mccmncByCode.get(m.mcc);
  return all && all.isAllNetworks && all.countryId === m.countryId ? m.mcc : null;
}

/** Units of `iso` per 1 USD on the day of t. */
export function fxPerUsd(world: World, iso: string, t: number): number {
  if (iso === "USD") return 1;
  const hist = world.fx.get(iso);
  if (!hist || hist.length === 0) throw new Error(`no exchange rate for ${iso}`);
  let lo = 0;
  let hi = hist.length - 1;
  if (t < hist[0]!.t) return hist[0]!.rate;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (hist[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return hist[lo]!.rate;
}

/** AM holding the account at time t (spec §13.30), 0 when none. */
export function amAt(e: Enterprise, t: number): number {
  for (const p of e.amHistory) if (p.start <= t && t < p.end) return p.userId;
  return 0;
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

/**
 * A transaction's Final Amount (§7 Transaction Conversion): the amount in the enterprise's
 * business company base currency at the payment time, with the rate used (base units per unit).
 */
export function toBase(world: World, enterpriseId: number, amount: number, iso: string, t: number) {
  const e = world.enterpriseById.get(enterpriseId)!;
  const base = world.businessCompanies.find((b) => b.id === e.businessCompanyId)!.baseCurrency;
  const rate = fxPerUsd(world, base, t) / fxPerUsd(world, iso, t);
  return {
    amount_base: Math.round(amount * rate * 100) / 100,
    base_currency: base,
    ex_rate: Number(rate.toFixed(8)),
  };
}
