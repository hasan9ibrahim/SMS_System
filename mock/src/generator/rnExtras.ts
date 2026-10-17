/**
 * Incoming vendor rate notifications (§13.13 A, §13.32) for build step 5.14: six months of vendor RNs
 * (e-mail and upload) with their lines, decisions, replies and log, plus a queue of recent RNs still
 * pending review. Pending RNs are stored unchecked (checked_at NULL); the mock checks them against the
 * EDR store when it starts. Runs after every other step on its own forked stream, so earlier tables are
 * unchanged for the same seed. Fake data only.
 */
import { usersOf } from "./admin.js";
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { DAY, type World } from "./world.js";

type Change = "new" | "increase" | "decrease" | "unchanged" | "closed";
type Status = "pending" | "accepted" | "partly_accepted" | "rejected" | "failed" | "unmatched";

const REASONS = [
  "Increase on live traffic without the agreed notice",
  "Rates above the contracted price list",
  "Effective date in the past; please resend with a valid date",
  "Destinations not part of our agreement",
];
const midnight = (t: number) => Math.floor(t / DAY) * DAY;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

export async function generateRnExtras(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const full = profile.name === "full";
  const total = full ? 1800 : 80;
  const editors = usersOf(world, "Rates", "Admin");
  const tables = new Map(world.rateTables.map((t) => [t.id, t]));
  const trunks = world.vendorTrunks.filter((t) => !t.deletedAt && t.status === "active" && tables.has(t.rateTableId));
  const ents = new Map(world.enterprises.map((e) => [e.id, e]));
  const year = new Date(world.anchor).getUTCFullYear();
  const times = Array.from({ length: total }, () => world.anchor - rng.int(10 * 60_000, 180 * DAY)).sort(
    (a, b) => a - b,
  );
  let lineId = 1;
  let replyId = 1;
  let logId = 1;
  const noticeOf = new Map<number, number>();

  for (const [i, received] of times.entries()) {
    const id = i + 1;
    const reference = `RN-${year}-${String(id).padStart(6, "0")}`;
    const trunk = rng.pick(trunks);
    const vendor = ents.get(trunk.enterpriseId)!;
    const table = tables.get(trunk.rateTableId)!;
    if (!noticeOf.has(vendor.id)) noticeOf.set(vendor.id, rng.pick([0, 3, 7, 7, 14, 30]));
    const noticeDays = noticeOf.get(vendor.id)!;
    const recent = received > world.anchor - 10 * DAY;
    const status: Status =
      recent && rng.chance(0.55)
        ? rng.chance(0.08)
          ? "unmatched"
          : "pending"
        : rng.weighted(["accepted", "partly_accepted", "rejected", "failed"] as const, [80, 7, 7, 6]);
    const email = rng.chance(0.85);
    const fileName = `${trunk.name.toLowerCase()}_rates_${new Date(received).toISOString().slice(0, 10)}.${rng.pick(["csv", "csv", "xlsx"])}`;

    // Lines: a sample of the table's generic destinations, plus a few new ones.
    const keys = [...table.lines.keys()].filter((k) => !k.includes("|"));
    const n = Math.min(keys.length, status === "failed" ? 0 : rng.int(5, full ? 260 : 40));
    const chosen = rng.shuffle([...keys]).slice(0, n);
    const statedBase = midnight(received) + rng.int(rng.chance(0.06) ? -6 : 1, 35) * DAY;
    interface L {
      code: string;
      cur: number | null;
      next: number | null;
      change: Change;
      stated: number;
    }
    const lines: L[] = [];
    for (const code of chosen) {
      const v = table.lines.get(code)!.find((x) => x.from <= received && x.to > received);
      const cur = v ? v.rate : null;
      let change: Change = rng.weighted(["increase", "decrease", "unchanged", "closed"] as const, [38, 38, 17, 7]);
      if (cur === null) change = "new";
      const next =
        change === "closed"
          ? null
          : change === "unchanged"
            ? cur
            : change === "new"
              ? r6(0.004 + rng.next() * 0.06)
              : r6(cur! * (change === "increase" ? 1 + rng.int(2, 25) / 100 : 1 - rng.int(2, 25) / 100));
      lines.push({ code, cur, next, change, stated: statedBase + (rng.chance(0.1) ? rng.int(1, 10) * DAY : 0) });
    }
    const known = new Set(table.lines.keys());
    for (let k = 0; k < (n ? rng.int(0, 4) : 0); k++) {
      const m = rng.pick(world.mccmnc);
      if (known.has(m.code) || lines.some((l) => l.code === m.code)) continue;
      lines.push({ code: m.code, cur: null, next: r6(0.004 + rng.next() * 0.06), change: "new", stated: statedBase });
    }

    const decidedAt = status === "pending" || status === "unmatched" ? null : received + rng.int(5, 48 * 60) * 60_000;
    const editor = rng.pick(editors).id;
    let flagged = 0;
    let breaches = 0;
    let back = 0;
    let negative = 0;
    const rejectedLines = new Set<number>();
    if (status === "partly_accepted") for (const [k] of lines.entries()) if (rng.chance(0.2)) rejectedLines.add(k);
    const anyFlag = { v: false };
    const lineRows: Record<string, unknown>[] = [];
    for (const [k, l] of lines.entries()) {
      const m = world.mccmnc.find((x) => x.code === l.code);
      const live = status !== "unmatched" && l.cur !== null && rng.chance(0.4);
      const t24 = live ? rng.int(1, 4000) : 0;
      const isFlag = live && (l.change === "increase" || l.change === "closed");
      const breach = l.change === "increase" && l.stated < received + noticeDays * DAY;
      const backdated = l.stated < received;
      const marginNow = live ? Math.round((rng.next() * 40 - 3) * 10) / 10 : null;
      const marginNew =
        marginNow !== null && l.cur && l.next !== null
          ? Math.round((marginNow - ((l.next - l.cur) / l.cur) * 100) * 10) / 10
          : null;
      const turns = marginNew !== null && marginNew < 0 && (marginNow ?? 0) >= 0;
      flagged += +isFlag;
      breaches += +breach;
      back += +backdated;
      negative += +turns;
      if (isFlag || breach) anyFlag.v = true;
      const decision =
        status === "pending" || status === "unmatched"
          ? "pending"
          : status === "rejected"
            ? "rejected"
            : rejectedLines.has(k)
              ? "rejected"
              : "accepted";
      const applied = Math.max(l.stated, decision === "accepted" ? (decidedAt ?? received) : received);
      lineRows.push({
        id: lineId++,
        rn_id: id,
        line_no: k + 2,
        mccmnc_id: m?.id ?? null,
        mccmnc: l.code,
        sender_id: null,
        current_line_id: null,
        current_rate: l.cur,
        new_rate: l.next,
        change_type: l.change,
        stated_from: new Date(l.stated),
        applied_from: new Date(applied),
        live_traffic: live,
        flagged: isFlag,
        notice_breach: breach,
        backdated,
        traffic_1h: live ? Math.round(t24 / 30) : 0,
        traffic_24h: t24,
        traffic_7d: live ? t24 * rng.int(5, 8) : 0,
        sent_between: backdated && live ? rng.int(10, 3000) : 0,
        cost_between: backdated && live && l.cur ? r6(rng.int(10, 3000) * l.cur) : 0,
        affected_customers: live
          ? rng
              .shuffle(world.enterprises.filter((e) => e.type !== "vendor" && !e.deletedAt))
              .slice(0, rng.int(1, 4))
              .map((e) => e.name)
              .sort()
              .join(", ")
          : null,
        margin_now_pct: marginNow,
        margin_new_pct: marginNew,
        turns_negative: turns,
        decision,
        reject_reason: decision === "rejected" ? rng.pick(REASONS) : null,
      });
    }
    const pendingUnchecked = status === "pending";
    const auto = status === "accepted" && !anyFlag.v && rng.chance(0.35);
    const counts = (c: Change) => lines.filter((l) => l.change === c).length;
    const fileErrors =
      status === "failed"
        ? [
            {
              line: 1,
              message: rng.pick([
                "Can't read the sheet: no rate column",
                "Can't read the sheet: no destination column (MCCMNC, MCC + MNC or dial code)",
              ]),
            },
          ]
        : rng.chance(0.1)
          ? [{ line: rng.int(3, 40), message: `unknown destination ${rng.int(10000, 99999)}` }]
          : [];
    const from = `rates@${vendor.domain}`;
    await sink.insert("rate_notifications", {
      id,
      reference,
      vendor_id: status === "unmatched" ? null : vendor.id,
      vendor_trunk_id: status === "unmatched" ? null : trunk.id,
      rate_table_id: status === "unmatched" ? null : table.id,
      currency: status === "unmatched" ? null : table.currency,
      source: email ? "email" : "upload",
      mailbox: email ? "rates" : null,
      from_address: email ? from : null,
      subject: email ? (status === "unmatched" ? "Updated price list" : `Rate update – ${trunk.name}`) : null,
      body: email ? "Dear partner,\n\nPlease find attached our updated rates.\n\nBest regards" : null,
      file_name: fileName,
      file_content: null,
      received_at: new Date(received),
      effective_from: lines.length ? new Date(Math.min(...lines.map((l) => l.stated))) : null,
      status,
      match_reason:
        status === "unmatched" ? null : email ? `trunk name ${trunk.name} in the subject` : "chosen on upload",
      notice_days: noticeDays,
      columns: JSON.stringify([
        { header: "MCCMNC", field: "mccmnc" },
        { header: "Country", field: "country" },
        { header: "Operator", field: "network" },
        { header: "Rate", field: "rate" },
        { header: "Effective Date", field: "effective" },
      ]),
      file_errors: JSON.stringify(fileErrors),
      lines: lines.length,
      new_lines: counts("new"),
      increases: counts("increase"),
      decreases: counts("decrease"),
      unchanged: counts("unchanged"),
      closed: counts("closed"),
      errors: fileErrors.length,
      flagged,
      notice_breaches: breaches,
      backdated: back,
      turns_negative: negative,
      affected_rate_table_ids: [],
      checked_at: pendingUnchecked ? null : new Date(received + 60_000),
      auto_accepted: auto,
      decided_by_id: decidedAt && !auto ? editor : null,
      decided_at: decidedAt ? new Date(auto ? received + 60_000 : decidedAt) : null,
      reject_reason: status === "rejected" || status === "partly_accepted" ? rng.pick(REASONS) : null,
      change_id: null,
      updated_at: new Date(decidedAt ?? received),
    });
    for (const row of lineRows) await sink.insert("rate_notification_lines", row);

    const logs: [number, number | null, string][] = [
      [
        received,
        email ? null : editor,
        `${email ? `Received from ${from}` : "Uploaded"}: ${lines.length} lines` +
          (status === "unmatched"
            ? "; no vendor trunk found"
            : `; trunk found by ${email ? `trunk name ${trunk.name} in the subject` : "chosen on upload"}`),
      ],
    ];
    const reply = async (kind: "successful" | "failed" | "rejected", at: number) => {
      const subject =
        kind === "successful"
          ? `Rates received for ${trunk.name} (${reference})`
          : `Rate file rejected: ${fileName} (${reference})`;
      await sink.insert("rate_notification_replies", {
        id: replyId++,
        rn_id: id,
        kind,
        to_addresses: [from],
        subject,
        body:
          kind === "successful"
            ? `Dear ${vendor.name} team,\n\nWe received your rate file ${fileName} for ${trunk.name} and loaded ${lines.length} lines.`
            : `Dear ${vendor.name} team,\n\nYour rate file ${fileName} for ${trunk.name} was ${kind === "failed" ? "not processed" : "rejected"}.`,
        status: "sent",
        created_at: new Date(at),
        sent_at: new Date(at),
        sent_by_id: kind === "successful" && auto ? null : editor,
      });
      logs.push([
        at,
        kind === "successful" && auto ? null : editor,
        `${kind[0]!.toUpperCase()}${kind.slice(1)} reply sent to ${from}`,
      ]);
    };
    if (status === "failed") await reply("failed", received + 60_000);
    if (decidedAt) {
      if (status === "accepted") {
        logs.push([
          auto ? received + 60_000 : decidedAt,
          auto ? null : editor,
          `${auto ? "Auto-accepted" : "Accepted"} ${lines.length} lines`,
        ]);
        await reply("successful", (auto ? received + 60_000 : decidedAt) + 30_000);
      } else if (status === "rejected" || status === "partly_accepted") {
        if (status === "partly_accepted")
          logs.push([decidedAt, editor, `Accepted ${lines.length - rejectedLines.size} lines`]);
        logs.push([decidedAt, editor, `Rejected ${status === "rejected" ? lines.length : rejectedLines.size} lines`]);
        await reply("rejected", decidedAt + 30_000);
      }
    }
    for (const [at, user, text] of logs)
      await sink.insert("rate_notification_log", { id: logId++, rn_id: id, at: new Date(at), user_id: user, text });
  }
}
