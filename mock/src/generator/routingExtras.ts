/**
 * Re-rating requests (§6.3, §12.2) and QBR vendor stat overrides (§6.3) for build step 5.2.
 * Runs after every other step on its own forked stream, so earlier tables are unchanged for
 * the same seed. Processed requests carry their Re-Rating Summary and the Reprocess notes
 * they posted to Transactions; pending ones wait for a second user (maker-checker). QBR
 * traffic figures are not generated: the mock refreshes them from the EDR store.
 */
import { usersOf } from "./admin.js";
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { DAY, fxPerUsd, toBase, type World } from "./world.js";

/** The mock's signed-in user (MOCK_USER_ID, default 1): a few requests are theirs, to show maker-checker. */
const SIGNED_IN_USER = 1;
const money = (v: number) => Math.round(v * 100) / 100;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

export async function generateRoutingExtras(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const billing = usersOf(world, "Billing");
  const approvers = usersOf(world, "Billing", "Management").filter((u) => u.id !== SIGNED_IN_USER);
  const customerTables = world.rateTables.filter((t) => t.kind === "customer");
  const vendorTables = world.rateTables.filter((t) => t.kind === "vendor");
  const trunksOfTable = (tableId: number) => world.customerTrunks.filter((t) => t.rateTableIds.includes(tableId));
  const count = profile.name === "full" ? 40 : 10;
  let resultId = 1;
  let txId = 1_000_000;
  for (let i = 1; i <= count; i++) {
    const side = rng.chance(0.75) ? "customer" : "vendor";
    let tableId: number;
    let enterpriseIds: number[];
    if (side === "customer") {
      const table = rng.pick(customerTables);
      const owners = [...new Set(trunksOfTable(table.id).map((t) => t.enterpriseId))];
      if (!owners.length) continue;
      tableId = table.id;
      enterpriseIds = owners.slice(0, rng.int(1, Math.min(3, owners.length)));
    } else {
      const table = rng.pick(vendorTables);
      const trunk = world.vendorTrunkById.get(table.vendorTrunkId!);
      if (!trunk) continue;
      tableId = table.id;
      enterpriseIds = [trunk.enterpriseId];
    }
    const table = world.rateTableById.get(tableId)!;
    const end = world.anchor - rng.int(1, 50) * DAY;
    const start = end - rng.int(0, 13) * DAY;
    const requestedAt = end + rng.int(1, 5) * DAY;
    const roll = rng.next();
    const status = roll < 0.25 ? "pending" : roll < 0.35 ? "declined" : roll < 0.4 ? "failed" : "completed";
    const requester = status === "pending" && i % 5 === 0 ? SIGNED_IN_USER : rng.pick(billing).id;
    const decider = status === "pending" ? null : rng.pick(approvers.filter((u) => u.id !== requester)).id;
    const decidedAt = requestedAt + rng.int(1, 30) * 3600_000;
    const finishedAt = decidedAt + rng.int(2, 40) * 60_000;
    const noNote = rng.chance(0.15);
    const codes = rng.chance(0.5)
      ? []
      : [...table.lines.keys()].filter((k) => !k.includes("|")).slice(0, rng.int(1, 4));
    let totalEdrs = 0;
    const results: Record<string, unknown>[] = [];
    if (status === "completed") {
      for (const enterpriseId of enterpriseIds) {
        const edrs = rng.int(200, 60_000);
        const old = money(edrs * rng.float(0.005, 0.05));
        const delta = money(old * rng.float(-0.12, 0.12));
        totalEdrs += edrs;
        let transactionId: number | null = null;
        if (!noNote && delta !== 0) {
          transactionId = txId++;
          // Customer: a lower rate is a credit to the customer; vendor: a lower cost is a debit.
          const credit = side === "customer" ? delta < 0 : delta > 0;
          await sink.insert("transactions", {
            id: transactionId,
            enterprise_id: enterpriseId,
            side,
            payment_mode: null,
            payment_type: credit ? "credit" : "debit",
            transaction_type: "reprocess",
            amount: Math.abs(delta),
            currency: table.currency,
            ...toBase(world, enterpriseId, Math.abs(delta), table.currency, finishedAt),
            payment_date: ymd(finishedAt),
            invoice_id: null,
            description: `Re-rating #${i}: ${table.name} ${ymd(start)} to ${ymd(end)}`,
            send_confirmation: false,
            confirmation_status: "not_sent",
            include_in_soa: true,
            exclude_reason: null,
            created_by_id: decider,
            updated_by_id: decider,
            inserted_at: new Date(finishedAt),
            updated_at: new Date(finishedAt),
            deleted_at: null,
          });
        }
        results.push({
          id: resultId++,
          request_id: i,
          enterprise_id: enterpriseId,
          total_edrs: edrs,
          old_amount: old,
          new_amount: money(old + delta),
          currency: table.currency,
          transaction_id: transactionId,
          transaction_status: delta === 0 ? "no_difference" : noNote ? "not_posted" : "posted",
          start_time: new Date(decidedAt + 60_000),
          end_time: new Date(finishedAt),
          updated_by_id: decider,
        });
      }
    }
    await sink.insert("rerating_requests", {
      id: i,
      side,
      reprocess_type: rng.chance(0.15) ? "auto" : "manual",
      description: rng.pick([
        "Rate correction after vendor dispute",
        "Wrong rate loaded for the period",
        "Back-dated RN accepted by billing",
        "Customer rate fix agreed with AM",
        null,
      ]),
      start_date: ymd(start),
      end_date: ymd(end),
      enterprise_ids: enterpriseIds,
      rate_table_id: tableId,
      reason: "rate_correction",
      mccmncs: codes,
      sender_id: null,
      no_note: noNote,
      priority: rng.pick(["P1", "P2", "P2", "P3"]),
      request_status: status === "pending" ? "pending_approval" : status === "declined" ? "declined" : "approved",
      reprocess_status: status === "completed" ? "completed" : status === "failed" ? "failed" : "not_started",
      requested_by_id: requester,
      decided_by_id: decider,
      decided_at: decider ? new Date(decidedAt) : null,
      decline_reason: status === "declined" ? "Amounts not agreed with the partner yet" : null,
      started_at: status === "completed" || status === "failed" ? new Date(decidedAt + 60_000) : null,
      finished_at: status === "completed" || status === "failed" ? new Date(finishedAt) : null,
      total_edrs: status === "completed" ? totalEdrs : null,
      error: status === "failed" ? "EDR store timeout while reading the period; retry the request" : null,
      updated_by_id: decider ?? requester,
      inserted_at: new Date(requestedAt),
      updated_at: new Date(decider ? decidedAt : requestedAt),
    });
    for (const r of results) await sink.insert("rerating_results", r);
  }

  // A few hand-set vendor stats (Add Vendor Stat); traffic figures come from the refresh job.
  const vendors = world.vendorTrunks.filter((v) => v.deletedAt === null);
  const nets = world.mccmnc.filter((m) => !m.isAllNetworks);
  const seen = new Set<string>();
  for (let i = 1; i <= (profile.name === "full" ? 40 : 10); i++) {
    const v = rng.pick(vendors);
    const m = rng.pick(nets);
    if (seen.has(`${v.id}|${m.id}`)) continue;
    seen.add(`${v.id}|${m.id}`);
    const at = world.anchor - rng.int(1, 20) * DAY;
    await sink.insert("qbr_stats", {
      id: i,
      side: "vendor",
      trunk_id: v.id,
      mccmnc_id: m.id,
      attempts: 0,
      asr: null,
      dlr: null,
      add_s: null,
      overridden: true,
      override_asr: rng.chance(0.7) ? Math.round(rng.float(80, 99) * 10) / 10 : null,
      override_dlr: Math.round(rng.float(55, 97) * 10) / 10,
      override_add_s: rng.chance(0.6) ? Math.round(rng.float(2, 40) * 10) / 10 : null,
      updated_by_id: rng.pick(usersOf(world, "NOC", "Rates")).id,
      updated_at: new Date(at),
      refreshed_at: null,
    });
  }
}
