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
  hlrProviderIds: number[];
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
