// Observation Deck (build step 5.9, §9): EDR and failed EDR search on the EDR store, templates,
// trouble tickets, repush, downloads, network status, signaling captures, the route simulator and
// network diagnosis, against the seeded database and EDR store. Responses are checked against the
// contract; rows the tests add are removed and trunks they stop are started again.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change, EdrPage, EdrTemplateSaved, NetworkBindPage } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { chRows } from "../src/edr.js";
import { chIso } from "../src/lists/chEngine.js";
import { describeFilter, startEdrDownloads } from "../src/api/edrDownloads.js";
import { buildPcap, diagnose, validIpFilter } from "../src/api/network.js";
import { listFields } from "../src/lists/fields.js";
import { causeName, messageEncoding } from "../src/smpp.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const edrStore = ready && (await chRows<{ n: string }>("SELECT count() AS n FROM edr LIMIT 1")) !== null;
const skip =
  ready && edrStore ? false : "seeded database and EDR store not available (npm run db:up && npm run seed:small)";
const started = new Date();
const run = Date.now().toString(36).slice(-5);
const restart: { side: string; id: number }[] = [];
after(async () => {
  if (ready) {
    for (const t of restart) await call("POST", `/network-binds/${t.side}/${t.id}/start`);
    await db().query("DELETE FROM email_logs WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM edr_downloads WHERE requested_at >= $1", [started]);
    await db().query("DELETE FROM repush_requests WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM signaling_captures WHERE started_at >= $1", [started]);
    await db().query("DELETE FROM edr_templates WHERE inserted_at >= $1", [started]);
  }
  await app.close();
  await closeDb();
});

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });
async function ok<T = any>(operationId: string, res: Promise<LightMyRequestResponse>, status = 200): Promise<T> {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return (/json/.test(String(r.headers["content-type"])) ? r.json() : r.body) as T;
}
const undo = (change: Change | null) =>
  change ? ok("undoChange", call("POST", `/changes/${change.id}/undo`, {})) : Promise.resolve(null);
const DAY = { field: "startTime", op: "between", values: ["2026-10-16T00:00:00Z", "2026-10-16T01:00:00Z"] };

describe("§9 helpers", () => {
  test("message encoding counts septets, units and segments", () => {
    assert.deepEqual(messageEncoding("Hello €", 0), {
      dataCoding: 0,
      label: "GSM 7-bit (SMSC default)",
      chars: 8,
      bitsPerChar: 7,
      segments: 1,
      bytes: 7,
    });
    assert.equal(messageEncoding("x".repeat(160), 0).segments, 1);
    assert.equal(messageEncoding("x".repeat(161), 0).segments, 2);
    assert.equal(messageEncoding("é".repeat(71), 8).segments, 2);
    assert.equal(messageEncoding("é".repeat(70), 8).bytes, 140);
    assert.equal(messageEncoding("x".repeat(141), 3).segments, 2);
  });
  test("cause names, ClickHouse times, filters in words, IP filters", () => {
    assert.equal(causeName(88), "ESME_RTHROTTLED");
    assert.equal(chIso("2026-10-16 21:29:59.98"), "2026-10-16T21:29:59.980Z");
    assert.equal(chIso("2026-10-16 21:29:59"), "2026-10-16T21:29:59.000Z");
    const text = describeFilter(listFields.edrs.fields, {
      logic: "and",
      conditions: [
        DAY as never,
        { field: "isFinalAttempt", op: "eq", value: true },
        { field: "causeCode", op: "in", values: ["88"] },
      ],
    });
    assert.equal(
      text,
      "Start Time between 2026-10-16 00:00 and 2026-10-16 01:00 · Final = Yes · Cause Code in 88 Throttling error",
    );
    assert.ok(validIpFilter("192.0.2.10") && validIpFilter("192.0.2.0/24") && validIpFilter("2001:db8::/32"));
    assert.ok(!validIpFilter("192.0.2.0/33") && !validIpFilter("not-an-ip"));
  });
  test("pcap files are valid libpcap with SMPP over TCP", () => {
    const b = buildPcap(7, "192.0.2.0/28", Date.parse("2026-10-16T10:00:00Z"), 20_000);
    assert.equal(b.readUInt32LE(0), 0xa1b2c3d4);
    assert.equal(b.readUInt32LE(20), 1, "Ethernet link type");
    let off = 24;
    let packets = 0;
    const commands = new Set<number>();
    while (off < b.length) {
      const len = b.readUInt32LE(off + 8);
      const frame = b.subarray(off + 16, off + 16 + len);
      assert.equal(frame.readUInt16BE(12), 0x0800);
      const ip = frame.subarray(14, 34);
      let sum = 0;
      for (let i = 0; i < 20; i += 2) sum += ip.readUInt16BE(i);
      while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
      assert.equal(sum, 0xffff, "IPv4 header checksum");
      const smpp = frame.subarray(54);
      assert.equal(smpp.readUInt32BE(0), smpp.length, "SMPP command_length");
      commands.add(smpp.readUInt32BE(4));
      off += 16 + len;
      packets++;
    }
    assert.ok(packets > 20 && b.length >= 20_000);
    for (const c of [0x04, 0x80000004, 0x05, 0x80000005, 0x15])
      assert.ok(commands.has(c), `command 0x${c.toString(16)}`);
    assert.deepEqual(buildPcap(7, "192.0.2.0/28", 0, 5000), buildPcap(7, "192.0.2.0/28", 0, 5000), "deterministic");
    assert.equal(buildPcap(8, "2001:db8::5", 0, 2000).readUInt16BE(24 + 16 + 12), 0x86dd, "IPv6 frames");
  });
  test("diagnosis output is simulated and repeatable", () => {
    const a = diagnose({ tool: "ping", destination: "smpp.example.net", count: 3 });
    assert.deepEqual(a, diagnose({ tool: "ping", destination: "smpp.example.net", count: 3 }));
    assert.match(a.lines[0]!, /^PING smpp\.example\.net \(203\.0\.113\.\d+\)/);
    assert.equal(diagnose({ tool: "telnet", destination: "198.51.100.20", port: 2775, count: 1 }).exitCode, 0);
    assert.match(
      diagnose({ tool: "telnet", destination: "198.51.100.20", port: 9, count: 1 }).lines.at(-1)!,
      /refused|timed out/,
    );
  });
});

describe("§9 EDR search", { skip }, () => {
  test("filters, name filters as IDs, sort by name, quick search", async () => {
    const page = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", {
        limit: 50,
        filter: { logic: "and", conditions: [DAY, { field: "isFinalAttempt", op: "eq", value: true }] },
      }),
    );
    assert.ok(page.total > 0 && page.rows.length === 50);
    assert.ok(
      page.rows.every(
        (r) => r.isFinalAttempt && r.startTime >= "2026-10-16T00:00" && r.startTime <= "2026-10-16T01:00",
      ),
    );
    const trunk = page.rows.find((r) => r.customerTrunk)!.customerTrunk!;
    const byTrunk = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", {
        limit: 100,
        filter: { logic: "and", conditions: [DAY, { field: "customerTrunk", op: "eq", value: trunk.toLowerCase() }] },
      }),
    );
    assert.ok(byTrunk.rows.length > 0 && byTrunk.rows.every((r) => r.customerTrunk === trunk));
    const notTrunk = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", {
        limit: 1,
        filter: { logic: "and", conditions: [DAY, { field: "customerTrunk", op: "neq", value: trunk }] },
      }),
    );
    const all = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", { limit: 1, filter: { logic: "and", conditions: [DAY] } }),
    );
    assert.equal(notTrunk.total + byTrunk.total, all.total, "eq and neq split the window");
    const sorted = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", {
        limit: 40,
        sort: [{ field: "customerEnterprise", dir: "asc" }],
        filter: { logic: "and", conditions: [DAY] },
      }),
    );
    const names = sorted.rows.map((r) => r.customerEnterprise ?? "");
    assert.deepEqual(
      names,
      [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const paged = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", {
        limit: 40,
        cursor: sorted.nextCursor,
        sort: [{ field: "customerEnterprise", dir: "asc" }],
        filter: { logic: "and", conditions: [DAY] },
      }),
    );
    assert.ok(!paged.rows.some((r) => sorted.rows.some((s) => s.id === r.id)), "pages do not overlap");
    const dnid = page.rows[0]!.dnid;
    const found = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", { limit: 5, search: dnid, filter: { logic: "and", conditions: [DAY] } }),
    );
    assert.ok(found.rows.some((r) => r.dnid === dnid));
    const unrouted = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", {
        limit: 20,
        filter: { logic: "and", conditions: [DAY, { field: "vendorTrunk", op: "empty" }] },
      }),
    );
    assert.ok(unrouted.rows.every((r) => r.vendorTrunkId === 0 && r.vendorTrunk === null));
    const bad = await call("POST", "/edrs/query", {
      filter: { logic: "and", conditions: [{ field: "senderId", op: "regex", value: "(?<=x)" }] },
    });
    assert.equal(bad.statusCode, 400);
  });

  test("failed EDRs have no vendor leg and an error code", async () => {
    const page = await ok(
      "queryFailedEdrs",
      call("POST", "/failed-edrs/query", { limit: 30, filter: { logic: "and", conditions: [DAY] } }),
    );
    assert.ok(page.total > 0);
    assert.ok(
      page.rows.every(
        (r: { causeCode: number; causeText: string }) => r.causeCode !== 0 && r.causeText.startsWith("ESME_"),
      ),
    );
  });
});

describe("§9 templates, trouble ticket, repush", { skip }, () => {
  test("template add, change, undo, delete; unknown columns are refused", async () => {
    const bad = await call("POST", "/edr-templates", { name: `T ${run}`, columns: ["startTime", "nope"] });
    assert.equal(bad.statusCode, 400);
    const created = await ok<EdrTemplateSaved>(
      "createEdrTemplate",
      call("POST", "/edr-templates", { name: `T ${run}`, columns: ["startTime", "dnid"] }),
      201,
    );
    const id = created.record.id;
    const dup = await call("POST", "/edr-templates", { name: `t ${run}`, columns: ["dnid"] });
    assert.equal(dup.statusCode, 400, "names are unique, case-insensitive");
    const changed = await ok<EdrTemplateSaved>(
      "updateEdrTemplate",
      call("PUT", `/edr-templates/${id}`, { name: `T ${run}`, columns: ["dnid", "msgStatus", "startTime"] }),
    );
    assert.deepEqual(changed.record.columns, ["dnid", "msgStatus", "startTime"]);
    await undo(changed.change);
    assert.deepEqual((await ok("getEdrTemplate", call("GET", `/edr-templates/${id}`))).columns, ["startTime", "dnid"]);
    const gone = await ok<EdrTemplateSaved>("archiveEdrTemplate", call("POST", `/edr-templates/${id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
  });

  test("trouble ticket to the vendor: preview, send, e-mail log", async () => {
    const page = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", {
        limit: 3,
        filter: { logic: "and", conditions: [DAY, { field: "vendorTrunkId", op: "gt", value: 0 }] },
      }),
    );
    const ids = page.rows.map((r) => r.id);
    const body = {
      sendTo: "vendor",
      vendorTrunkId: page.rows[0]!.vendorTrunkId,
      templateId: 8,
      subject: "",
      columns: ["submitTime", "dnid", "msgStatus"],
      edrIds: ids,
    };
    const preview = await ok("previewTroubleTicket", call("POST", "/edrs/trouble-ticket/preview", body));
    assert.match(preview.subject, /^Trouble ticket: delivery issue on /);
    for (const id of ids) assert.ok(preview.body.includes(page.rows.find((r) => r.id === id)!.dnid));
    const sent = await ok(
      "sendTroubleTicket",
      call("POST", "/edrs/trouble-ticket", { ...body, subject: `Ticket ${run}`, attachment: null }),
    );
    assert.equal(sent.rows, 3);
    const { rows } = await db().query("SELECT * FROM email_logs WHERE id = $1", [sent.emailLogId]);
    assert.equal(rows[0].email_type, "trouble_ticket");
    assert.equal(rows[0].subject, `Ticket ${run}`);
    const mixed = await call("POST", "/edrs/trouble-ticket/preview", {
      ...body,
      sendTo: "customer",
      vendorTrunkId: null,
    });
    if (new Set(page.rows.map((r) => r.customerEnterpriseId)).size > 1) assert.equal(mixed.statusCode, 400);
  });

  test("repush skips delivered messages", async () => {
    const page = await ok<EdrPage>(
      "queryEdrs",
      call("POST", "/edrs/query", {
        limit: 4,
        filter: { logic: "and", conditions: [DAY, { field: "msgStatus", op: "in", values: ["DELIVRD"] }] },
      }),
    );
    const r = await ok(
      "repushEdrs",
      call("POST", "/edrs/repush", { edrIds: page.rows.map((x) => x.id), vendorTrunkId: page.rows[0]!.vendorTrunkId }),
      201,
    );
    assert.equal(r.edrCount, 0);
    assert.equal(r.skipped, 4);
    assert.equal(r.status, "done");
  });
});

describe("§9 downloads", { skip }, () => {
  test("a CSV export runs in the background and the file matches the count", async () => {
    startEdrDownloads();
    const trunk = (
      await ok<EdrPage>(
        "queryEdrs",
        call("POST", "/edrs/query", { limit: 1, filter: { logic: "and", conditions: [DAY] } }),
      )
    ).rows[0]!.customerTrunk!;
    const query = { filter: { logic: "and", conditions: [DAY, { field: "customerTrunk", op: "eq", value: trunk }] } };
    const total = (await ok<EdrPage>("queryEdrs", call("POST", "/edrs/query", { ...query, limit: 1 }))).total;
    const d = await ok(
      "requestEdrDownload",
      call("POST", "/edr-downloads", {
        kind: "edr",
        fileType: "csv",
        templateId: null,
        columns: ["startTime", "dnid", "customerTrunk"],
        query,
      }),
      201,
    );
    assert.equal(d.status, "pending");
    let row = d;
    for (let i = 0; i < 60 && !["success", "failed"].includes(row.status); i++) {
      await new Promise((r) => setTimeout(r, 500));
      const page = await ok(
        "queryEdrDownloads",
        call("POST", "/edr-downloads/query", {
          filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: d.id }] },
        }),
      );
      row = page.rows[0];
    }
    assert.equal(row.status, "success", row.error);
    assert.equal(row.rows, total);
    const file = await call("GET", `/edr-downloads/${d.id}/file`);
    assert.equal(file.statusCode, 200);
    const lines = file.body.trim().split("\n");
    assert.equal(lines[0], '"Start Time","DNID","Customer Trunk"');
    assert.equal(lines.length - 1, total);
    assert.ok(lines.slice(1).every((l) => l.includes(`"${trunk}"`)));
    assert.equal((await call("POST", `/edr-downloads/${d.id}/cancel`)).statusCode, 409);
    const badCol = await call("POST", "/edr-downloads", {
      kind: "failed_edr",
      fileType: "xlsx",
      templateId: null,
      columns: ["vendorTrunk"],
      query: {},
    });
    assert.equal(badCol.statusCode, 400, "failed EDRs have no vendor columns");
  });
});

describe("§9 network status, captures, simulator, diagnosis", { skip }, () => {
  test("stop and start trunks; sessions follow", async () => {
    const page = await ok<NetworkBindPage>(
      "queryNetworkBinds",
      call("POST", "/network-binds/query", {
        limit: 5,
        filter: {
          logic: "and",
          conditions: [
            { field: "side", op: "eq", value: "vendor" },
            { field: "status", op: "in", values: ["online"] },
          ],
        },
      }),
    );
    const v = page.rows[0]!;
    assert.ok(v.queue !== null && v.connections > 0);
    const sessions = await ok("listBindSessions", call("GET", `/network-binds/vendor/${v.trunkId}/sessions`));
    assert.equal(sessions.sessions.length, v.connections);
    restart.push({ side: "vendor", id: v.trunkId });
    const stopped = await ok("stopTrunkBind", call("POST", `/network-binds/vendor/${v.trunkId}/stop`));
    assert.equal(stopped.status, "stopped");
    assert.equal(
      (await ok("listBindSessions", call("GET", `/network-binds/vendor/${v.trunkId}/sessions`))).sessions.length,
      0,
    );
    const back = await ok("startTrunkBind", call("POST", `/network-binds/vendor/${v.trunkId}/start`));
    assert.equal(back.status, "online");
    assert.equal(back.connections, back.maxConnections);
    const csv = await call("POST", "/network-binds/export", {
      query: { filter: { logic: "and", conditions: [{ field: "side", op: "eq", value: "vendor" }] } },
      fileType: "csv",
    });
    assert.match(csv.body.split("\n")[0]!, /Queue/);
  });

  test("captures start, stop and download as pcap", async () => {
    assert.equal(
      (
        await call("POST", "/signaling-captures", {
          ipFilter: "300.1.2.3",
          maxDurationSeconds: 10,
          maxFileSizeBytes: 4096,
        })
      ).statusCode,
      400,
    );
    const c = await ok(
      "startSignalingCapture",
      call("POST", "/signaling-captures", {
        ipFilter: "192.0.2.15",
        maxDurationSeconds: 60,
        maxFileSizeBytes: 1_048_576,
      }),
      201,
    );
    assert.equal(c.status, "running");
    const s = await ok("stopSignalingCapture", call("POST", `/signaling-captures/${c.id}/stop`));
    assert.equal(s.status, "stopped");
    const file = await call("GET", `/signaling-captures/${c.id}/file`);
    assert.equal(file.statusCode, 200);
    assert.equal(file.rawPayload.readUInt32LE(0), 0xa1b2c3d4);
  });

  test("route simulator and diagnosis", async () => {
    const { rows } = await db().query(
      `SELECT t.id FROM customer_trunks t WHERE t.deleted_at IS NULL AND t.status = 'active'
         AND EXISTS (SELECT 1 FROM customer_trunk_rate_tables x WHERE x.customer_trunk_id = t.id) ORDER BY t.id LIMIT 1`,
    );
    const sim = await ok(
      "runRouteSimulator",
      call("POST", "/route-simulator", {
        customerTrunkId: Number(rows[0].id),
        senderId: "INFO",
        receiver: "447700900123",
        sourceTon: 5,
        sourceNpi: 0,
        destTon: 1,
        destNpi: 1,
        text: "Your code is 1234",
        dataCoding: 0,
        testSms: true,
      }),
    );
    assert.equal(sim.encoding.segments, 1);
    assert.ok(sim.testSms);
    if (sim.blocked) assert.equal(sim.testSms.status, "REJECTD");
    const unknown = await call("POST", "/route-simulator", {
      customerTrunkId: 999999,
      receiver: "447700900123",
      sourceTon: 1,
      sourceNpi: 1,
      destTon: 1,
      destNpi: 1,
      dataCoding: 0,
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(
      (await call("POST", "/network-diagnosis", { tool: "telnet", destination: "198.51.100.20" })).statusCode,
      400,
    );
    const ping = await ok(
      "runNetworkDiagnosis",
      call("POST", "/network-diagnosis", { tool: "mtr", destination: "198.51.100.20", count: 3 }),
    );
    assert.match(ping.command, /^mtr --report -c 3/);
  });
});
