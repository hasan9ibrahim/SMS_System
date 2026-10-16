/**
 * Change history for per-user undo (spec §13.10): creates and field-level edits
 * on route rules, translation rules and trunk settings, bulk vendor replacements
 * and undo entries that point at the change they revert.
 */
import type { Rng } from "./rng.js";
import { json, type TableSink } from "./sink.js";
import { usersOf } from "./admin.js";
import { DAY, type World } from "./world.js";

interface Draft {
  entityType: string;
  entityIds: number[];
  changeType: string;
  diff: { entity_id: number; field: string; before: unknown; after: unknown }[];
  note: string | null;
  userId: number;
  at: number;
}

export async function generateHistory(world: World, rng: Rng, sink: TableSink): Promise<void> {
  const editors = usersOf(world, "NOC", "Rates");
  const drafts: Draft[] = [];
  const when = (from: number) =>
    Math.min(world.anchor - 60_000, from + rng.int(0, Math.max(1, Math.floor((world.anchor - from) / 1000))) * 1000);

  for (const r of world.routeRules) {
    const created = Math.min(r.startsAt, world.anchor - DAY);
    const author = rng.pick(editors).id;
    drafts.push({
      entityType: "route_rule",
      entityIds: [r.id],
      changeType: "create",
      diff: [{ entity_id: r.id, field: "*", before: null, after: r.name }],
      note: null,
      userId: author,
      at: created,
    });
    const edits = rng.weighted([0, 1, 2, 3, 5], [35, 30, 18, 10, 7]);
    let priority = r.priority;
    for (let i = 0; i < edits; i++) {
      const at = when(created);
      const kind = rng.next();
      const userId = rng.chance(0.6) ? author : rng.pick(editors).id;
      if (kind < 0.35 && r.vendors.length > 1 && r.huntPolicy === "percentage") {
        const v = r.vendors[0]!;
        const vendorName = world.vendorTrunkById.get(v.vendorTrunkId)!.name;
        const before = (v.sharePct ?? 50) - rng.pick([10, 20]);
        drafts.push({
          entityType: "route_rule",
          entityIds: [r.id],
          changeType: "edit",
          diff: [{ entity_id: r.id, field: `vendor_share:${vendorName}`, before, after: v.sharePct }],
          note: rng.chance(0.3) ? "DLR improved on this vendor" : null,
          userId,
          at,
        });
      } else if (kind < 0.6) {
        // Always a real change: step the other way at the 1–100 bounds.
        const step = rng.pick([-5, -2, 2, 5]);
        const after = priority + step >= 1 && priority + step <= 100 ? priority + step : priority - step;
        drafts.push({
          entityType: "route_rule",
          entityIds: [r.id],
          changeType: "edit",
          diff: [{ entity_id: r.id, field: "priority", before: priority, after }],
          note: null,
          userId,
          at,
        });
        priority = after;
      } else if (kind < 0.8) {
        const disable = rng.chance(0.5);
        drafts.push({
          entityType: "route_rule",
          entityIds: [r.id],
          changeType: disable ? "disable" : "enable",
          diff: [
            {
              entity_id: r.id,
              field: "status",
              before: disable ? "active" : "inactive",
              after: disable ? "inactive" : "active",
            },
          ],
          note: disable ? "Vendor down" : null,
          userId,
          at,
        });
      } else {
        drafts.push({
          entityType: "route_rule",
          entityIds: [r.id],
          changeType: "edit",
          diff: [{ entity_id: r.id, field: "margin", before: Number((r.margin + 0.0005).toFixed(6)), after: r.margin }],
          note: null,
          userId,
          at,
        });
      }
    }
  }

  // Bulk vendor replacements (one change, many rules).
  const staticRules = world.routeRules.filter((r) => r.vendors.length > 0);
  for (let i = 0; i < Math.max(2, Math.round(staticRules.length / 120)); i++) {
    const from = rng.pick(world.vendorTrunks);
    const to = rng.pick(world.vendorTrunks);
    const touched = rng.sample(staticRules, rng.int(5, 25));
    drafts.push({
      entityType: "route_rule",
      entityIds: touched.map((r) => r.id),
      changeType: "bulk",
      diff: touched.map((r) => ({ entity_id: r.id, field: "vendor", before: from.name, after: to.name })),
      note: `Replace ${from.name} with ${to.name}`,
      userId: rng.pick(editors).id,
      at: world.anchor - rng.int(1, 120) * DAY,
    });
  }

  // Trunk setting edits (TPS changes) — the same change log applies to trunks.
  for (const t of rng.sample(world.customerTrunks, Math.round(world.customerTrunks.length * 0.3))) {
    drafts.push({
      entityType: "customer_trunk",
      entityIds: [t.id],
      changeType: "edit",
      diff: [{ entity_id: t.id, field: "tps", before: Math.max(5, t.tps - 10), after: t.tps }],
      note: "Client asked for more capacity",
      userId: rng.pick(usersOf(world, "NOC")).id,
      at: when(t.insertedAt),
    });
  }

  drafts.sort((a, b) => a.at - b.at);
  let id = 1;
  const edits: { id: number; d: Draft }[] = [];
  for (const d of drafts) {
    const cid = id++;
    if (d.changeType === "edit" || d.changeType === "bulk") edits.push({ id: cid, d });
    await sink.insert("changes", {
      id: cid,
      entity_type: d.entityType,
      entity_ids: d.entityIds,
      change_type: d.changeType,
      diff: json(d.diff),
      note: d.note,
      undo_of_id: null,
      user_id: d.userId,
      ip: `10.20.${rng.int(0, 255)}.${rng.int(1, 254)}`,
      inserted_at: new Date(d.at),
    });
  }
  // Undo entries ("Undo of #4521 by ...").
  for (const { id: target, d } of rng.sample(edits, Math.round(edits.length * 0.03))) {
    const at = Math.min(world.anchor - 1000, d.at + rng.int(1, 3 * 24 * 60) * 60_000);
    const user = world.users.find((u) => u.id === d.userId)!;
    await sink.insert("changes", {
      id: id++,
      entity_type: d.entityType,
      entity_ids: d.entityIds,
      change_type: "undo",
      diff: json(d.diff.map((x) => ({ ...x, before: x.after, after: x.before }))),
      note: `Undo of #${target} by ${user.first[0]}. ${user.last}`,
      undo_of_id: target,
      user_id: d.userId,
      ip: `10.20.${rng.int(0, 255)}.${rng.int(1, 254)}`,
      inserted_at: new Date(at),
    });
  }
}
