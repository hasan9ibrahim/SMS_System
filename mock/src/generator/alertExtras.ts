/**
 * Monitoring alerts (§13.6, §13.7) for build step 5.12: alert rules a NOC would keep, and 90 days of
 * incident history (recovered, mostly acknowledged, some with notes) for the Incidents page. Runs
 * after every other step on its own forked stream, so earlier tables are unchanged for the same seed.
 */
import { DEPARTMENTS, usersOf } from "./admin.js";
import { domainOf } from "./names.js";
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { DAY, type World } from "./world.js";

type Kind = "all" | "customer" | "customer_trunk" | "vendor" | "vendor_trunk" | "country" | "mccmnc" | "sender_id";
interface RuleSeed {
  name: string;
  kind: Kind;
  pick?: number; // how many ids to choose (0 = each)
  values?: string[];
  metric: string;
  type: string;
  value?: number | null;
  baseline?: string | null;
  window: number;
  minSample: number;
  severity: "info" | "warning" | "critical";
  depts: string[];
  email: boolean;
  sound?: boolean;
  partner?: string | null;
  repeat?: number | null;
  cooldown?: number;
  status?: "active" | "inactive";
  hours?: [number[], number, number];
  weight: number; // share of the incident history
}

const RULES: RuleSeed[] = [
  {
    name: "DLR drop – key clients",
    kind: "customer",
    pick: 12,
    metric: "dlr",
    type: "decrease_pct",
    value: 20,
    baseline: "previous_window",
    window: 15,
    minSample: 500,
    severity: "critical",
    depts: ["NOC"],
    email: true,
    repeat: 30,
    weight: 14,
  },
  {
    name: "ASR below 50 % – customer trunks",
    kind: "customer_trunk",
    pick: 0,
    metric: "asr",
    type: "below",
    value: 50,
    window: 15,
    minSample: 300,
    severity: "warning",
    depts: ["NOC"],
    email: true,
    weight: 18,
  },
  {
    name: "Negative margin – customers",
    kind: "customer",
    pick: 0,
    metric: "margin",
    type: "below",
    value: 0,
    window: 60,
    minSample: 1000,
    severity: "critical",
    depts: ["Billing", "Rates"],
    email: true,
    weight: 6,
  },
  {
    name: "Traffic stopped – top clients",
    kind: "customer",
    pick: 15,
    metric: "attempts",
    type: "stopped",
    window: 15,
    minSample: 200,
    severity: "warning",
    depts: ["NOC", "Sales"],
    email: false,
    weight: 10,
  },
  {
    name: "Client started sending",
    kind: "customer",
    pick: 0,
    metric: "attempts",
    type: "started",
    window: 5,
    minSample: 50,
    severity: "info",
    depts: ["Sales"],
    email: false,
    sound: false,
    weight: 12,
  },
  {
    name: "Vendor DLR drop",
    kind: "vendor",
    pick: 0,
    metric: "dlr",
    type: "decrease_pct",
    value: 25,
    baseline: "previous_window",
    window: 15,
    minSample: 500,
    severity: "warning",
    depts: ["NOC"],
    email: true,
    weight: 12,
  },
  {
    name: "Vendor bind down – main routes",
    kind: "vendor_trunk",
    pick: 10,
    metric: "bind_status",
    type: "bind_down",
    window: 1,
    minSample: 0,
    severity: "critical",
    depts: ["NOC"],
    email: true,
    repeat: 15,
    weight: 5,
  },
  {
    name: "Total TPS above platform capacity",
    kind: "all",
    metric: "tps",
    type: "above",
    value: 2400,
    window: 5,
    minSample: 0,
    severity: "warning",
    depts: ["NOC", "Management"],
    email: false,
    weight: 2,
  },
  {
    name: "Volume drop vs yesterday – office hours",
    kind: "all",
    metric: "attempts",
    type: "decrease_pct",
    value: 30,
    baseline: "yesterday",
    window: 60,
    minSample: 10000,
    severity: "critical",
    depts: ["NOC", "Management"],
    email: true,
    hours: [[1, 2, 3, 4, 5], 6, 22],
    weight: 2,
  },
  {
    name: "Delivery delay above 12 s",
    kind: "customer_trunk",
    pick: 0,
    metric: "avg_delivery_delay",
    type: "above",
    value: 12,
    window: 15,
    minSample: 300,
    severity: "warning",
    depts: ["NOC"],
    email: false,
    weight: 8,
  },
  {
    name: "Revenue down vs last week – top 20",
    kind: "customer",
    pick: 20,
    metric: "revenue",
    type: "decrease_pct",
    value: 40,
    baseline: "last_week",
    window: 60,
    minSample: 2000,
    severity: "info",
    depts: ["Sales"],
    email: true,
    sound: false,
    weight: 6,
  },
  {
    name: "Nigeria DLR below 70 %",
    kind: "country",
    values: ["NG"],
    metric: "dlr",
    type: "below",
    value: 70,
    window: 30,
    minSample: 1000,
    severity: "info",
    depts: ["NOC"],
    email: false,
    sound: false,
    weight: 3,
  },
  {
    name: "Partner DLR notice (technical contact)",
    kind: "customer",
    pick: 3,
    metric: "dlr",
    type: "below",
    value: 60,
    window: 30,
    minSample: 500,
    severity: "warning",
    depts: [],
    email: true,
    partner: "technical",
    weight: 2,
  },
  {
    name: "Sender ID spike – BANKALERT",
    kind: "sender_id",
    values: ["BANKALERT"],
    metric: "attempts",
    type: "increase_pct",
    value: 100,
    baseline: "previous_window",
    window: 15,
    minSample: 1000,
    severity: "info",
    depts: ["NOC"],
    email: false,
    status: "inactive",
    weight: 0,
  },
];

const LABEL: Record<string, string> = {
  dlr: "DLR",
  asr: "ASR",
  margin: "Margin",
  attempts: "Attempts",
  tps: "TPS",
  revenue: "Revenue",
  avg_delivery_delay: "Delivery delay",
};

export async function generateAlertExtras(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const full = profile.name === "full";
  const editors = usersOf(world, "NOC", "Admin");
  const deptId = (n: string) => DEPARTMENTS.indexOf(n) + 1;
  const customers = world.enterprises
    .filter((e) => !e.deletedAt && e.type !== "vendor")
    .sort((a, b) => b.size - a.size);
  const vendorsEnt = world.enterprises.filter((e) => !e.deletedAt && e.type !== "customer");
  const cTrunks = world.customerTrunks.filter((t) => t.status === "active");
  const vTrunks = world.vendorTrunks.filter((t) => t.status === "active");
  const domain = domainOf(world.businessCompanies[0]!.name);
  const chosen: { rule: RuleSeed; id: number; ids: number[] }[] = [];

  for (const [i, r] of RULES.entries()) {
    const id = i + 1;
    let ids: number[] = [];
    if (r.pick) {
      if (r.kind === "customer") ids = customers.slice(0, r.pick).map((e) => e.id);
      if (r.kind === "vendor_trunk")
        ids = rng
          .shuffle([...vTrunks])
          .slice(0, r.pick)
          .map((t) => t.id);
    }
    chosen.push({ rule: r, id, ids });
    await sink.insert("alert_rules", {
      id,
      name: r.name,
      status: r.status ?? "active",
      description: null,
      scope_kind: r.kind,
      scope_ids: ids,
      scope_values: r.values ?? [],
      metric: r.metric,
      condition_type: r.type,
      condition_value: r.value ?? null,
      condition_baseline: r.baseline ?? null,
      window_minutes: r.window,
      min_sample: r.minSample,
      active_always: !r.hours,
      active_days: r.hours ? r.hours[0] : [0, 1, 2, 3, 4, 5, 6],
      active_from_hour: r.hours ? r.hours[1] : 0,
      active_to_hour: r.hours ? r.hours[2] : 24,
      severity: r.severity,
      notify_user_ids: r.severity === "critical" ? [1] : [],
      notify_department_ids: r.depts.map(deptId),
      channel_popup: true,
      channel_sound: r.sound ?? true,
      channel_email: r.email,
      email_addresses: r.email && r.severity === "critical" ? [`noc-oncall@${domain}`] : [],
      partner_contact_type: r.partner ?? null,
      repeat_minutes: r.repeat ?? null,
      cooldown_minutes: r.cooldown ?? 15,
      recovery_notice: true,
      last_triggered_at: null,
      updated_by_id: rng.pick(editors).id,
      inserted_at: new Date(world.anchor - rng.int(60, 300) * DAY),
      updated_at: new Date(world.anchor - rng.int(1, 59) * DAY),
      deleted_at: null,
    });
  }

  // Incident history: 90 days, recovered; most warnings and criticals acknowledged.
  const total = full ? 4500 : 300;
  const pool = chosen.filter((c) => c.rule.weight > 0);
  const weights = pool.map((c) => c.rule.weight);
  const sumW = weights.reduce((a, b) => a + b, 0);
  const times = Array.from({ length: total }, () => world.anchor - rng.int(30 * 60_000, 90 * DAY)).sort(
    (a, b) => a - b,
  );
  let noteId = 0;
  for (const [n, start] of times.entries()) {
    let x = rng.int(0, sumW - 1);
    let c = pool[0]!;
    for (const p of pool)
      if ((x -= p.rule.weight) < 0) {
        c = p;
        break;
      }
    const r = c.rule;
    let kind: string = r.kind;
    let entityId: number | null = null;
    let name = "All traffic";
    if (r.kind === "customer") {
      const want = c.ids.length ? rng.pick(c.ids) : null;
      const e = want !== null ? customers.find((q) => q.id === want)! : rng.pick(customers.slice(0, 200));
      entityId = e.id;
      name = e.name;
    } else if (r.kind === "vendor") {
      const e = rng.pick(vendorsEnt);
      entityId = e.id;
      name = e.name;
    } else if (r.kind === "customer_trunk") {
      const t = rng.pick(cTrunks);
      entityId = t.id;
      name = t.name;
    } else if (r.kind === "vendor_trunk") {
      const want = rng.pick(c.ids);
      const t = vTrunks.find((q) => q.id === want) ?? rng.pick(vTrunks);
      entityId = t.id;
      name = t.name;
    } else if (r.kind !== "all") {
      name = `${r.kind.replace("_", " ")} ${(r.values ?? []).join(", ")}`;
      kind = r.kind;
    }
    const label = LABEL[r.metric] ?? r.metric;
    let cur: number | null = null;
    let base: number | null = null;
    let message: string;
    if (r.type === "bind_down") message = `${name} bind down`;
    else if (r.type === "started") message = `${name} started sending (${rng.float(1, 40).toFixed(1)} TPS)`;
    else if (r.type === "stopped") message = `${name} stopped sending (no traffic for ${r.window} min)`;
    else if (r.metric === "dlr" || r.metric === "asr") {
      base = Math.round(rng.float(82, 97) * 10) / 10;
      cur =
        r.type === "below"
          ? Math.round(rng.float(20, (r.value ?? 70) - 1) * 10) / 10
          : Math.round(base * rng.float(0.45, 0.78) * 10) / 10;
      message =
        r.type === "below"
          ? `${name} ${label} ${cur} % below ${r.value} % (${r.window} min)`
          : `${name} ${label} dropped from ${base} % to ${cur} % in ${r.window} min`;
    } else if (r.metric === "avg_delivery_delay") {
      cur = Math.round(rng.float(12.5, 30) * 10) / 10;
      base = 3;
      message = `${name} Delivery delay ${cur} s above 12 s (${r.window} min)`;
    } else if (r.metric === "margin") {
      cur = -Math.round(rng.float(5, 400) * 100) / 100;
      message = `${name} Margin ${cur.toFixed(2)} USD below 0.00 USD (${r.window} min)`;
    } else if (r.metric === "tps") {
      cur = Math.round(rng.float(2410, 2900));
      message = `${name} TPS ${cur} TPS above 2400 TPS (${r.window} min)`;
    } else {
      base = rng.int(20_000, 400_000);
      cur = Math.round(base * rng.float(0.2, 0.65));
      message = `${name} ${label} dropped from ${base.toLocaleString("en-US")} to ${cur.toLocaleString("en-US")} in ${r.window} min${r.baseline === "yesterday" ? " vs yesterday" : r.baseline === "last_week" ? " vs last week" : ""}`;
    }
    const dur = rng.int(3, r.severity === "info" ? 40 : 95) * 60_000 + rng.int(0, 59_000);
    const acked = r.severity !== "info" && rng.chance(r.severity === "critical" ? 0.85 : 0.6);
    const id = n + 1;
    await sink.insert("incidents", {
      id,
      rule_id: c.id,
      severity: r.severity,
      metric: r.metric,
      entity_kind: kind,
      entity_id: entityId,
      entity_name: name,
      message,
      state: "recovered",
      current_value: cur,
      baseline_value: base,
      peak_value: cur === null ? null : r.type === "above" ? cur * rng.float(1, 1.15) : cur * rng.float(0.85, 1),
      started_at: new Date(start),
      ended_at: new Date(start + dur),
      acknowledged_by_id: acked ? rng.pick(editors).id : null,
      acknowledged_at: acked ? new Date(start + rng.int(30_000, Math.min(dur, 20 * 60_000))) : null,
      snoozed_until: null,
      last_notified_at: new Date(start),
      emailed_at: r.email ? new Date(start + (r.severity === "critical" ? 5_000 : rng.int(60_000, 15 * 60_000))) : null,
      digest_pending: false,
    });
    if (acked && rng.chance(0.15))
      await sink.insert("incident_notes", {
        id: ++noteId,
        incident_id: id,
        user_id: rng.pick(editors).id,
        text: rng.pick([
          "Vendor confirmed a network issue on their side; traffic moved to the backup route.",
          "Partner is doing maintenance, expected back within the hour.",
          "Checked with the client, campaign ended as planned.",
          "Rerouted to the secondary vendor while the vendor investigates.",
          "Ticket opened with the vendor NOC.",
          "False alarm: low volume after the business day.",
        ]),
        inserted_at: new Date(start + dur - rng.int(0, 60_000)),
      });
  }
}
