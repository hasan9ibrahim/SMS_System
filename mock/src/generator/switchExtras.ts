/**
 * Switch utilities (§8) for build step 5.8: e-mail logs for the last 90 days, firewall filters
 * and banned / trusted IPs, traffic alerts, SMS-to-voice rules and past broadcasts. Runs after
 * every other step on its own forked stream, so earlier tables are unchanged for the same seed.
 * IPs are documentation ranges (RFC 5737 / RFC 3849) or the trunks' own fake addresses.
 */
import { usersOf } from "./admin.js";
import { domainOf } from "./names.js";
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { DAY, type World } from "./world.js";

const FAILURES = [
  "SMTP connection timed out",
  "550 5.1.1 Recipient address rejected: unknown user",
  "552 5.2.2 Mailbox full",
  "421 4.7.0 Temporary server error, try again later",
];

/** E-mail types the platform sends on its own, with relative volume and the contact they go to. */
const TYPES: { type: string; weight: number; contact: string; trunk?: "customer" | "vendor" }[] = [
  { type: "send_rate", weight: 22, contact: "rates", trunk: "customer" },
  { type: "auto_upload_rate", weight: 6, contact: "rates", trunk: "vendor" },
  { type: "auto_upload_rejected", weight: 1, contact: "rates", trunk: "vendor" },
  { type: "bind_down_alert", weight: 14, contact: "technical", trunk: "customer" },
  { type: "send_tech_info", weight: 3, contact: "technical", trunk: "customer" },
  { type: "credit_alert", weight: 7, contact: "finance" },
  { type: "balance_alert", weight: 5, contact: "finance" },
  { type: "daily_report", weight: 14, contact: "commercial" },
  { type: "schedule_report_alert", weight: 3, contact: "commercial" },
  { type: "traffic_alert", weight: 4, contact: "technical", trunk: "customer" },
  { type: "trouble_ticket", weight: 2, contact: "technical", trunk: "customer" },
  { type: "otp", weight: 4, contact: "user" },
  { type: "forgot_password", weight: 1, contact: "user" },
  { type: "check_smtp", weight: 1, contact: "user" },
];

const SUBJECTS: Record<string, string> = {
  send_rate: "Rate update for {trunk}",
  auto_upload_rate: "Rate file received for {trunk}",
  auto_upload_rejected: "Rate file rejected for {trunk}",
  bind_down_alert: "Bind down: {trunk}",
  send_tech_info: "Connection details for {trunk}",
  credit_alert: "Credit limit warning – {enterprise}",
  balance_alert: "Low balance – {enterprise}",
  daily_report: "Daily traffic report – {enterprise}",
  schedule_report_alert: "Scheduled report ready – {enterprise}",
  traffic_alert: "Traffic alert on {trunk}",
  trouble_ticket: "Trouble ticket update – {trunk}",
  otp: "Your sign-in code",
  forgot_password: "Reset your password",
  check_smtp: "SMTP connection test",
};

export async function generateSwitchExtras(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const noc = usersOf(world, "NOC");
  const rates = usersOf(world, "Rates");
  const companyDomain = new Map(world.businessCompanies.map((b) => [b.id, domainOf(b.name)]));
  const live = world.enterprises.filter((e) => !e.deletedAt);
  const custTrunks = world.customerTrunks.filter((t) => !t.deletedAt);
  const vendTrunks = world.vendorTrunks.filter((t) => !t.deletedAt);
  const custByEnt = new Map<number, typeof custTrunks>();
  for (const t of custTrunks) custByEnt.set(t.enterpriseId, [...(custByEnt.get(t.enterpriseId) ?? []), t]);
  const vendByEnt = new Map<number, typeof vendTrunks>();
  for (const t of vendTrunks) vendByEnt.set(t.enterpriseId, [...(vendByEnt.get(t.enterpriseId) ?? []), t]);
  const sizes = live.map((e) => e.size + 0.002);

  // ----- firewall filters and rules -----
  const filters = [
    { id: 1, name: "SMPP binds", listener: "smpp", failed: 5, window: 60, ban: 60 },
    { id: 2, name: "HTTP API", listener: "http", failed: 10, window: 60, ban: 30 },
    { id: 3, name: "Customer portal", listener: "portal", failed: 5, window: 300, ban: 15 },
    { id: 4, name: "All listeners", listener: "all", failed: 20, window: 60, ban: 1440 },
  ];
  for (const f of filters)
    await sink.insert("firewall_filters", {
      id: f.id,
      name: f.name,
      listener: f.listener,
      status: "active",
      failed_attempts: f.failed,
      window_seconds: f.window,
      ban_minutes: f.ban,
      updated_by_id: rng.pick(noc).id,
      inserted_at: new Date(world.anchor - 400 * DAY),
      updated_at: new Date(world.anchor - rng.int(10, 200) * DAY),
      deleted_at: null,
    });
  let ruleId = 1;
  const used = new Set<string>();
  const rule = async (r: Record<string, unknown>) => {
    const key = `${r.ip}:${r.filter_id}`;
    if (used.has(key)) return;
    used.add(key);
    await sink.insert("firewall_rules", { id: ruleId++, ...r });
  };
  for (const t of rng.sample(custTrunks, Math.min(70, custTrunks.length))) {
    for (const ip of t.hostIps.slice(0, 2))
      await rule({
        list: "trusted",
        ip: `${ip}/32`,
        filter_id: t.protocol === "smpp" ? 1 : 2,
        source: "manual",
        reason: `Customer trunk ${t.name}`,
        hits: rng.int(0, 50_000),
        last_hit_at: new Date(world.anchor - rng.int(0, 3600) * 1000),
        expires_at: null,
        created_by_id: rng.pick(noc).id,
        inserted_at: new Date(t.insertedAt),
        updated_at: new Date(t.insertedAt),
        deleted_at: null,
      });
  }
  const banned = profile.name === "full" ? 140 : 30;
  for (let i = 0; i < banned; i++) {
    const auto = rng.chance(0.8);
    const at = world.anchor - rng.int(0, 30 * 24) * 3600_000;
    const f = filters[rng.weighted([0, 1, 2, 3], [6, 2, 2, 1])]!;
    const v6 = rng.chance(0.1);
    const ip = v6
      ? `2001:db8:${rng.int(1, 0xffff).toString(16)}::${rng.int(1, 0xffff).toString(16)}/128`
      : rng.chance(0.85) || auto
        ? `198.51.100.${rng.int(1, 254)}/32`
        : `198.51.100.${rng.pick([0, 64, 128, 192])}/26`;
    await rule({
      list: "banned",
      ip,
      filter_id: f.id,
      source: auto ? "auto" : "manual",
      reason: auto
        ? `${f.failed + rng.int(0, 15)} failed attempts in ${f.window} s`
        : rng.pick(["Port scan", "Spam traffic source", "Abuse report from upstream"]),
      hits: rng.int(1, 9000),
      last_hit_at: new Date(at + rng.int(0, 3600) * 1000),
      expires_at: auto ? new Date(at + f.ban * 60_000 * rng.int(1, 30)) : null,
      created_by_id: auto ? null : rng.pick(noc).id,
      inserted_at: new Date(at),
      updated_at: new Date(at),
      deleted_at: null,
    });
  }

  // ----- e-mail logs (last 90 days) -----
  let logId = 1;
  const perDay = profile.name === "full" ? 160 : 30;
  const weights = TYPES.map((t) => t.weight);
  const users = world.users;
  for (let d = 90; d >= 0; d--) {
    const dayStart = world.anchor - d * DAY;
    for (let i = 0; i < perDay; i++) {
      const at = dayStart - rng.int(0, DAY - 1);
      if (at > world.anchor) continue;
      const kind =
        TYPES[
          rng.weighted(
            TYPES.map((_, k) => k),
            weights,
          )
        ]!;
      let to: string[];
      let enterpriseId: number | null = null;
      let custId: number | null = null;
      let vendId: number | null = null;
      let label = { enterprise: "", trunk: "" };
      let sender: string;
      if (kind.contact === "user") {
        const u = rng.pick(users);
        to = [`${u.username}@${companyDomain.get(u.businessCompanyId)}`];
        sender = `noreply@${companyDomain.get(1)}`;
      } else {
        const e =
          live[
            rng.weighted(
              live.map((_, k) => k),
              sizes,
            )
          ]!;
        enterpriseId = e.id;
        to = [`${kind.contact}@${e.domain}`];
        sender = `${kind.contact === "finance" ? "billing" : kind.contact === "rates" ? "rates" : "noc"}@${companyDomain.get(e.businessCompanyId)}`;
        label = { enterprise: e.name, trunk: e.name };
        if (kind.trunk === "customer") {
          const t = custByEnt.get(e.id);
          if (t?.length) {
            const tr = rng.pick(t);
            custId = tr.id;
            label.trunk = tr.name;
          }
        } else if (kind.trunk === "vendor") {
          const t = vendByEnt.get(e.id);
          if (t?.length) {
            const tr = rng.pick(t);
            vendId = tr.id;
            label.trunk = tr.name;
          }
        }
      }
      const failed = rng.chance(0.02);
      const subject = SUBJECTS[kind.type]!.replace("{trunk}", label.trunk).replace("{enterprise}", label.enterprise);
      const day = new Date(at).toISOString().slice(0, 10);
      await sink.insert("email_logs", {
        id: logId++,
        enterprise_id: enterpriseId,
        customer_trunk_id: custId,
        vendor_trunk_id: vendId,
        email_type: kind.type,
        status: failed ? "failed" : "sent",
        rate_date: kind.type === "send_rate" || kind.type === "auto_upload_rate" ? day : null,
        file_name:
          kind.type === "send_rate"
            ? `Rates_${label.trunk.replace(/\W+/g, "_")}_${day}.xlsx`
            : kind.type === "daily_report"
              ? `Daily_${day}.csv`
              : null,
        error: failed ? rng.pick(FAILURES) : null,
        sender,
        to_addresses: to,
        cc_addresses: kind.type === "send_rate" && rng.chance(0.3) ? [`am@${sender.split("@")[1]}`] : [],
        subject,
        body: `${subject}.\n\n(Generated for the frontend phase.)`,
        user_id:
          kind.type === "send_rate" || kind.type === "send_tech_info"
            ? rng.pick(kind.type === "send_rate" ? rates : noc).id
            : null,
        inserted_at: new Date(at),
      });
    }
  }

  // ----- broadcasts (each one also e-mails every enterprise of the audience) -----
  const topics = [
    "Planned maintenance on SMPP listeners",
    "New routes available for West Africa",
    "Holiday support hours",
    "Updated billing contact details",
    "Platform upgrade completed",
    "Security notice: rotate your SMPP passwords",
  ];
  let broadcastId = 1;
  for (let k = 0; k < (profile.name === "full" ? 8 : 3); k++) {
    const bc = rng.pick(world.businessCompanies);
    const at = world.anchor - rng.int(5, 360) * DAY;
    const types = rng.chance(0.5) ? ["customer", "reciprocal"] : ["customer", "vendor", "reciprocal"];
    const contacts = rng.chance(0.5) ? ["commercial", "technical"] : ["commercial"];
    const audience = live.filter((e) => e.businessCompanyId === bc.id && types.includes(e.type) && e.insertedAt < at);
    const subject = rng.pick(topics);
    const sender = `${rng.pick(["noc", "sales", "support"])}@${companyDomain.get(bc.id)}`;
    await sink.insert("broadcasts", {
      id: broadcastId++,
      business_company_id: bc.id,
      sender,
      subject,
      body_html: `<p>Dear partner,</p><p>${subject}.</p><p>Kind regards,<br>${bc.name}</p>`,
      contact_types: contacts,
      enterprise_types: types,
      enterprises: audience.length,
      addresses: audience.length * contacts.length,
      failed: 0,
      attachment_name: rng.chance(0.3) ? "notice.pdf" : null,
      sent_by_id: rng.pick(noc).id,
      inserted_at: new Date(at),
    });
    if (world.anchor - at > 90 * DAY) continue; // logs are kept for 90 days here
    for (const e of audience)
      await sink.insert("email_logs", {
        id: logId++,
        enterprise_id: e.id,
        customer_trunk_id: null,
        vendor_trunk_id: null,
        email_type: "broadcast",
        status: "sent",
        rate_date: null,
        file_name: null,
        error: null,
        sender,
        to_addresses: contacts.map((c) => `${c}@${e.domain}`),
        cc_addresses: [],
        subject,
        body: `Dear partner,\n\n${subject}.`,
        user_id: null,
        inserted_at: new Date(at + rng.int(0, 600) * 1000),
      });
  }

  // ----- traffic alerts -----
  let alertId = 1;
  // Busiest trunks first: EDR volume follows enterprise size × the trunk's share of it.
  const volume = (t: (typeof custTrunks)[number]) => (world.enterpriseById.get(t.enterpriseId)?.size ?? 0) * t.share;
  const busy = [...custTrunks].filter((t) => t.status === "active").sort((a, b) => volume(b) - volume(a));
  for (const t of busy.slice(0, profile.name === "full" ? 45 : 10)) {
    const e = world.enterpriseById.get(t.enterpriseId)!;
    await sink.insert("traffic_alerts", {
      id: alertId++,
      name: `${t.name} quality`,
      sample_count: rng.pick([50, 100, 200, 500]),
      sample_minutes: rng.pick([15, 30, 60]),
      asr_threshold: rng.pick([60, 70, 80]),
      dlr_threshold: rng.pick([40, 50, 60]),
      margin_threshold: rng.pick([0, 2, 5]),
      customer_trunk_id: t.id,
      vendor_trunk_id: null,
      sender_id: null,
      mccmnc: null,
      delay_threshold: rng.chance(0.4) ? rng.pick([30, 60, 120]) : null,
      notification_emails: [`noc@${companyDomain.get(e.businessCompanyId)}`],
      contact_email: rng.chance(0.3) ? "technical" : "none",
      template_id: 5,
      status: rng.chance(0.9) ? "active" : "inactive",
      state: "unknown",
      last_checked_at: null,
      last_triggered_at: null,
      last_values: null,
      updated_by_id: rng.pick(noc).id,
      inserted_at: new Date(world.anchor - rng.int(10, 300) * DAY),
      updated_at: new Date(world.anchor - rng.int(0, 10) * DAY),
      deleted_at: null,
    });
  }

  // ----- SMS to voice -----
  const voice = [
    { sender: "%OTP%", prefix: "4420", repeat: 2 },
    { sender: "%VERIFY%", prefix: "4930", repeat: 2 },
    { sender: null, prefix: "331", repeat: 3 },
    { sender: "%BANK%", prefix: "97142", repeat: 2 },
    { sender: null, prefix: "6562", repeat: 2 },
    { sender: "%CODE%", prefix: "3491", repeat: 3 },
    { sender: null, prefix: "1212555", repeat: 2 },
    { sender: "%OTP%", prefix: "9122", repeat: 2 },
    { sender: "%PIN%", prefix: "2341", repeat: 3 },
    { sender: null, prefix: "6129", repeat: 2 },
    { sender: "%AUTH%", prefix: "3120", repeat: 2 },
    { sender: null, prefix: "48222", repeat: 2 },
  ];
  let voiceId = 1;
  for (const v of voice)
    await sink.insert("sms_voice_rules", {
      id: voiceId++,
      sender_id: v.sender,
      receiver_id: null,
      prefix: v.prefix,
      repeat_count: v.repeat,
      mccmnc: null,
      status: rng.chance(0.85) ? "active" : "inactive",
      updated_by_id: rng.pick(noc).id,
      inserted_at: new Date(world.anchor - rng.int(30, 300) * DAY),
      updated_at: new Date(world.anchor - rng.int(0, 30) * DAY),
      deleted_at: null,
    });
}
