// Backend step 11c (§9.1, §9.2): the TypeScript service's side of the switch commands, against two fake switch servers
// answering on the local NATS as backend/apps/sms_switch/lib/sms/switch/commands.ex does (`smscmd.all|any|node.*`).
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { connect, type NatsConnection } from "nats";
import { closeDb, db, dbReady } from "../src/db.js";
import {
  askAll,
  askAny,
  closeSwitchCommands,
  dataOf,
  SwitchRefused,
  SwitchUnreachable,
  switchProblem,
} from "../src/switch/commands.js";
import {
  captureSources,
  purgeSwitchCaptures,
  refreshCaptures,
  refreshPcapFiles,
  switchBind,
  switchDiagnose,
  switchExtract,
  switchFiles,
  switchRepush,
  switchStartCapture,
  switchTestSms,
  traceSources,
} from "../src/switch/operations.js";

process.env.SWITCH_NODES = "2";
const ready = await dbReady();
let bus: NatsConnection | null = null;
try {
  bus = await connect({ servers: process.env.NATS_URL ?? "nats://127.0.0.1:4222", timeout: 2_000 });
} catch {
  bus = null;
}
const skip = ready && bus ? false : "database or NATS not available";

type Handler = (data: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: string; skip?: boolean } | null;
/** Each fake server's answers by command; a `null` handler or answer stays silent. */
const handlers: Record<string, Record<string, Handler | null>> = { t_a: {}, t_b: {} };
const seen: { node: string; command: string; data: Record<string, unknown> }[] = [];
const uniq = `t${process.pid}`;

function serve(node: string) {
  const answer = (subject: string, data: Uint8Array, reply?: string) => {
    if (!reply) return;
    const command = subject.split(".").pop()!;
    const body = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    seen.push({ node, command, data: body });
    const own = handlers[node]!;
    const out = command in own ? (own[command]?.(body) ?? null) : { ok: false, error: `unknown command ${command}` };
    if (out) bus!.publish(reply, new TextEncoder().encode(JSON.stringify({ node, ...out })));
  };
  for (const [subject, queue] of [
    [`smscmd.all.>`, undefined],
    [`smscmd.any.>`, "switch"],
    [`smscmd.node.${node}.>`, undefined],
  ] as const)
    bus!.subscribe(subject, { queue, callback: (_e, m) => answer(m.subject, m.data, m.reply) });
}

const pool = () => db();
let vendorTrunk = 0;
let customerTrunk = 0;
let user = 0;
const captureIds: number[] = [];

before(async () => {
  if (skip) return;
  serve("t_a");
  serve("t_b");
  await bus!.flush();
  vendorTrunk = Number((await pool().query("SELECT id FROM vendor_trunks ORDER BY id LIMIT 1")).rows[0].id);
  customerTrunk = Number((await pool().query("SELECT id FROM customer_trunks ORDER BY id LIMIT 1")).rows[0].id);
  user = Number((await pool().query("SELECT id FROM users ORDER BY id LIMIT 1")).rows[0].id);
});

after(async () => {
  if (!skip) {
    await pool().query("DELETE FROM pcap_files WHERE node IN ('t_a', 't_b')");
    if (captureIds.length) await pool().query("DELETE FROM signaling_captures WHERE id = ANY($1)", [captureIds]);
  }
  await closeSwitchCommands();
  await bus?.close();
  await closeDb();
});

const reset = () => {
  for (const n of Object.values(handlers)) for (const k of Object.keys(n)) delete n[k];
  seen.length = 0;
};
const both = (command: string, h: Handler) => {
  handlers.t_a![command] = h;
  handlers.t_b![command] = h;
};

async function newCapture(status = "running") {
  const { rows } = await pool().query(
    `INSERT INTO signaling_captures (file_name, status, max_duration_seconds, max_file_size_bytes, started_by_id)
     VALUES ($1, $2, 60, 1000, $3) RETURNING id`,
    [`${uniq}.pcapng`, status, user],
  );
  const id = Number(rows[0].id);
  captureIds.push(id);
  return id;
}
const capture = async (id: number) =>
  (await pool().query("SELECT status, size_bytes::int AS size, packets FROM signaling_captures WHERE id = $1", [id])).rows[0];

describe("switch commands (step 11c)", { skip }, () => {
  test("all waits for every server, any for one; refusals and silence are told apart", async () => {
    reset();
    both("ping", () => ({ ok: true, data: { pong: true } }));
    const all = await askAll<{ pong: boolean }>("ping", {});
    assert.deepEqual(all.map((a) => a.node).sort(), ["t_a", "t_b"]);
    const one = await askAny<{ pong: boolean }>("ping", {});
    assert.equal(dataOf(one).pong, true);

    handlers.t_b!.ping = null;
    assert.deepEqual((await askAll("ping", {}, 300)).map((a) => a.node), ["t_a"]);

    both("nobody", () => null);
    await assert.rejects(askAll("nobody", {}, 200), SwitchUnreachable);
    await assert.rejects(askAny("nobody", {}, 200), SwitchUnreachable);
    assert.throws(() => dataOf({ ok: false, node: "t_a", error: "no" }), SwitchRefused);
  });

  test("the screen gets 503 when the switch is silent, 400 with its reason when it refuses", () => {
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const reply = {
      code(s: number) {
        sent.status = s;
        return this;
      },
      header() {
        return this;
      },
      type() {
        return this;
      },
      send(b: Record<string, unknown>) {
        sent.body = b;
        return this;
      },
    } as never;
    switchProblem(reply, new SwitchUnreachable("x"));
    assert.equal(sent.status, 503);
    assert.equal(sent.body?.code, "switch_unreachable");
    switchProblem(reply, new SwitchRefused("trunk busy"));
    assert.equal(sent.status, 400);
    assert.equal(sent.body?.detail, "trunk busy");
    assert.throws(() => switchProblem(reply, new Error("boom")), /boom/);
  });

  test("Stop marks the trunk stopped and tells every server; Start lets it bind again", async () => {
    reset();
    both("bind", () => ({ ok: true, data: {} }));
    const before = await pool().query("SELECT * FROM trunk_binds WHERE side = 'vendor' AND trunk_id = $1", [vendorTrunk]);
    try {
      await switchBind(pool(), "vendor", vendorTrunk, "stop", user);
      const s = await pool().query("SELECT status FROM trunk_binds WHERE side = 'vendor' AND trunk_id = $1", [vendorTrunk]);
      assert.equal(s.rows[0].status, "stopped");
      assert.equal(seen.filter((x) => x.command === "bind").length, 2);
      assert.deepEqual(seen[0]!.data, { side: "vendor", trunk_id: vendorTrunk });

      await switchBind(pool(), "vendor", vendorTrunk, "start", user);
      const t = await pool().query("SELECT status FROM trunk_binds WHERE side = 'vendor' AND trunk_id = $1", [vendorTrunk]);
      assert.equal(t.rows[0].status, "offline");

      // No switch answering: the trunk is still stopped (the switch reads it within 5 s).
      both("bind", () => null);
      await switchBind(pool(), "vendor", vendorTrunk, "stop", user);
    } finally {
      await pool().query("DELETE FROM trunk_binds WHERE side = 'vendor' AND trunk_id = $1", [vendorTrunk]);
      for (const r of before.rows) {
        const cols = Object.keys(r);
        await pool().query(
          `INSERT INTO trunk_binds (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          cols.map((c) => r[c]),
        );
      }
    }
  });

  test("Repush: what the switch could not send counts as skipped; no answer keeps nothing", async () => {
    reset();
    handlers.t_a!.repush = (d) => ({
      ok: true,
      data: { sent: (d.edr_ids as string[]).length - 2, refused: 1, not_found: 1, reasons: [{ reason: "blocked", count: 1 }] },
    });
    handlers.t_b!.repush = handlers.t_a!.repush;
    const ids: number[] = [];
    try {
      const id = await switchRepush(pool(), vendorTrunk, ["e1", "e2", "e3", "e4"], 3, user);
      ids.push(id);
      const r = (await pool().query("SELECT edr_count, skipped, status FROM repush_requests WHERE id = $1", [id])).rows[0];
      assert.deepEqual(r, { edr_count: 2, skipped: 5, status: "pending" });
      assert.equal(seen.find((s) => s.command === "repush")!.data.request_id, id);

      const none = await switchRepush(pool(), vendorTrunk, [], 2, user);
      ids.push(none);
      assert.equal((await pool().query("SELECT status FROM repush_requests WHERE id = $1", [none])).rows[0].status, "done");

      both("repush", () => ({ ok: true, data: { sent: 0, refused: 1, not_found: 0, reasons: [] } }));
      const allRefused = await switchRepush(pool(), vendorTrunk, ["e1"], 0, user);
      ids.push(allRefused);
      assert.equal((await pool().query("SELECT status FROM repush_requests WHERE id = $1", [allRefused])).rows[0].status, "done");

      const count = Number((await pool().query("SELECT count(*) FROM repush_requests")).rows[0].count);
      both("repush", () => null);
      await assert.rejects(askAny("repush", {}, 200), SwitchUnreachable);
      both("repush", () => ({ ok: false, error: "unknown vendor trunk" }));
      await assert.rejects(switchRepush(pool(), vendorTrunk, ["e1"], 0, user), /unknown vendor trunk/);
      assert.equal(Number((await pool().query("SELECT count(*) FROM repush_requests")).rows[0].count), count);
    } finally {
      await pool().query("DELETE FROM repush_requests WHERE id = ANY($1)", [ids]);
    }
  });

  test("Test SMS: taken, refused with the reason, or the switch did not answer", async () => {
    reset();
    both("test_sms", () => ({ ok: true, data: { message_id: "m-1", status: "ACCEPTD", detail: "Sent to vendor X" } }));
    const ok = await switchTestSms({ customerTrunkId: customerTrunk, receiver: "491511234567", vendorTrunkId: vendorTrunk });
    assert.deepEqual(ok, { messageId: "m-1", status: "ACCEPTD", detail: "Sent to vendor X" });
    const asked = seen.find((s) => s.command === "test_sms")!.data;
    assert.equal(asked.customer_trunk_id, customerTrunk);
    assert.equal(asked.vendor_trunk_id, vendorTrunk);
    assert.equal(asked.sender, null);

    both("test_sms", () => ({ ok: false, error: "receiver must be digits" }));
    const refused = await switchTestSms({ customerTrunkId: customerTrunk, receiver: "x" });
    assert.equal(refused.status, "REJECTD");
    assert.match(refused.detail, /receiver must be digits/);
  });

  test("a live capture starts on every server, its status is summed, and a refusal fails it", async () => {
    reset();
    both("pcap_capture", () => ({ ok: true, data: { started: true } }));
    const id = await newCapture();
    await switchStartCapture(pool(), id, "192.0.2.0/24", 60, 1000);
    assert.equal(seen.filter((s) => s.command === "pcap_capture").length, 2);
    assert.deepEqual(seen[0]!.data, { id, ip_filter: "192.0.2.0/24", max_duration_s: 60, max_bytes: 1000 });

    handlers.t_a!.pcap_status = () => ({ ok: true, data: { captures: [{ id, running: true, exists: true, size: 10, packets: 2 }] } });
    handlers.t_b!.pcap_status = () => ({ ok: true, data: { captures: [{ id, running: false, exists: true, size: 5, packets: 1 }] } });
    assert.ok((await refreshCaptures(pool())) >= 1);
    assert.deepEqual(await capture(id), { status: "running", size: 15, packets: 3 });

    handlers.t_a!.pcap_status = handlers.t_b!.pcap_status;
    await refreshCaptures(pool());
    assert.deepEqual(await capture(id), { status: "done", size: 10, packets: 2 });

    both("pcap_capture", () => ({ ok: false, error: "capture is already running" }));
    const refused = await newCapture();
    await assert.rejects(switchStartCapture(pool(), refused, null, 60, 1000), /already running/);
    assert.equal((await capture(refused)).status, "failed");
  });

  test("an extract asks every server with the criteria; a capture's file is read from the servers holding it", async () => {
    reset();
    both("pcap_extract", () => ({ ok: true, data: { started: true, files: 1 } }));
    const id = await newCapture();
    await switchExtract(pool(), id, {
      from: "2026-10-25T12:00:00Z",
      to: "2026-10-25T12:15:00Z",
      ipFilters: ["192.0.2.1"],
      number: "4915",
      messageId: null,
    });
    assert.deepEqual(seen[0]!.data, {
      id,
      from: "2026-10-25T12:00:00Z",
      to: "2026-10-25T12:15:00Z",
      ip_filters: ["192.0.2.1"],
      number: "4915",
      message_id: null,
    });

    handlers.t_a!.pcap_status = () => ({ ok: true, data: { captures: [{ id, running: false, exists: true, size: 6, packets: 1 }] } });
    handlers.t_b!.pcap_status = () => ({ ok: true, data: { captures: [{ id, running: false, exists: true, size: 0, packets: 0 }] } });
    assert.deepEqual(await captureSources(id), [{ node: "t_a", file: `capture-${id}.pcapng` }]);

    // Read in chunks until eof; two servers' files come one after the other.
    const files: Record<string, string> = { t_a: "AAAABBBB", t_b: "CCCC" };
    for (const node of ["t_a", "t_b"])
      handlers[node]!.pcap_read = (d) => {
        const body = files[node]!;
        const offset = Number(d.offset);
        const part = body.slice(offset, offset + 3);
        return { ok: true, data: { data: Buffer.from(part).toString("base64"), size: body.length, eof: offset + 3 >= body.length } };
      };
    const chunks: Buffer[] = [];
    for await (const c of switchFiles([
      { node: "t_a", file: "x" },
      { node: "t_b", file: "y" },
    ]))
      chunks.push(c as Buffer);
    assert.equal(Buffer.concat(chunks).toString(), "AAAABBBBCCCC");
  });

  test("the recording's files are kept per server for the PCAP Trace list; a quarter's files are found", async () => {
    reset();
    handlers.t_a!.pcap_files = () => ({
      ok: true,
      data: {
        files: [
          { name: "smpp_00001_20261025120000.pcapng", started_at: "2026-10-25T12:00:00Z", size: 100, modified_at: "2026-10-25T12:15:00Z" },
          { name: "smpp_00002_20261025121500.pcapng", started_at: "2026-10-25T12:15:00Z", size: 7, modified_at: "2026-10-25T12:16:00Z" },
        ],
      },
    });
    handlers.t_b!.pcap_files = () => ({
      ok: true,
      data: { files: [{ name: "smpp_00009_20261025120000.pcapng", started_at: "2026-10-25T12:00:00Z", size: 50, modified_at: "2026-10-25T12:15:00Z" }] },
    });
    assert.equal(await refreshPcapFiles(pool()), 3);
    assert.deepEqual(await traceSources(pool(), new Date("2026-10-25T12:00:00Z")), [
      { node: "t_a", file: "smpp_00001_20261025120000.pcapng" },
      { node: "t_b", file: "smpp_00009_20261025120000.pcapng" },
    ]);

    // A server's list replaces what it had.
    handlers.t_a!.pcap_files = () => ({ ok: true, data: { files: [] } });
    assert.equal(await refreshPcapFiles(pool()), 1);
    assert.deepEqual(await traceSources(pool(), new Date("2026-10-25T12:00:00Z")), [
      { node: "t_b", file: "smpp_00009_20261025120000.pcapng" },
    ]);
  });

  test("expired captures are deleted on the servers, then from the list; kept while no server answers", async () => {
    reset();
    const old = await newCapture("done");
    await pool().query("UPDATE signaling_captures SET updated_at = now() - interval '40 days' WHERE id = $1", [old]);
    both("pcap_delete", () => null);
    assert.equal(await purgeSwitchCaptures(pool(), 30), 0);
    assert.ok(await capture(old));
    both("pcap_delete", (d) => ({ ok: true, data: { deleted: (d.ids as number[]).length } }));
    assert.ok((await purgeSwitchCaptures(pool(), 30)) >= 1);
    assert.equal(await capture(old), undefined);
    assert.ok((seen.find((s) => s.command === "pcap_delete")!.data.ids as number[]).includes(old));
  });

  test("diagnosis runs on the server with the source address, else on any", async () => {
    reset();
    const result = { command: "ping -c 4 192.0.2.9", lines: ["64 bytes"], exit_code: 0, duration_ms: 12 };
    handlers.t_a!.diagnose = () => ({ ok: true, skip: true });
    handlers.t_b!.diagnose = () => ({ ok: true, data: result });
    const r = await switchDiagnose({ tool: "ping", destination: " 192.0.2.9 ", source: "198.51.100.2" });
    assert.deepEqual(r, { command: result.command, lines: ["64 bytes"], exitCode: 0, durationMs: 12 });
    assert.equal(seen[0]!.data.destination, "192.0.2.9");

    handlers.t_b!.diagnose = () => ({ ok: true, skip: true });
    await assert.rejects(switchDiagnose({ tool: "ping", destination: "x", source: "203.0.113.1" }), /no switch server has the address/);

    both("diagnose", () => ({ ok: false, error: "tool must be one of ping, traceroute, mtr, tcp" }));
    await assert.rejects(switchDiagnose({ tool: "nmap", destination: "x" }), /tool must be/);
  });
});
