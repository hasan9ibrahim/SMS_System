/**
 * Master data added for the §6.1 screens (build step 5): extra Master Table profiles and the
 * MO reference book. Runs as the last generator step on its own forked stream, so it leaves
 * every earlier table unchanged for the same seed. The "All" profile comes from migration 009.
 */
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import type { World } from "./world.js";

const KEYWORDS = ["INFO", "STOP", "JOIN", "WIN", "VOTE", "PROMO", "HELP", "OTP", "QUIZ", "BAL"];

export async function generateMasterData(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  // Extra dial-code profiles: copies of part of "All" with some prefixes moved to another
  // network of the same country (e.g. a ported-number view for one customer group).
  const extra = [
    { id: 2, name: "Ported numbers", share: 0.08, remap: 0.4 },
    { id: 3, name: "Short ranges", share: 0.03, remap: 0 },
  ];
  let dcId = 1_000_000;
  for (const p of extra) {
    await sink.insert("dial_code_profiles", { id: p.id, name: p.name });
    for (const net of world.mccmnc) {
      if (net.isAllNetworks) continue;
      const country = world.countryById.get(net.countryId)!;
      for (const prefix of net.prefixes) {
        if (prefix === country.dialCode || !rng.chance(p.share)) continue;
        const others = country.mccmncIds.filter((id) => id !== net.id);
        const target = others.length && rng.chance(p.remap) ? rng.pick(others) : net.id;
        await sink.insert("dial_codes", { id: dcId++, profile: p.name, prefix, mccmnc_id: target });
      }
    }
  }

  // MO reference book: long numbers and short codes of customer trunks.
  const trunks = world.customerTrunks.filter((t) => t.status === "active" && t.deletedAt === null);
  const used = new Set<string>();
  const staff = world.users.filter((u) => !u.isAccountManager);
  for (let i = 1; i <= profile.moNumbers && trunks.length; i++) {
    const trunk = rng.pick(trunks);
    const countryId = trunk.focusCountryIds.length ? rng.pick(trunk.focusCountryIds) : rng.pick(world.countries).id;
    const country = world.countryById.get(countryId)!;
    const short = rng.chance(0.3);
    const number = short
      ? String(rng.int(1000, 99999))
      : country.dialCode + rng.digits(9 - Math.min(3, country.dialCode.length) + 1);
    const keyword = rng.chance(0.5) ? rng.pick(KEYWORDS) : null;
    const key = `${number}|${keyword ?? ""}`;
    if (used.has(key)) continue;
    used.add(key);
    const nets = country.mccmncIds;
    const mccmncId = short
      ? country.allNetworksId || null
      : nets.length && rng.chance(0.7)
        ? rng.pick(nets)
        : country.allNetworksId || null;
    const created = world.anchor - rng.int(1, profile.historyMonths * 30) * 86_400_000;
    const by = rng.pick(staff).id;
    await sink.insert("mo_numbers", {
      id: i,
      customer_trunk_id: trunk.id,
      number,
      keyword,
      rate: Math.round(rng.float(0.004, 0.06) * 10_000) / 10_000,
      vendor_rate: rng.chance(0.6) ? Math.round(rng.float(0.002, 0.03) * 10_000) / 10_000 : null,
      mccmnc_id: mccmncId,
      setup_charge: rng.pick([0, 0, 0, 50, 100, 250]),
      fix_charge: rng.pick([0, 0, 10, 25, 50, 100]),
      created_by_id: by,
      updated_by_id: by,
      inserted_at: new Date(created),
      updated_at: new Date(created),
    });
  }
}
