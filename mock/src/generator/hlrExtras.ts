/**
 * HLR provider prices per destination and HLR policies (§6.5, §13.24) for build step 5.4.
 * Runs after every other step on its own forked stream, so earlier tables are unchanged for
 * the same seed. Policy 1 is "Default" (a catch-all plus a few countries): route rules with an
 * HLR action use it. Provider stats are not generated: the mock refreshes them from the EDRs.
 */
import { usersOf } from "./admin.js";
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import { json, type TableSink } from "./sink.js";
import { DAY, type World } from "./world.js";

export async function generateHlrExtras(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const noc = usersOf(world, "NOC");
  const active = world.hlrProviders.slice(0, -1); // the last provider is inactive (rules step)
  const big = world.countries.filter((c) => c.weight > 3);

  // Prices: each active provider prices its busiest countries, some networks on their own.
  let rateId = 1;
  for (const p of active) {
    const countries = rng.shuffle([...big]).slice(0, profile.name === "full" ? 40 : 12);
    for (const c of countries) {
      const codes = [c.allNetworksId, ...(rng.chance(0.3) ? rng.shuffle([...c.mccmncIds]).slice(0, 2) : [])];
      for (const mccmncId of new Set(codes)) {
        await sink.insert("hlr_provider_rates", {
          id: rateId++,
          hlr_provider_id: p.id,
          mccmnc_id: mccmncId,
          rate: Number((p.rateUsd * rng.float(0.5, 1.8)).toFixed(6)),
          updated_by_id: rng.pick(noc).id,
          inserted_at: new Date(world.anchor - rng.int(30, 400) * DAY),
          updated_at: new Date(world.anchor - rng.int(0, 30) * DAY),
          deleted_at: null,
        });
      }
    }
  }

  // Policies: Default first, then per-region ones; entries are ordered lists or "auto".
  const entry = (code: string | null, auto: boolean) => {
    const ids = rng.shuffle(active.map((p) => p.id)).slice(0, rng.int(1, 3));
    const ported = rng.pick([24, 72, 168, 336]);
    return {
      code,
      mode: auto ? "auto" : "ordered",
      providerIds: ids,
      minSuccessPct: auto ? rng.pick([85, 90, 95]) : null,
      cacheHoursPorted: ported,
      cacheHoursNotPorted: Math.min(720, ported * rng.pick([1, 2, 4])),
    };
  };
  const names = [
    "Default",
    "Europe portability",
    "Africa validity",
    "Asia live HLR",
    "Americas MNP",
    "Premium clients",
  ];
  const count = profile.name === "full" ? names.length : 4;
  for (let i = 0; i < count; i++) {
    const countries = rng.shuffle([...big]).slice(0, rng.int(3, 12));
    const entries = countries.map((c) => {
      const all = world.mccmncById.get(c.allNetworksId)!;
      const code = rng.chance(0.75) ? all.mcc : world.mccmncById.get(rng.pick(c.mccmncIds))!.code;
      return entry(code, rng.chance(0.25));
    });
    if (i === 0 || rng.chance(0.5)) entries.push(entry(null, false));
    const seen = new Set<string | null>();
    await sink.insert("hlr_policies", {
      id: i + 1,
      name: names[i],
      status: i > 0 && rng.chance(0.15) ? "inactive" : "active",
      entries: json(entries.filter((e) => !seen.has(e.code) && seen.add(e.code))),
      updated_by_id: rng.pick(noc).id,
      inserted_at: new Date(world.anchor - rng.int(30, 300) * DAY),
      updated_at: new Date(world.anchor - rng.int(0, 30) * DAY),
      deleted_at: null,
    });
  }
}
