/**
 * Observation Deck (§9) for build step 5.9: EDR templates, past EDR / failed EDR downloads, repush
 * requests and signaling captures. Runs after every other step on its own forked stream, so earlier
 * tables are unchanged for the same seed. Download windows fall inside the generated EDR period;
 * seeded downloads have no stored file, the mock builds it again when one is downloaded. Bind status
 * and SMPP sessions are kept live by the mock (network status simulator), not generated here.
 */
import { usersOf } from "./admin.js";
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { DAY, type World } from "./world.js";
import { EDR_DEFAULT_COLUMNS } from "../lists/fields.js";

export const EDR_FULL_TEMPLATE = "All message details";

export const EDR_TEMPLATES: { name: string; columns: string[] }[] = [
  {
    name: "NOC – delivery check",
    columns: [
      "startTime",
      "customerEnterprise",
      "customerTrunk",
      "senderId",
      "dnid",
      "customerMccmnc",
      "vendorTrunk",
      "msgStatus",
      "causeCode",
      "deliveryDelaySeconds",
      "customerMsgId",
      "vendorMsgId",
    ],
  },
  {
    name: "Billing – money per message",
    columns: [
      "startTime",
      "customerEnterprise",
      "vendorEnterprise",
      "customerMccmnc",
      "msgCount",
      "customerRate",
      "customerCurrency",
      "revenue",
      "vendorRate",
      "vendorCurrency",
      "cost",
      "isCustomerBillable",
      "isVendorBillable",
    ],
  },
  {
    name: "Trouble ticket – vendor",
    columns: ["submitTime", "vendorMsgId", "dnid", "senderId", "msgStatus", "deliveryError", "deliveryTime"],
  },
  {
    name: "HLR review",
    columns: [
      "startTime",
      "dnid",
      "customerMccmnc",
      "hlrProvider",
      "hlrFetchType",
      "hlrIsPorted",
      "hlrErrorCode",
      "hlrCostSys",
    ],
  },
  {
    name: "Session affinity",
    columns: [
      "startTime",
      "customerTrunk",
      "customerSessionId",
      "customerIp",
      "customerPort",
      "customerBindType",
      "customerMsgId",
      "msgStatus",
    ],
  },
  {
    name: "Routing review",
    columns: [
      "startTime",
      "customerTrunk",
      "customerMccmnc",
      "routeRuleId",
      "routeDecidedBy",
      "vendorTrunk",
      "attemptNo",
      "isFinalAttempt",
      "dlrReroute",
      "causeCode",
    ],
  },
];

const FAILED_COLUMNS = [
  "startTime",
  "customerEnterprise",
  "customerTrunk",
  "customerIp",
  "customerMsgId",
  "senderId",
  "dnid",
  "customerMccmnc",
  "causeCode",
  "causeText",
];

const iso = (t: number) => new Date(t).toISOString();

export async function generateObservationExtras(
  world: World,
  rng: Rng,
  sink: TableSink,
  profile: Profile,
): Promise<void> {
  const noc = usersOf(world, "NOC");
  const custTrunks = world.customerTrunks.filter((t) => !t.deletedAt && t.status === "active");
  const vendTrunks = world.vendorTrunks.filter((t) => !t.deletedAt && t.status === "active");
  // The generated EDRs cover the 30 days before the anchor.
  const edrStart = world.anchor - 30 * DAY;

  // ----- EDR templates -----
  for (const [i, t] of EDR_TEMPLATES.entries())
    await sink.insert("edr_templates", {
      id: i + 1,
      name: t.name,
      columns: t.columns,
      updated_by_id: rng.pick(noc).id,
      inserted_at: new Date(world.anchor - rng.int(60, 300) * DAY),
      updated_at: new Date(world.anchor - rng.int(1, 50) * DAY),
      deleted_at: null,
    });

  // The full message view (team trial round 6): the EDR Search default columns, as a template to start from. Added
  // after the others without drawing from the stream, so the rest of the seed is unchanged.
  await sink.insert("edr_templates", {
    id: EDR_TEMPLATES.length + 1,
    name: EDR_FULL_TEMPLATE,
    columns: EDR_DEFAULT_COLUMNS,
    updated_by_id: noc[0]!.id,
    inserted_at: new Date(world.anchor - 30 * DAY),
    updated_at: new Date(world.anchor - DAY),
    deleted_at: null,
  });

  // ----- past downloads: short windows, one trunk or enterprise each -----
  const downloads = profile.name === "full" ? 48 : 12;
  for (let i = 0; i < downloads; i++) {
    const failedEdr = rng.chance(0.25);
    const from = edrStart + rng.int(0, 29 * 24) * 3600_000;
    const hours = rng.pick([1, 1, 2, 3, 6]);
    const to = from + hours * 3600_000;
    const trunk = rng.pick(custTrunks);
    const conditions: Record<string, unknown>[] = [
      { field: "startTime", op: "between", values: [iso(from), iso(to)] },
      { field: "customerTrunk", op: "eq", value: trunk.name },
    ];
    if (!failedEdr && rng.chance(0.4)) conditions.push({ field: "isFinalAttempt", op: "eq", value: true });
    const template = !failedEdr && rng.chance(0.6) ? rng.int(1, EDR_TEMPLATES.length) : null;
    const columns = failedEdr
      ? FAILED_COLUMNS
      : template
        ? EDR_TEMPLATES[template - 1]!.columns
        : EDR_TEMPLATES[0]!.columns;
    const status = rng.weighted(["success", "failed", "cancelled"], [17, 2, 1]);
    const fileType = rng.chance(0.7) ? "csv" : "xlsx";
    const requestedAt = to + rng.int(1, 14 * 24) * 3600_000;
    const at = Math.min(requestedAt, world.anchor - 60_000);
    const rows = rng.int(failedEdr ? 20 : 300, failedEdr ? 900 : 9000) * hours;
    await sink.insert("edr_downloads", {
      id: i + 1,
      kind: failedEdr ? "failed_edr" : "edr",
      status,
      file_type: fileType,
      file_name:
        status === "success"
          ? `${failedEdr ? "failed_edr" : "edr"}_${i + 1}.${fileType === "csv" ? "csv" : "xls"}`
          : null,
      file_path: null,
      progress: status === "success" ? 100 : status === "failed" ? rng.int(5, 80) : rng.int(0, 40),
      row_count: status === "success" ? rows : null,
      size_bytes: status === "success" ? rows * columns.length * 14 : null,
      query: JSON.stringify({ filter: { logic: "and", conditions } }),
      columns,
      template_id: template,
      template_name: template ? EDR_TEMPLATES[template - 1]!.name : null,
      filter_summary: `Start ${iso(from).slice(0, 16).replace("T", " ")} to ${iso(to).slice(11, 16)} UTC · trunk ${trunk.name}`,
      error: status === "failed" ? "EDR store timed out after 300 s; try a shorter window" : null,
      requested_by_id: rng.pick(noc).id,
      requested_at: new Date(at),
      finished_at:
        status === "success" || status === "failed" ? new Date(at + rng.int(20, 600) * 1000) : new Date(at + 30_000),
    });
  }

  // ----- repush requests -----
  const repushes = profile.name === "full" ? 24 : 6;
  for (let i = 0; i < repushes; i++) {
    const count = rng.weighted([rng.int(1, 20), rng.int(20, 400), rng.int(400, 3000)], [5, 4, 1]);
    const delivered = Math.round(count * rng.float(0.55, 0.95));
    await sink.insert("repush_requests", {
      id: i + 1,
      vendor_trunk_id: rng.pick(vendTrunks).id,
      edr_count: count,
      skipped: rng.chance(0.3) ? rng.int(1, 30) : 0,
      status: "done",
      delivered,
      failed: count - delivered,
      created_by_id: rng.pick(noc).id,
      inserted_at: new Date(world.anchor - rng.int(1, 60 * 24) * 3600_000),
    });
  }

  // ----- signaling captures -----
  const captures = profile.name === "full" ? 32 : 8;
  for (let i = 0; i < captures; i++) {
    const at = world.anchor - rng.int(1, 45 * 24) * 3600_000;
    const ip = rng.chance(0.8) ? rng.pick(rng.pick(custTrunks).hostIps) : null;
    const duration = rng.pick([30, 60, 120, 300, 600]);
    const maxSize = rng.pick([1, 5, 10, 50]) * 1024 * 1024;
    const packets = rng.int(40, 4000);
    const size = Math.min(maxSize, 24 + packets * rng.int(90, 160));
    const stamp = iso(at).slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
    await sink.insert("signaling_captures", {
      id: i + 1,
      file_name: `smpp_${stamp}${ip ? `_${ip}` : ""}.pcap`,
      ip_filter: ip ? `${ip}/32` : null,
      status: rng.weighted(["done", "stopped", "failed"], [16, 3, 1]),
      size_bytes: size,
      packets,
      max_duration_seconds: duration,
      max_file_size_bytes: maxSize,
      started_by_id: rng.pick(noc).id,
      started_at: new Date(at),
      updated_at: new Date(at + duration * 1000),
      // Every sixth file kept on purpose (team trial round 1); the others older than 30 days are deleted
      // by the clean-up. Fixed, so the random stream stays the same.
      keep: i % 6 === 0,
      kept_by_id: i % 6 === 0 ? noc[0]!.id : null,
      kept_at: i % 6 === 0 ? new Date(at + duration * 1000) : null,
    });
  }
}
