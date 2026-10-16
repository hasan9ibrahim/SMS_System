/**
 * Rate tables with history (spec §6.2, §12.1, §13.12, §13.32).
 *
 * Every vendor trunk owns one vendor (buy) table; customer (sell) tables are
 * attached to customer trunks, some shared, a few unattached (cleanup, §13.20).
 * History is built from table-level change events (an RN import or a pricing
 * change): each event closes the changed lines and opens new ones, adds and
 * closes destinations, and is recorded in rate_imports with exact counts. Some
 * tables carry a scheduled future event; some vendor RNs are back-dated and are
 * applied from the received time with the stated date kept (§13.32).
 */
import {
  fxPerUsd,
  DAY,
  type Mccmnc,
  type RateTable,
  type RateVersion,
  type World,
  type CustomerTrunk,
} from "./world.js";
import { WeightedPicker, type Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import type { Profile } from "./profiles.js";
import { usersOf } from "./admin.js";

interface DraftLine {
  key: string;
  m: Mccmnc;
  senderId: string | null;
  rate: number;
  from: number;
  to: number;
  stated: number | null;
  blocked: boolean;
  changeType: "new" | "increase" | "decrease" | "same";
  note: string | null;
  userId: number;
}

interface PriceModel {
  /** USD price for a destination at the first event */
  initialUsd(m: Mccmnc): number;
  changeProb: [number, number];
  gapDays: [number, number];
}

let lineId = 1;
let importId = 1;

export async function generateRates(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  lineId = 1;
  importId = 1;
  const ratesTeam = usersOf(world, "Rates");
  const sales = usersOf(world, "Sales");
  const networks = world.mccmnc.filter((m) => !m.isAllNetworks);
  const maxWeight = Math.max(...world.countries.map((c) => c.weight));
  let tableId = 1;

  // ----- vendor (buy) tables -----
  for (const v of world.vendorTrunks) {
    const e = world.enterpriseById.get(v.enterpriseId)!;
    const currency = e.vendorCurrency ?? "USD";
    const factor = v.isDirect ? rng.float(0.72, 0.9) : rng.float(0.78, 1.02);
    let universe: Mccmnc[];
    if (v.isDirect) {
      const countries = rng.sample(
        world.countries.filter((c) => c.weight >= 3),
        rng.int(1, 4),
      );
      universe = countries.flatMap((c) =>
        [...c.mccmncIds, ...(c.allNetworksId ? [c.allNetworksId] : [])].map((id) => world.mccmncById.get(id)!),
      );
    } else {
      const [lo, hi] = profile.wholesaleCoverage;
      const f = rng.float(lo, hi);
      universe = networks.filter((m) => {
        const cw = world.countryById.get(m.countryId)!.weight / maxWeight;
        return rng.chance(Math.min(1, f * (0.5 + 1.5 * Math.sqrt(cw))));
      });
      const covered = new Set(universe.map((m) => m.countryId));
      for (const cid of covered) {
        const all = world.countryById.get(cid)!.allNetworksId;
        if (all && rng.chance(0.3)) universe.push(world.mccmncById.get(all)!);
      }
    }
    const table: RateTable = {
      id: tableId++,
      kind: "vendor",
      name: `${v.name} buy`,
      categoryId: v.categoryId,
      currency,
      vendorTrunkId: v.id,
      insertedAt: Math.max(v.insertedAt, world.historyStart),
      lines: new Map(),
    };
    v.rateTableId = table.id;
    const model: PriceModel = {
      initialUsd: (m) =>
        world.countryById.get(m.countryId)!.basePriceUsd * m.priceFactor * factor * rng.float(0.95, 1.05),
      changeProb: [0.15, 0.4],
      gapDays: [15, 75],
    };
    await writeTable(world, rng, sink, table, universe, [], model, ratesTeam, v.deletedAt, true);
  }

  // ----- customer (sell) tables -----
  const trunks = rng.shuffle([...world.customerTrunks]);
  const nOwn = Math.max(1, Math.round(trunks.length * profile.customerTablesPerTrunk));
  const tablesByCategory = new Map<number, RateTable[]>();
  const attach: { trunk: CustomerTrunk; table: RateTable }[] = [];
  const countryPicker = new WeightedPicker(
    world.countries,
    world.countries.map((c) => c.weight),
  );

  const makeCustomerTable = async (owner: CustomerTrunk | null, categoryId: number) => {
    const e = owner ? world.enterpriseById.get(owner.enterpriseId)! : rng.pick(world.enterprises);
    const currency = e.customerCurrency ?? "USD";
    const cat = world.categories.find((c) => c.id === categoryId)!.name.replace(/[^A-Za-z0-9]/g, "");
    const [lo, hi] = profile.customerTableSize;
    const size = Math.round(Math.exp(rng.float(Math.log(lo), Math.log(hi))));
    const picked = new Set<Mccmnc>();
    const focus = owner ? owner.focusCountryIds : [countryPicker.pick(rng).id];
    for (const cid of focus) {
      const c = world.countryById.get(cid)!;
      for (const id of c.mccmncIds) picked.add(world.mccmncById.get(id)!);
      if (c.allNetworksId && rng.chance(0.4)) picked.add(world.mccmncById.get(c.allNetworksId)!);
    }
    for (let guard = 0; picked.size < size && guard < size * 20; guard++) {
      const c = countryPicker.pick(rng);
      const id = rng.pick(c.mccmncIds);
      picked.add(world.mccmncById.get(id)!);
    }
    const margin = rng.float(0.08, 0.3);
    const negative = rng.float(0, 0.06);
    const table: RateTable = {
      id: tableId++,
      kind: "customer",
      name: `${e.alias}_${cat}_${currency}${rng.chance(0.15) ? "_v2" : ""}`,
      categoryId,
      currency,
      vendorTrunkId: null,
      insertedAt: Math.max(owner?.insertedAt ?? world.historyStart, world.historyStart),
      lines: new Map(),
    };
    const model: PriceModel = {
      initialUsd: (m) => {
        const cost = world.countryById.get(m.countryId)!.basePriceUsd * m.priceFactor;
        // A few lines sell below the market cost (negative margin, spec §13.12).
        return rng.chance(negative) ? cost * rng.float(0.85, 0.97) : cost * (1 + margin) * rng.float(0.96, 1.04);
      },
      changeProb: [0.06, 0.22],
      gapDays: [30, 120],
    };
    const senderLines: { senderId: string; m: Mccmnc }[] = [];
    if (owner && rng.chance(0.1)) {
      for (const m of rng.sample(
        [...picked].filter((x) => !x.isAllNetworks),
        rng.int(1, 5),
      )) {
        senderLines.push({ senderId: rng.pick(owner.senders), m });
      }
    }
    await writeTable(
      world,
      rng,
      sink,
      table,
      [...picked],
      senderLines,
      model,
      [...ratesTeam, ...sales],
      owner?.deletedAt ?? null,
      false,
    );
    const list = tablesByCategory.get(categoryId) ?? [];
    list.push(table);
    tablesByCategory.set(categoryId, list);
    return table;
  };

  for (const [i, t] of trunks.entries()) {
    let table: RateTable;
    const same = tablesByCategory.get(t.categoryId);
    if (i < nOwn || !same?.length) table = await makeCustomerTable(t, t.categoryId);
    else table = rng.pick(same); // shared table
    attach.push({ trunk: t, table });
    if (rng.chance(0.1)) {
      const second =
        rng.chance(0.5) && same?.length
          ? rng.pick(same)
          : await makeCustomerTable(t, rng.pick(world.categories.slice(0, 6)).id);
      if (second.id !== table.id) attach.push({ trunk: t, table: second });
    }
  }
  // Unattached tables (spec §13.20 cleanup finds them).
  const extra = Math.max(1, Math.round(nOwn * 0.05));
  for (let i = 0; i < extra; i++) await makeCustomerTable(null, rng.pick(world.categories.slice(0, 6)).id);

  for (const { trunk, table } of attach) {
    trunk.rateTableIds.push(table.id);
    await sink.insert("customer_trunk_rate_tables", {
      customer_trunk_id: trunk.id,
      rate_table_id: table.id,
      position: trunk.rateTableIds.length,
    });
  }
}

async function writeTable(
  world: World,
  rng: Rng,
  sink: TableSink,
  table: RateTable,
  universe: Mccmnc[],
  senderLines: { senderId: string; m: Mccmnc }[],
  model: PriceModel,
  editors: { id: number }[],
  deletedAt: number | null,
  isVendor: boolean,
): Promise<void> {
  world.rateTables.push(table);
  world.rateTableById.set(table.id, table);
  const usdToCcy = fxPerUsd(world, table.currency, world.anchor);
  const round = (x: number) => Number(x.toFixed(table.currency === "INR" ? 4 : 6));
  const owner = rng.pick(editors).id;

  // Events: first load, then changes every gapDays; maybe one scheduled future event.
  const events: number[] = [table.insertedAt];
  for (let t = table.insertedAt; ; ) {
    t += rng.int(model.gapDays[0], model.gapDays[1]) * DAY + rng.int(0, DAY);
    if (deletedAt && t >= deletedAt) break;
    if (t >= world.anchor) {
      if (!deletedAt && rng.chance(0.3)) events.push(Math.floor((world.anchor + rng.int(1, 21) * DAY) / DAY) * DAY);
      break;
    }
    events.push(t);
  }

  const shuffled = rng.shuffle([...universe]);
  const initialCount = Math.max(1, Math.round(shuffled.length * rng.float(0.85, 1)));
  const pending = shuffled.slice(initialCount); // added in later events
  const open = new Map<string, DraftLine>();
  const done: DraftLine[] = [];
  const changeProb = rng.float(model.changeProb[0], model.changeProb[1]);

  for (const [ei, at] of events.entries()) {
    const user = rng.chance(0.7) ? owner : rng.pick(editors).id;
    const counts = { total: 0, new: 0, increase: 0, decrease: 0, closed: 0 };
    const backDated = isVendor && ei > 0 && at < world.anchor && rng.chance(0.08) ? at - rng.int(1, 10) * DAY : null;
    const addLine = (
      m: Mccmnc,
      senderId: string | null,
      rate: number,
      changeType: DraftLine["changeType"],
      stated: number | null,
    ) => {
      const key = senderId ? `${senderId}|${m.code}` : m.code;
      const line: DraftLine = {
        key,
        m,
        senderId,
        rate: round(rate),
        from: at,
        to: Infinity,
        stated,
        blocked: rng.chance(0.005),
        changeType,
        note: changeType === "new" && ei === 0 ? null : rng.chance(0.1) ? "Per vendor notice" : null,
        userId: user,
      };
      open.set(key, line);
      counts.total++;
      if (changeType === "new") counts.new++;
      else if (changeType === "increase") counts.increase++;
      else if (changeType === "decrease") counts.decrease++;
    };

    if (ei === 0) {
      for (const m of shuffled.slice(0, initialCount)) addLine(m, null, model.initialUsd(m) * usdToCcy, "new", null);
      for (const s of senderLines) addLine(s.m, s.senderId, model.initialUsd(s.m) * usdToCcy * 1.3, "new", null);
    } else {
      for (const [key, line] of [...open]) {
        if (line.senderId) continue;
        if (rng.chance(0.008)) {
          line.to = at;
          done.push(line);
          open.delete(key);
          counts.total++;
          counts.closed++;
        } else if (rng.chance(changeProb)) {
          const up = rng.chance(0.55);
          const rate = line.rate * (1 + (up ? 1 : -1) * rng.float(0.02, 0.15));
          line.to = at;
          done.push(line);
          addLine(line.m, null, rate, up ? "increase" : "decrease", backDated);
        }
      }
      const adds = Math.min(pending.length, rng.int(0, Math.ceil(universe.length * 0.03)));
      for (const m of pending.splice(0, adds)) addLine(m, null, model.initialUsd(m) * usdToCcy, "new", null);
    }

    if (isVendor || rng.chance(0.3)) {
      const e = isVendor
        ? world.enterpriseById.get(world.vendorTrunkById.get(table.vendorTrunkId!)!.enterpriseId)!
        : null;
      const d = new Date(at).toISOString().slice(0, 10);
      await sink.insert("rate_imports", {
        id: importId++,
        rate_table_id: table.id,
        file_name: isVendor ? `RN_${e!.alias}_${d}.xlsx` : `${table.name}_${d}.csv`,
        operation: ei === 0 ? "replace" : "update",
        status: "success",
        lines_total: counts.total,
        lines_new: counts.new,
        lines_increase: counts.increase,
        lines_decrease: counts.decrease,
        lines_closed: counts.closed,
        uploaded_by_id: user,
        uploaded_at: new Date(Math.min(at, world.anchor)),
      });
    }
  }
  if (deletedAt) {
    for (const line of open.values()) if (line.from < deletedAt) line.to = Math.max(deletedAt, line.from + DAY);
  }
  done.push(...open.values());

  // Sort by destination then time so ids follow history, then write and index.
  done.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.from - b.from));
  for (const l of done) {
    const id = lineId++;
    const version: RateVersion = { id, from: l.from, to: l.to, rate: l.rate, blocked: l.blocked };
    const list = table.lines.get(l.key);
    if (list) list.push(version);
    else table.lines.set(l.key, [version]);
    await sink.insert("rate_lines", {
      id,
      rate_table_id: table.id,
      mccmnc_id: l.m.id,
      mccmnc: l.m.code,
      dial_code: l.m.prefixes[0] ?? null,
      sender_id: l.senderId,
      rate: l.rate,
      currency: table.currency,
      valid_from: new Date(l.from),
      valid_to: Number.isFinite(l.to) ? new Date(l.to) : null,
      stated_valid_from: l.stated ? new Date(l.stated) : null,
      is_blocked: l.blocked,
      change_type: l.changeType,
      rate_note: l.note,
      created_by_id: l.userId,
      updated_by_id: l.userId,
      inserted_at: new Date(Math.min(l.from, world.anchor)),
      updated_at: new Date(Math.min(Number.isFinite(l.to) ? l.to : l.from, world.anchor)),
    });
  }

  await sink.insert("rate_tables", {
    id: table.id,
    kind: table.kind,
    name: table.name,
    product_category_id: table.categoryId,
    currency: table.currency,
    vendor_trunk_id: table.vendorTrunkId,
    description: isVendor ? "Vendor buy rates" : null,
    created_by_id: owner,
    updated_by_id: owner,
    inserted_at: new Date(table.insertedAt),
    updated_at: new Date(Math.min(events[events.length - 1]!, world.anchor)),
    deleted_at: deletedAt ? new Date(deletedAt) : null,
    deleted_by_id: deletedAt ? owner : null,
  });
}
