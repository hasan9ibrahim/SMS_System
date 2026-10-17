/**
 * Builds the whole fake configuration (build-order step 2) into a TableSink and
 * returns the in-memory World used by the EDR generator. Deterministic for a
 * given seed, profile and anchor time.
 */
import { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import type { Profile } from "./profiles.js";
import { DAY, type World } from "./world.js";
import { generateReference } from "./reference.js";
import { generateAdmin } from "./admin.js";
import { generateEnterprises } from "./enterprises.js";
import { generateRates } from "./rates.js";
import { generateRules } from "./rules.js";
import { generateFinance } from "./finance.js";
import { generateHistory } from "./history.js";
import { generateMasterData } from "./masterData.js";
import { generateRoutingExtras } from "./routingExtras.js";

export function emptyWorld(anchor: number, profile: Profile): World {
  return {
    anchor,
    historyStart: anchor - Math.round(profile.historyMonths * 30.44) * DAY,
    currencies: [],
    fx: new Map(),
    categories: [],
    countries: [],
    countryById: new Map(),
    mccmnc: [],
    mccmncById: new Map(),
    mccmncByCode: new Map(),
    businessCompanies: [],
    users: [],
    accountManagers: [],
    enterprises: [],
    enterpriseById: new Map(),
    customerTrunks: [],
    customerTrunkById: new Map(),
    vendorTrunks: [],
    vendorTrunkById: new Map(),
    rateTables: [],
    rateTableById: new Map(),
    routeRules: [],
    hlrProviders: [],
    numberLists: [],
    translationRules: { activeRuleIds: new Set(), targets: [], settings: new Map() },
    hlrRules: { activeRuleIds: new Set(), targets: [], settings: new Map(), rules: new Map() },
  };
}

export async function generateWorld(opts: {
  seed: string | number;
  profile: Profile;
  anchor: number;
  sink: TableSink;
  log?: (s: string) => void;
}): Promise<World> {
  const log = opts.log ?? (() => {});
  const root = new Rng(opts.seed);
  const world = emptyWorld(opts.anchor, opts.profile);
  const step = async (name: string, fn: (rng: Rng) => Promise<void>) => {
    const t = Date.now();
    await fn(root.fork(name));
    log(`generated ${name} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  };
  await step("reference", (rng) => generateReference(world, rng, opts.sink));
  await step("admin", (rng) => generateAdmin(world, rng, opts.sink, opts.profile));
  await step("enterprises", (rng) => generateEnterprises(world, rng, opts.sink, opts.profile));
  await step("rates", (rng) => generateRates(world, rng, opts.sink, opts.profile));
  await step("rules", (rng) => generateRules(world, rng, opts.sink, opts.profile));
  await step("finance", (rng) => generateFinance(world, rng, opts.sink, opts.profile));
  await step("history", (rng) => generateHistory(world, rng, opts.sink));
  // Last, so it draws nothing the earlier steps depend on (§6.1 screens, build step 5).
  await step("master data", (rng) => generateMasterData(world, rng, opts.sink, opts.profile));
  await step("routing extras", (rng) => generateRoutingExtras(world, rng, opts.sink, opts.profile));
  return world;
}

export { Rng };
