/**
 * Reference data: currencies and exchange-rate history, billing cycles, product
 * categories (spec §5.5, §7), countries, the real MCC/MNC master with per-country
 * "All networks" codes, and the dial-code Master Table (spec §6.1, §13.21).
 */
import { fakeDestinationTarget } from "./dlrTargets.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { DAY, type Country, type Mccmnc, type World } from "./world.js";

// SMS_DATA_DIR: where the bundled server image keeps the data files (deploy/Dockerfile.mock).
const MCCMNC_CSV = process.env.SMS_DATA_DIR
  ? `${process.env.SMS_DATA_DIR}/mccmnc.csv`
  : fileURLToPath(new URL("../../data/mccmnc.csv", import.meta.url));

export const CURRENCIES = [
  { iso: "USD", name: "US Dollar", symbol: "$", perUsd: 1 },
  { iso: "EUR", name: "Euro", symbol: "€", perUsd: 0.92 },
  { iso: "GBP", name: "Pound Sterling", symbol: "£", perUsd: 0.79 },
  { iso: "AED", name: "UAE Dirham", symbol: "AED", perUsd: 3.6725 },
  { iso: "INR", name: "Indian Rupee", symbol: "₹", perUsd: 83.2 },
];

/** Spec §5.5 list; weights drive how often trunks and tables use a category. */
export const CATEGORIES: { name: string; weight: number }[] = [
  { name: "DIRECT", weight: 20 },
  { name: "HQ", weight: 16 },
  { name: "WHS", weight: 16 },
  { name: "OTP", weight: 12 },
  { name: "PROMO", weight: 8 },
  { name: "SIM", weight: 6 },
  { name: "SS7", weight: 3 },
  { name: "LOCAL", weight: 4 },
  { name: "H-CR", weight: 2 },
  { name: "SPECIAL", weight: 2 },
  { name: "CS", weight: 1 },
  { name: "ATX", weight: 1 },
  { name: "Enterprise", weight: 3 },
  { name: "WA – WhatsApp", weight: 2 },
  { name: "Rerating", weight: 0 },
  { name: "ServiceDLR", weight: 0 },
  { name: "Test", weight: 0.5 },
];

export const BILLING_CYCLES = [
  { name: "Daily", billing_type: "daily", week_day: null, usage_days: 1, due_days: 0 },
  { name: "Weekly", billing_type: "weekly", week_day: "MON", usage_days: 7, due_days: 0 },
  { name: "Weekly – Net 7", billing_type: "weekly", week_day: "MON", usage_days: 7, due_days: 7 },
  { name: "Fortnightly", billing_type: "fortnightly", week_day: "MON", usage_days: 14, due_days: 0 },
  { name: "Fortnightly – Net 15", billing_type: "fortnightly", week_day: "MON", usage_days: 14, due_days: 15 },
  { name: "Monthly", billing_type: "monthly", week_day: null, usage_days: 30, due_days: 0 },
  { name: "Monthly – Net 5", billing_type: "monthly", week_day: null, usage_days: 30, due_days: 5 },
  { name: "Monthly – Net 7", billing_type: "monthly", week_day: null, usage_days: 30, due_days: 7 },
  { name: "Monthly – Net 10", billing_type: "monthly", week_day: null, usage_days: 30, due_days: 10 },
  { name: "Monthly – Net 15", billing_type: "monthly", week_day: null, usage_days: 30, due_days: 15 },
  { name: "Monthly – Net 20", billing_type: "monthly", week_day: null, usage_days: 30, due_days: 20 },
  { name: "Monthly – Net 30", billing_type: "monthly", week_day: null, usage_days: 30, due_days: 30 },
];

/** Relative A2P traffic share for the busiest destinations (fake weights). */
const TRAFFIC_WEIGHT: Record<string, number> = {
  IN: 100,
  ID: 70,
  US: 60,
  BR: 55,
  NG: 40,
  PK: 35,
  PH: 35,
  BD: 30,
  MX: 30,
  VN: 28,
  EG: 26,
  TR: 25,
  RU: 25,
  DE: 24,
  GB: 24,
  FR: 22,
  IT: 20,
  ES: 20,
  SA: 22,
  AE: 18,
  TH: 18,
  CO: 15,
  AR: 14,
  ZA: 14,
  KE: 12,
  MY: 12,
  PL: 12,
  UA: 10,
  CN: 10,
  JP: 8,
  KR: 8,
  MA: 10,
  DZ: 8,
  IQ: 9,
  KZ: 7,
  PE: 9,
  CL: 8,
  GH: 7,
  TZ: 6,
  UG: 6,
  ET: 5,
  NL: 9,
  BE: 6,
  SE: 5,
  RO: 7,
  PT: 5,
  GR: 5,
  CA: 9,
  AU: 9,
  SG: 6,
  QA: 5,
  KW: 5,
  OM: 4,
  BH: 3,
  JO: 5,
  LB: 4,
  IL: 5,
  LK: 4,
  NP: 4,
  MM: 4,
  KH: 3,
  CI: 4,
  SN: 4,
  CM: 4,
  TN: 4,
};

const GCC = new Set(["AE", "SA", "QA", "KW", "BH", "OM"]);
const EU = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);
const UCS2_HEAVY = new Set([
  "SA",
  "AE",
  "QA",
  "KW",
  "BH",
  "OM",
  "EG",
  "IQ",
  "JO",
  "LB",
  "MA",
  "DZ",
  "TN",
  "RU",
  "UA",
  "BY",
  "KZ",
  "CN",
  "JP",
  "KR",
  "TH",
  "IL",
  "IR",
  "GR",
  "VN",
]);

function regionOf(iso: string, mcc: string): string {
  if (GCC.has(iso)) return "GCC";
  if (EU.has(iso)) return "EU";
  switch (mcc[0]) {
    case "2":
      return "Europe (non-EU)";
    case "3":
      return "North America & Caribbean";
    case "4":
      return "Asia & Middle East";
    case "5":
      return "Oceania & South-East Asia";
    case "6":
      return "Africa";
    case "7":
      return "Latin America";
    default:
      return "Other";
  }
}

/** Fake termination price band per region, USD. */
const REGION_PRICE: Record<string, [number, number]> = {
  EU: [0.035, 0.095],
  "Europe (non-EU)": [0.02, 0.08],
  GCC: [0.025, 0.05],
  "North America & Caribbean": [0.004, 0.06],
  "Asia & Middle East": [0.003, 0.06],
  "Oceania & South-East Asia": [0.01, 0.07],
  Africa: [0.012, 0.055],
  "Latin America": [0.008, 0.045],
  Other: [0.02, 0.06],
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function loadMccmncCsv(): {
  mcc: string;
  mnc: string;
  code: string;
  iso: string;
  country: string;
  dial: string;
  network: string;
}[] {
  return readFileSync(MCCMNC_CSV, "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => {
      const [mcc = "", mnc = "", code = "", iso = "", country = "", dial = "", network = ""] = parseCsvLine(l);
      return { mcc, mnc, code, iso, country, dial, network };
    });
}

export async function generateReference(world: World, rng: Rng, sink: TableSink): Promise<void> {
  // Currencies and daily exchange-rate history (random walk around today's value).
  for (const c of CURRENCIES) {
    await sink.insert("currencies", { id: CURRENCIES.indexOf(c) + 1, iso: c.iso, name: c.name, symbol: c.symbol });
  }
  world.currencies = CURRENCIES.map((c) => c.iso);
  let fxId = 1;
  const startDay = Math.floor(world.historyStart / DAY) * DAY;
  for (const c of CURRENCIES) {
    if (c.iso === "USD") continue;
    const hist: { t: number; rate: number }[] = [];
    // Walk backwards from the anchor so the latest value is the reference value.
    let rate = c.perUsd;
    const days: { t: number; rate: number }[] = [];
    for (let t = Math.floor(world.anchor / DAY) * DAY; t >= startDay; t -= DAY) {
      days.push({ t, rate: Number(rate.toFixed(6)) });
      rate *= 1 + rng.normal() * (c.iso === "AED" ? 0.0002 : 0.004);
    }
    days.reverse();
    for (const d of days) {
      hist.push(d);
      await sink.insert("currency_rates", { id: fxId++, iso: c.iso, rate_per_usd: d.rate, valid_from: new Date(d.t) });
    }
    world.fx.set(c.iso, hist);
  }

  let bcId = 1;
  for (const b of BILLING_CYCLES) await sink.insert("billing_cycles", { id: bcId++, ...b });

  world.categories = CATEGORIES.map((c, i) => ({ id: i + 1, name: c.name }));
  for (const c of world.categories) await sink.insert("product_categories", { id: c.id, name: c.name });

  // Countries and MCCMNC master.
  const raw = loadMccmncCsv();
  const countryByName = new Map<string, Country>();
  let mccmncId = 1;
  for (const r of raw) {
    let country = countryByName.get(r.country);
    if (!country) {
      const region = regionOf(r.iso, r.mcc);
      const [lo, hi] = REGION_PRICE[region]!;
      country = {
        id: countryByName.size + 1,
        name: r.country,
        iso: r.iso,
        dialCode: r.dial,
        region,
        weight: TRAFFIC_WEIGHT[r.iso] ?? rng.float(0.2, 1.5),
        basePriceUsd: Number(rng.float(lo, hi).toFixed(5)),
        mccmncIds: [],
        allNetworksId: 0,
        ucs2Share: UCS2_HEAVY.has(r.iso) ? rng.float(0.25, 0.6) : rng.float(0.01, 0.08),
      };
      countryByName.set(r.country, country);
    }
    const m: Mccmnc = {
      id: mccmncId++,
      mcc: r.mcc,
      mnc: r.mnc,
      code: r.code,
      countryId: country.id,
      network: r.network,
      isAllNetworks: false,
      weight: 0,
      priceFactor: Number(rng.float(0.85, 1.2).toFixed(3)),
      prefixes: [],
    };
    country.mccmncIds.push(m.id);
    world.mccmnc.push(m);
  }
  world.countries = [...countryByName.values()];

  // One "All networks" code per MCC (a country can own several MCCs). A shared MCC
  // (e.g. 310 for the US and Guam) belongs to the country with most networks on it.
  const mccOwner = new Map<string, { countryId: number; n: number }>();
  const perMcc = new Map<string, number>();
  for (const m of world.mccmnc) perMcc.set(`${m.mcc}:${m.countryId}`, (perMcc.get(`${m.mcc}:${m.countryId}`) ?? 0) + 1);
  for (const [key, n] of perMcc) {
    const [mcc = "", cid = ""] = key.split(":");
    const cur = mccOwner.get(mcc);
    if (!cur || n > cur.n) mccOwner.set(mcc, { countryId: Number(cid), n });
  }
  const mccSeen = new Set<string>();
  for (const country of world.countries) {
    for (const id of [...country.mccmncIds]) {
      const net = world.mccmnc[id - 1]!;
      if (mccSeen.has(net.mcc) || mccOwner.get(net.mcc)!.countryId !== country.id) continue;
      mccSeen.add(net.mcc);
      const all: Mccmnc = {
        id: mccmncId++,
        mcc: net.mcc,
        mnc: "",
        code: net.mcc,
        countryId: country.id,
        network: "All networks",
        isAllNetworks: true,
        weight: 0,
        priceFactor: 1.1,
        prefixes: [],
      };
      world.mccmnc.push(all);
      if (!country.allNetworksId) country.allNetworksId = all.id;
    }
  }

  // Network traffic shares inside a country: a few big operators, a long tail.
  for (const country of world.countries) {
    const nets = rng.shuffle([...country.mccmncIds]);
    nets.forEach((id, i) => {
      world.mccmnc[id - 1]!.weight = 1 / Math.pow(i + 1, 1.3);
    });
  }

  for (const c of world.countries) world.countryById.set(c.id, c);
  for (const m of world.mccmnc) {
    world.mccmncById.set(m.id, m);
    world.mccmncByCode.set(m.code, m);
  }

  const regionsSorted = world.countries.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const c of regionsSorted) {
    await sink.insert("countries", { id: c.id, name: c.name, iso: c.iso, dial_code: c.dialCode, region: c.region });
  }
  for (const m of world.mccmnc) {
    await sink.insert("mccmnc", {
      id: m.id,
      mcc: m.mcc,
      mnc: m.mnc,
      mccmnc: m.code,
      country_id: m.countryId,
      network: m.network,
      is_all_networks: m.isAllNetworks,
      dlr_target_pct: fakeDestinationTarget(m.code, m.isAllNetworks),
    });
  }

  // Dial-code Master Table: fake prefixes under the real country dial code,
  // globally unique so a number resolves to exactly one network.
  const used = new Set<string>();
  let dcId = 1;
  for (const country of world.countries) {
    const allNet = world.mccmncById.get(country.allNetworksId);
    if (allNet && !used.has(country.dialCode)) {
      used.add(country.dialCode);
      allNet.prefixes.push(country.dialCode);
      await sink.insert("dial_codes", { id: dcId++, profile: "All", prefix: country.dialCode, mccmnc_id: allNet.id });
    }
    for (const id of country.mccmncIds) {
      const net = world.mccmncById.get(id)!;
      const n = rng.int(1, 3);
      const extra = country.dialCode.length >= 3 ? 1 : country.dialCode === "1" || country.dialCode === "7" ? 3 : 2;
      for (let k = 0; k < n; k++) {
        let prefix = "";
        for (let tries = 0; tries < 50; tries++) {
          const p = country.dialCode + String(rng.int(1, 10 ** extra - 1)).padStart(extra, "0");
          if (!used.has(p)) {
            prefix = p;
            break;
          }
        }
        if (!prefix) continue;
        used.add(prefix);
        net.prefixes.push(prefix);
        await sink.insert("dial_codes", { id: dcId++, profile: "All", prefix, mccmnc_id: net.id });
      }
      if (net.prefixes.length === 0) net.prefixes.push(country.dialCode);
    }
  }
}
