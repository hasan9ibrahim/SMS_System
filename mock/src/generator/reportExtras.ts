/**
 * Reports (§10, §13.15) for build step 5.10: scheduled reports on the ready-made reports and daily
 * traffic alerts for the busiest partners. Runs after every other step on its own forked stream, so
 * earlier tables are unchanged for the same seed. E-mail addresses use the fake company domains.
 */
import { nextRuns } from "../reports/cron.js";
import { usersOf } from "./admin.js";
import { domainOf } from "./names.js";
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { DAY, type World } from "./world.js";

const SCHEDULES: { name: string; preset: string; interval: string; cron: string; team: string; file: string }[] = [
  { name: "Weekly sales review", preset: "sales", interval: "weekly", cron: "0 6 * * 1", team: "sales", file: "excel" },
  {
    name: "Monthly billing summary",
    preset: "billing",
    interval: "monthly",
    cron: "0 5 1 * *",
    team: "billing",
    file: "excel",
  },
  { name: "NOC morning check", preset: "noc", interval: "daily", cron: "30 6 * * *", team: "noc", file: "pdf" },
  {
    name: "Negative margin – daily",
    preset: "negative_margin",
    interval: "daily",
    cron: "0 7 * * *",
    team: "rates",
    file: "csv",
  },
  {
    name: "Usage per client – monthly",
    preset: "usage_enterprise",
    interval: "monthly",
    cron: "0 4 2 * *",
    team: "billing",
    file: "excel",
  },
  {
    name: "Customer / vendor daily grouping",
    preset: "master_grouping",
    interval: "daily",
    cron: "15 5 * * *",
    team: "noc",
    file: "csv",
  },
  {
    name: "Bilateral partners – monthly",
    preset: "bilateral",
    interval: "monthly",
    cron: "0 8 3 * *",
    team: "sales",
    file: "excel",
  },
  { name: "Hourly NOC snapshot", preset: "noc", interval: "hourly", cron: "0 */4 * * *", team: "noc", file: "csv" },
];

const DAILY_BODY =
  "Dear {enterprise} team,\n\nHere is your traffic summary for {date} (UTC):\n\n{summary}\n\nKind regards,\nAccount management, {company}";

export async function generateReportExtras(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const editors = usersOf(world, "NOC", "Sales", "Billing");
  const anchor = new Date(world.anchor);
  for (const [i, s] of SCHEDULES.entries()) {
    const bc = world.businessCompanies[i % world.businessCompanies.length]!;
    const domain = domainOf(bc.name);
    const last = new Date(anchor.getTime() - rng.int(1, 30) * 3600_000);
    const active = i !== 5;
    await sink.insert("scheduled_reports", {
      id: i + 1,
      name: s.name,
      description: rng.chance(0.6) ? `Sent to the ${s.team} team` : null,
      template_kind: "preset",
      preset_key: s.preset,
      view_id: null,
      status: active ? "active" : "inactive",
      business_company_id: bc.id,
      notification_emails: [`${s.team}@${domain}`, ...(rng.chance(0.4) ? [`management@${domain}`] : [])],
      cron_interval: s.interval,
      cron_frequency: s.interval === "hourly" ? 4 : 1,
      cron_expression: s.cron,
      file_type: s.file,
      email_body: "<p>Hello,</p><p>Attached: <b>{report}</b> for {from} to {to} UTC ({rows} rows).</p>",
      next_run_at: active ? (nextRuns(s.cron, anchor)[0] ?? null) : null,
      last_run_at: last,
      last_status: rng.chance(0.9) ? "sent" : "failed",
      last_error: null,
      updated_by_id: rng.pick(editors).id,
      inserted_at: new Date(world.anchor - rng.int(30, 200) * DAY),
      updated_at: new Date(world.anchor - rng.int(1, 29) * DAY),
      deleted_at: null,
    });
  }
  // Daily traffic alerts for the largest active customers.
  const big = world.enterprises
    .filter((e) => !e.deletedAt && e.type !== "vendor")
    .sort((a, b) => b.size - a.size)
    .slice(0, profile.name === "full" ? 30 : 8);
  for (const [i, e] of big.entries())
    await sink.insert("daily_traffic_alerts", {
      id: i + 1,
      name: `${e.name} – daily summary`,
      status: rng.chance(0.85) ? "active" : "inactive",
      business_company_id: null,
      contact_type: rng.weighted(["commercial", "technical", "finance"], [5, 3, 1]),
      enterprise_id: e.id,
      send_hour: rng.int(5, 8),
      email_body: DAILY_BODY,
      last_sent_at: new Date(world.anchor - rng.int(1, 20) * 3600_000),
      updated_by_id: rng.pick(editors).id,
      inserted_at: new Date(world.anchor - rng.int(20, 300) * DAY),
      updated_at: new Date(world.anchor - rng.int(1, 19) * DAY),
      deleted_at: null,
    });
}
