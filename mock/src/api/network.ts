// Network Status, Signaling Deck / PCAP Trace and Network Diagnosis (§9.2, §12.4, §13.1).
// In this phase the mock plays the switch: it keeps every trunk's bind status and SMPP sessions
// (trunk_binds, bind_sessions) moving, builds pcap files from fake SMPP traffic, and answers
// diagnosis tools with simulated output. Nothing here sends a packet.
import { isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { ListQuery, NetworkDiagnosisInput, NetworkExportInput, SignalingCaptureInput } from "@sms/contract";
import { db, withDb } from "../db.js";
import { chRows } from "../edr.js";
import { spreadsheetXml } from "../billing/files.js";
import {
  CAPTURE_FROM,
  CAPTURE_SELECT,
  CAPTURE_KEEP_DAYS,
  mapCapture,
  mapNetworkBind,
  NETWORK_FROM,
  networkBindList,
} from "../lists/defs.js";
import { compileQuery, type ListDef } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { csvCell, notFound } from "./masterData.js";
import { getCurrentUser } from "./session.js";
import { badInput } from "./switchTools.js";

type Side = "customer" | "vendor";
type TrunkParams = { side: Side; id: number };
type Params = { id: number };

// ---------------------------------------------------------------- small seeded random

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- bind status simulator

const sessionId = (side: Side, trunkId: number, n: number) =>
  `${side === "customer" ? "c" : "v"}${trunkId}-${n}-${Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0")}`;

/** Opens `count` sessions for a trunk (customer: from its allowed IPs; vendor: to its host). */
async function openSessions(c: pg.Pool | pg.PoolClient, side: Side, trunkId: number, count: number) {
  const { rows } =
    side === "customer"
      ? await c.query(
          `SELECT array(SELECT host(x) FROM unnest(host_ips) x) AS ips, CASE bind_type WHEN 'AUTO' THEN 'TR' ELSE bind_type END AS bind,
                  NULL::int AS port FROM customer_trunks WHERE id = $1`,
          [trunkId],
        )
      : await c.query(`SELECT ARRAY[host] AS ips, bind_type AS bind, port FROM vendor_trunks WHERE id = $1`, [trunkId]);
  const t = rows[0];
  if (!t) return;
  const ips = (t.ips as string[]).filter((ip) => isIP(ip));
  for (let n = 0; n < count; n++)
    await c.query(
      `INSERT INTO bind_sessions (session_id, side, trunk_id, ip, port, bind_type, since, submitted, receipts_pending)
       VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7), $8, $9)`,
      [
        sessionId(side, trunkId, n),
        side,
        trunkId,
        ips[n % Math.max(1, ips.length)] ?? "192.0.2.1",
        t.port ?? 30000 + Math.floor(Math.random() * 35000),
        t.bind,
        Math.floor(Math.random() * 6 * 3600),
        Math.floor(Math.random() * 20000),
        Math.floor(Math.random() * 40),
      ],
    );
}

/** Seven-day average TPS per trunk from the EDR store, so the status agrees with the reports. */
async function averageTps(): Promise<{ customer: Map<number, number>; vendor: Map<number, number> }> {
  const q = (col: string) =>
    chRows<{ id: number; tps: number }>(
      `SELECT ${col} AS id, count() / (7 * 86400) AS tps FROM edr
        WHERE start_time >= (SELECT max(start_time) FROM edr) - INTERVAL 7 DAY AND ${col} != 0 GROUP BY id`,
      20_000,
    );
  const [c, v] = await Promise.all([q("c_trunk_id"), q("v_trunk_id")]);
  const map = (rows: { id: number; tps: number }[] | null) =>
    new Map((rows ?? []).map((r) => [Number(r.id), Number(r.tps)]));
  return { customer: map(c), vendor: map(v) };
}

/** Adds bind status rows for trunks that have none (first start, or trunks added since). */
export async function syncBinds(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT 'customer' AS side, t.id, t.status, t.max_connections FROM customer_trunks t
      WHERE t.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM trunk_binds b WHERE b.side = 'customer' AND b.trunk_id = t.id)
     UNION ALL
     SELECT 'vendor', t.id, t.status, t.max_connections FROM vendor_trunks t
      WHERE t.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM trunk_binds b WHERE b.side = 'vendor' AND b.trunk_id = t.id)`,
  );
  if (!rows.length) return;
  const tps = await averageTps();
  for (const r of rows) {
    const side = r.side as Side;
    const avg = tps[side].get(Number(r.id)) ?? 0;
    const online = r.status === "active" && Math.random() > (side === "customer" ? (avg > 0 ? 0.03 : 0.25) : 0.03);
    const connections = online
      ? side === "vendor"
        ? Number(r.max_connections)
        : 1 + Math.floor(Math.random() * Number(r.max_connections))
      : 0;
    await pool.query(
      `INSERT INTO trunk_binds (side, trunk_id, status, connections, queue, tps, since)
       VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7)) ON CONFLICT DO NOTHING`,
      [
        side,
        r.id,
        online ? "online" : "offline",
        connections,
        side === "vendor" ? (online ? Math.floor(Math.random() * 30) : Math.floor(Math.random() * 400)) : null,
        online ? Math.round(avg * (0.7 + Math.random() * 0.6) * 10) / 10 : 0,
        Math.floor(Math.random() * 5 * 86400),
      ],
    );
    if (online) await openSessions(pool, side, Number(r.id), connections);
  }
}

/** Every 10 s: TPS and queues move, sessions count messages, and now and then a bind drops or comes back. */
async function bindTick(pool: pg.Pool) {
  await pool.query(
    `UPDATE trunk_binds SET
       tps = CASE WHEN status = 'online' THEN round(greatest(0, tps * (0.85 + random() * 0.3) + (random() - 0.5) * 0.4)::numeric, 1) ELSE 0 END,
       queue = CASE WHEN side <> 'vendor' THEN NULL
                    WHEN status = 'online' THEN greatest(0, coalesce(queue, 0) + floor(random() * 21)::int - 10)
                    WHEN status = 'offline' THEN coalesce(queue, 0) + floor(random() * 40)::int
                    ELSE 0 END`,
  );
  await pool.query(
    `UPDATE bind_sessions s SET submitted = submitted + floor(b.tps * 10 / greatest(b.connections, 1))::int,
            receipts_pending = greatest(0, receipts_pending + floor(random() * 9)::int - 4)
       FROM trunk_binds b WHERE b.side = s.side AND b.trunk_id = s.trunk_id`,
  );
  if (Math.random() < 0.15) {
    const { rows } = await pool.query(
      `UPDATE trunk_binds SET status = 'offline', connections = 0, tps = 0, since = now(), changed_by_id = NULL
        WHERE (side, trunk_id) = (SELECT side, trunk_id FROM trunk_binds WHERE status = 'online' AND side = 'customer'
                                   ORDER BY random() LIMIT 1) RETURNING side, trunk_id`,
    );
    for (const r of rows)
      await pool.query("DELETE FROM bind_sessions WHERE side = $1 AND trunk_id = $2", [r.side, r.trunk_id]);
  }
  if (Math.random() < 0.3) {
    const { rows } = await pool.query(
      `SELECT b.side, b.trunk_id, t.max_connections FROM trunk_binds b JOIN customer_trunks t ON t.id = b.trunk_id
        WHERE b.side = 'customer' AND b.status = 'offline' AND t.status = 'active' AND t.deleted_at IS NULL
        ORDER BY random() LIMIT 1`,
    );
    for (const r of rows)
      await bringOnline(
        pool,
        "customer",
        Number(r.trunk_id),
        1 + Math.floor(Math.random() * Number(r.max_connections)),
      );
  }
}

async function bringOnline(
  pool: pg.Pool,
  side: Side,
  trunkId: number,
  connections: number,
  userId: number | null = null,
) {
  await pool.query("DELETE FROM bind_sessions WHERE side = $1 AND trunk_id = $2", [side, trunkId]);
  await pool.query(
    `UPDATE trunk_binds SET status = 'online', connections = $3, tps = round((random() * 5)::numeric, 1), since = now(),
            changed_by_id = coalesce($4, changed_by_id) WHERE side = $1 AND trunk_id = $2`,
    [side, trunkId, connections, userId],
  );
  await openSessions(pool, side, trunkId, connections);
}

export function startNetworkStatus() {
  let pool: pg.Pool;
  try {
    pool = db();
  } catch {
    return;
  }
  // Captures that were running when the mock stopped have ended.
  void pool
    .query("UPDATE signaling_captures SET status = 'done', updated_at = now() WHERE status = 'running'")
    .then(() => syncBinds(pool))
    .catch(() => undefined);
  setInterval(() => void bindTick(pool).catch(() => undefined), 10_000).unref();
  setInterval(() => void captureTick(pool).catch(() => undefined), 1_000).unref();
  // Capture files past their 30 days are deleted (team trial round 1); kept ones stay.
  void purgeCaptures(pool).catch(() => undefined);
  setInterval(() => void purgeCaptures(pool).catch(() => undefined), 3_600_000).unref();
}

export function purgeCaptures(pool: pg.Pool) {
  return pool.query(
    `DELETE FROM signaling_captures WHERE NOT keep AND status <> 'running'
       AND updated_at < now() - interval '${CAPTURE_KEEP_DAYS} days'`,
  );
}

// ---------------------------------------------------------------- network status endpoints

const loadBind = async (pool: pg.Pool, side: Side, id: number) => {
  const { rows } = await pool.query(`SELECT nb.* FROM ${NETWORK_FROM} WHERE nb.side = $1 AND nb.trunk_id = $2`, [
    side,
    id,
  ]);
  return rows[0] ? mapNetworkBind(rows[0]) : null;
};

export function listBindSessions(request: FastifyRequest, reply: FastifyReply) {
  const { side, id } = request.params as TrunkParams;
  return withDb(reply, async (pool) => {
    if (!(await loadBind(pool, side, id)))
      return notFound(reply, `${side === "customer" ? "Customer" : "Vendor"} trunk`, id);
    const { rows } = await pool.query("SELECT * FROM bind_sessions WHERE side = $1 AND trunk_id = $2 ORDER BY since", [
      side,
      id,
    ]);
    return {
      sessions: rows.map((r) => ({
        sessionId: r.session_id,
        ip: String(r.ip),
        port: Number(r.port),
        bindType: r.bind_type,
        since: (r.since as Date).toISOString(),
        submitted: Number(r.submitted),
        receiptsPending: Number(r.receipts_pending),
      })),
    };
  });
}

export function startTrunkBind(request: FastifyRequest, reply: FastifyReply) {
  const { side, id } = request.params as TrunkParams;
  return withDb(reply, async (pool) => {
    const before = await loadBind(pool, side, id);
    if (!before) return notFound(reply, `${side === "customer" ? "Customer" : "Vendor"} trunk`, id);
    const me = await getCurrentUser();
    if (side === "vendor") await bringOnline(pool, side, id, before.maxConnections, me.id);
    else {
      // Binds are accepted again; the customer reconnects a few seconds later.
      await pool.query(
        "UPDATE trunk_binds SET status = 'offline', since = now(), changed_by_id = $3 WHERE side = $1 AND trunk_id = $2",
        [side, id, me.id],
      );
      setTimeout(
        () =>
          void bringOnline(pool, side, id, 1 + Math.floor(Math.random() * before.maxConnections)).catch(
            () => undefined,
          ),
        5000,
      ).unref();
    }
    return loadBind(pool, side, id);
  });
}

export function stopTrunkBind(request: FastifyRequest, reply: FastifyReply) {
  const { side, id } = request.params as TrunkParams;
  return withDb(reply, async (pool) => {
    if (!(await loadBind(pool, side, id)))
      return notFound(reply, `${side === "customer" ? "Customer" : "Vendor"} trunk`, id);
    const me = await getCurrentUser();
    await pool.query("DELETE FROM bind_sessions WHERE side = $1 AND trunk_id = $2", [side, id]);
    await pool.query(
      `UPDATE trunk_binds SET status = 'stopped', connections = 0, tps = 0, queue = CASE WHEN side = 'vendor' THEN 0 END,
              since = now(), changed_by_id = $3 WHERE side = $1 AND trunk_id = $2`,
      [side, id, me.id],
    );
    return loadBind(pool, side, id);
  });
}

const NETWORK_COLUMNS: [string, (r: ReturnType<typeof mapNetworkBind>) => string | number | null][] = [
  ["Enterprise ID", (r) => r.enterpriseId],
  ["Trunk ID", (r) => r.trunkId],
  ["Enterprise Name", (r) => r.enterpriseName],
  ["Trunk Name", (r) => r.trunkName],
  ["IP Address", (r) => r.ipAddresses.join(" ")],
  ["Number of Connections", (r) => r.connections],
  ["Queue", (r) => r.queue],
  ["TPS", (r) => r.tps],
  ["Status", (r) => r.status],
  ["Since (UTC)", (r) => r.since.replace("T", " ").slice(0, 19)],
];

export function exportNetworkBinds(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as NetworkExportInput;
  const query: ListQuery = { ...b.query, limit: 100_000, cursor: null, withTotal: false };
  const errors = checkListQuery(query, listFields.network_binds);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, async (pool) => {
    const q = compileQuery(networkBindList as ListDef<unknown>, query);
    const { rows } = await pool.query(q.sql, q.values);
    const data = rows.slice(0, q.limit).map(mapNetworkBind);
    const vendor = data.length > 0 && data.every((r) => r.side === "vendor");
    const cols = NETWORK_COLUMNS.filter(([h]) => vendor || h !== "Queue");
    if (b.fileType === "excel")
      return reply
        .type("application/vnd.ms-excel")
        .header("content-disposition", `attachment; filename="network_status.xls"`)
        .send(
          spreadsheetXml("Network status", [
            { cells: cols.map(([h]) => h), bold: true },
            ...data.map((r) => ({ cells: cols.map(([, f]) => f(r)) })),
          ]),
        );
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="network_status.csv"`)
      .send(
        [cols.map(([h]) => h).join(","), ...data.map((r) => cols.map(([, f]) => csvCell(f(r))).join(","))].join(
          "\r\n",
        ) + "\r\n",
      );
  });
}

// ---------------------------------------------------------------- signaling captures

const CIDR = /^([0-9a-f.:]+)\/(\d{1,3})$/i;
export function validIpFilter(v: string): boolean {
  if (isIP(v)) return true;
  const m = CIDR.exec(v);
  if (!m || !isIP(m[1]!)) return false;
  return Number(m[2]) <= (isIP(m[1]!) === 4 ? 32 : 128);
}

async function captureTick(pool: pg.Pool) {
  await pool.query(
    `WITH g AS (SELECT id, (20 + floor(random() * 60)::int) * CASE WHEN ip_filter IS NULL THEN 5 ELSE 1 END AS p
                  FROM signaling_captures WHERE status = 'running')
     UPDATE signaling_captures c SET packets = c.packets + g.p,
            size_bytes = least(c.max_file_size_bytes, 24 + (c.packets + g.p) * 118),
            updated_at = now(),
            status = CASE WHEN now() - c.started_at >= make_interval(secs => c.max_duration_seconds)
                            OR 24 + (c.packets + g.p) * 118 >= c.max_file_size_bytes THEN 'done' ELSE 'running' END
       FROM g WHERE g.id = c.id`,
  );
}

const loadCapture = async (pool: pg.Pool, id: number) => {
  const { rows } = await pool.query(`SELECT ${CAPTURE_SELECT} FROM ${CAPTURE_FROM} WHERE c.id = $1`, [id]);
  return rows[0] ? mapCapture(rows[0]) : null;
};

export function startSignalingCapture(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SignalingCaptureInput;
  const ip = b.ipFilter?.trim() || null;
  if (ip && !validIpFilter(ip))
    return badInput(reply, [
      { path: "/ipFilter", message: "an IPv4 / IPv6 address or range, e.g. 192.0.2.10 or 192.0.2.0/24" },
    ]);
  return withDb(reply, async (pool) => {
    const { rows: busy } = await pool.query(
      "SELECT count(*)::int AS n FROM signaling_captures WHERE status = 'running'",
    );
    if (busy[0].n >= 3) return sendProblem(reply, 409, "Three captures are already running; stop one first");
    const me = await getCurrentUser();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
    const name = `smpp_${stamp}${ip ? `_${ip.replace(/[/:]/g, "-")}` : ""}.pcap`;
    const { rows } = await pool.query(
      `INSERT INTO signaling_captures (file_name, ip_filter, max_duration_seconds, max_file_size_bytes, started_by_id, size_bytes)
       VALUES ($1, $2, $3, $4, $5, 24) RETURNING id`,
      [name, ip, b.maxDurationSeconds, b.maxFileSizeBytes, me.id],
    );
    return reply.code(201).send(await loadCapture(pool, Number(rows[0].id)));
  });
}

export function stopSignalingCapture(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const c = await loadCapture(pool, id);
    if (!c) return notFound(reply, "Capture", id);
    if (c.status !== "running") return sendProblem(reply, 409, `This capture is already ${c.status}`);
    await pool.query("UPDATE signaling_captures SET status = 'stopped', updated_at = now() WHERE id = $1", [id]);
    return loadCapture(pool, id);
  });
}

export function keepSignalingCapture(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const { keep } = request.body as { keep: boolean };
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rowCount } = await pool.query(
      `UPDATE signaling_captures SET keep = $2, kept_by_id = CASE WHEN $2 THEN $3::bigint END,
              kept_at = CASE WHEN $2 THEN now() END WHERE id = $1`,
      [id, keep, me.id],
    );
    if (!rowCount) return notFound(reply, "Capture", id);
    return loadCapture(pool, id);
  });
}

export function downloadSignalingCapture(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const c = await loadCapture(pool, id);
    if (!c) return notFound(reply, "Capture", id);
    if (c.status === "failed") return sendProblem(reply, 409, "This capture failed and has no file");
    return reply
      .type("application/vnd.tcpdump.pcap")
      .header("content-disposition", `attachment; filename="${c.fileName}"`)
      .send(buildPcap(c.id, c.ipFilter, Date.parse(c.startedAt), Math.min(c.sizeBytes, 4 * 1024 * 1024)));
  });
}

// ---------------------------------------------------------------- pcap

const SWITCH_V4 = "198.51.100.10";
const SWITCH_V6 = "2001:db8::10";
const SMPP_PORT = 2775;

const v4Bytes = (ip: string) => Buffer.from(ip.split(".").map(Number));
function v6Bytes(ip: string): Buffer {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || "0", 16), i * 2));
  return b;
}
function checksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) sum += buf.readUInt16BE(i);
  if (buf.length % 2) sum += buf[buf.length - 1]! << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

/** A host inside the capture filter (a range picks addresses in it), or a documentation address. */
function clientIp(filter: string | null, rnd: () => number): string {
  if (!filter) return `192.0.2.${1 + Math.floor(rnd() * 254)}`;
  const m = CIDR.exec(filter);
  const base = m ? m[1]! : filter;
  if (isIP(base) === 6) return base;
  if (!m || Number(m[2]) >= 31) return base;
  const span = Math.min(2 ** (32 - Number(m[2])) - 2, 254);
  const n = v4Bytes(base).readUInt32BE(0);
  const host = (n & ~(2 ** (32 - Number(m[2])) - 1)) + 1 + Math.floor(rnd() * span);
  return [host >>> 24, (host >>> 16) & 255, (host >>> 8) & 255, host & 255].join(".");
}

const cstr = (s: string) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.from([0])]);
function pdu(commandId: number, seq: number, body: Buffer, status = 0): Buffer {
  const h = Buffer.alloc(16);
  h.writeUInt32BE(16 + body.length, 0);
  h.writeUInt32BE(commandId >>> 0, 4);
  h.writeUInt32BE(status, 8);
  h.writeUInt32BE(seq, 12);
  return Buffer.concat([h, body]);
}
function submitSm(sender: string, receiver: string, text: string): Buffer {
  const sm = Buffer.from(text, "latin1");
  return Buffer.concat([
    cstr(""),
    Buffer.from([5, 0]),
    cstr(sender),
    Buffer.from([1, 1]),
    cstr(receiver),
    Buffer.from([0, 0, 0]),
    cstr(""),
    cstr(""),
    Buffer.from([1, 0, 0, 0, sm.length]),
    sm,
  ]);
}
function deliverSm(receiver: string, sender: string, receipt: string): Buffer {
  const sm = Buffer.from(receipt, "latin1");
  return Buffer.concat([
    cstr(""),
    Buffer.from([1, 1]),
    cstr(receiver),
    Buffer.from([5, 0]),
    cstr(sender),
    Buffer.from([0x04, 0, 0]),
    cstr(""),
    cstr(""),
    Buffer.from([0, 0, 0, 0, sm.length]),
    sm,
  ]);
}
const smppTime = (t: number) => new Date(t).toISOString().slice(2, 16).replace(/[-T:]/g, "");

/**
 * A libpcap file (Ethernet, IPv4 or IPv6, TCP) with SMPP traffic between a client and the switch:
 * submit_sm / submit_sm_resp, delivery receipts (deliver_sm / resp) and enquire_link, until the
 * capture's size is reached. Deterministic per capture ID; fake numbers and documentation IPs only.
 */
export function buildPcap(id: number, filter: string | null, startMs: number, targetBytes: number): Buffer {
  const rnd = seeded(id * 7919 + 17);
  const out: Buffer[] = [];
  const global = Buffer.alloc(24);
  global.writeUInt32LE(0xa1b2c3d4, 0);
  global.writeUInt16LE(2, 4);
  global.writeUInt16LE(4, 6);
  global.writeUInt32LE(65535, 16);
  global.writeUInt32LE(1, 20);
  out.push(global);
  let size = 24;
  let t = startMs;
  const client = clientIp(filter, rnd);
  const v6 = isIP(client) === 6;
  const server = v6 ? SWITCH_V6 : SWITCH_V4;
  const clientPort = 30000 + Math.floor(rnd() * 30000);
  const seqs = { c: Math.floor(rnd() * 2 ** 31), s: Math.floor(rnd() * 2 ** 31) };
  const macC = Buffer.from([0x02, 0x00, 0x5e, 0x10, 0x00, id & 255]);
  const macS = Buffer.from([0x02, 0x00, 0x5e, 0x10, 0xff, 0x01]);

  const packet = (fromClient: boolean, payload: Buffer) => {
    const src = fromClient ? client : server;
    const dst = fromClient ? server : client;
    const tcp = Buffer.alloc(20);
    tcp.writeUInt16BE(fromClient ? clientPort : SMPP_PORT, 0);
    tcp.writeUInt16BE(fromClient ? SMPP_PORT : clientPort, 2);
    tcp.writeUInt32BE(fromClient ? seqs.c : seqs.s, 4);
    tcp.writeUInt32BE(fromClient ? seqs.s : seqs.c, 8);
    tcp[12] = 0x50;
    tcp[13] = 0x18;
    tcp.writeUInt16BE(65535, 14);
    if (fromClient) seqs.c = (seqs.c + payload.length) >>> 0;
    else seqs.s = (seqs.s + payload.length) >>> 0;
    const segment = Buffer.concat([tcp, payload]);
    let ipHeader: Buffer;
    let pseudo: Buffer;
    if (v6) {
      ipHeader = Buffer.alloc(40);
      ipHeader.writeUInt32BE(0x60000000, 0);
      ipHeader.writeUInt16BE(segment.length, 4);
      ipHeader[6] = 6;
      ipHeader[7] = 64;
      v6Bytes(src).copy(ipHeader, 8);
      v6Bytes(dst).copy(ipHeader, 24);
      const p = Buffer.alloc(40);
      v6Bytes(src).copy(p, 0);
      v6Bytes(dst).copy(p, 16);
      p.writeUInt32BE(segment.length, 32);
      p[39] = 6;
      pseudo = p;
    } else {
      ipHeader = Buffer.alloc(20);
      ipHeader[0] = 0x45;
      ipHeader.writeUInt16BE(20 + segment.length, 2);
      ipHeader.writeUInt16BE(Math.floor(rnd() * 65535), 4);
      ipHeader.writeUInt16BE(0x4000, 6);
      ipHeader[8] = 64;
      ipHeader[9] = 6;
      v4Bytes(src).copy(ipHeader, 12);
      v4Bytes(dst).copy(ipHeader, 16);
      ipHeader.writeUInt16BE(checksum(ipHeader), 10);
      const p = Buffer.alloc(12);
      v4Bytes(src).copy(p, 0);
      v4Bytes(dst).copy(p, 4);
      p[9] = 6;
      p.writeUInt16BE(segment.length, 10);
      pseudo = p;
    }
    segment.writeUInt16BE(checksum(Buffer.concat([pseudo, segment])), 16);
    const eth = Buffer.concat([
      fromClient ? macS : macC,
      fromClient ? macC : macS,
      Buffer.from(v6 ? [0x86, 0xdd] : [0x08, 0x00]),
    ]);
    const frame = Buffer.concat([eth, ipHeader, segment]);
    const rec = Buffer.alloc(16);
    rec.writeUInt32LE(Math.floor(t / 1000), 0);
    rec.writeUInt32LE(Math.floor((t % 1000) * 1000 + rnd() * 999), 4);
    rec.writeUInt32LE(frame.length, 8);
    rec.writeUInt32LE(frame.length, 12);
    out.push(rec, frame);
    size += rec.length + frame.length;
  };

  const senders = ["INFOMSG", "OTPCODE", "BANKALERT", "SHOPNOW", "DELIVERY"];
  let seq = 1;
  let n = 0;
  while (size < Math.max(targetBytes, 600)) {
    if (n % 30 === 0) {
      packet(true, pdu(0x00000015, seq, Buffer.alloc(0)));
      t += 2;
      packet(false, pdu(0x80000015, seq++, Buffer.alloc(0)));
    }
    const sender = senders[Math.floor(rnd() * senders.length)]!;
    const receiver = `44${7000000000 + Math.floor(rnd() * 999999999)}`;
    const code = String(100000 + Math.floor(rnd() * 899999));
    const msgId = Math.floor(rnd() * 2 ** 40)
      .toString(16)
      .padStart(10, "0");
    t += 5 + Math.floor(rnd() * 120);
    const s = seq++;
    packet(true, pdu(0x00000004, s, submitSm(sender, receiver, `Your code is ${code}`)));
    t += 8 + Math.floor(rnd() * 40);
    const throttled = rnd() < 0.02;
    packet(false, pdu(0x80000004, s, throttled ? cstr("") : cstr(msgId), throttled ? 0x58 : 0));
    if (!throttled) {
      const stat = rnd() < 0.85 ? "DELIVRD" : "UNDELIV";
      const done = t + 800 + Math.floor(rnd() * 4000);
      const receipt = `id:${msgId} sub:001 dlvrd:${stat === "DELIVRD" ? "001" : "000"} submit date:${smppTime(t)} done date:${smppTime(done)} stat:${stat} err:${stat === "DELIVRD" ? "000" : "001"} text:Your code is`;
      const d = seq++;
      packet(false, pdu(0x00000005, d, deliverSm(sender, receiver, receipt)));
      t += 3;
      packet(true, pdu(0x80000005, d, cstr("")));
    }
    n++;
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- network diagnosis

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const OPEN_PORTS = new Set([22, 80, 443, 2775, 2776, 2777, 2778, 2779, 3700, 8080]);

/** A host name "resolves" to a documentation address derived from the name; no DNS is asked. */
const resolveFake = (dest: string) => (isIP(dest) ? dest : `203.0.113.${1 + (hash(dest) % 254)}`);
const ms = (v: number) => v.toFixed(3);

export function diagnose(b: NetworkDiagnosisInput): {
  command: string;
  lines: string[];
  exitCode: number;
  durationMs: number;
} {
  const dest = b.destination.trim();
  const ip = resolveFake(dest);
  const rnd = seeded(hash(`${b.tool}|${dest}|${b.port ?? ""}`));
  const base = 4 + rnd() * 120;
  const unreachable = hash(dest) % 11 === 0;
  const count = b.count ?? 4;
  const src = b.source?.trim() || null;
  const lines: string[] = [];
  if (b.tool === "ping") {
    const command = `ping -c ${count}${src ? ` -I ${src}` : ""} ${dest}`;
    lines.push(`PING ${dest} (${ip})${src ? ` from ${src}` : ""} 56(84) bytes of data.`);
    const times: number[] = [];
    for (let i = 1; i <= count; i++) {
      if (unreachable) lines.push(`From 10.10.0.1 icmp_seq=${i} Destination Host Unreachable`);
      else if (rnd() < 0.05) continue;
      else {
        const v = base + (rnd() - 0.5) * base * 0.2;
        times.push(v);
        lines.push(`64 bytes from ${ip}: icmp_seq=${i} ttl=${54 - Math.floor(base / 40)} time=${v.toFixed(1)} ms`);
      }
    }
    const loss = Math.round(((count - times.length) / count) * 100);
    lines.push(
      "",
      `--- ${dest} ping statistics ---`,
      `${count} packets transmitted, ${times.length} received, ${loss}% packet loss, time ${(count - 1) * 1000 + 4}ms`,
    );
    if (times.length) {
      const avg = times.reduce((a, v) => a + v, 0) / times.length;
      const mdev = Math.sqrt(times.reduce((a, v) => a + (v - avg) ** 2, 0) / times.length);
      lines.push(
        `rtt min/avg/max/mdev = ${ms(Math.min(...times))}/${ms(avg)}/${ms(Math.max(...times))}/${ms(mdev)} ms`,
      );
    }
    return { command, lines, exitCode: times.length ? 0 : 1, durationMs: count * 1000 };
  }
  const hops = 5 + Math.floor(rnd() * 8);
  const route = Array.from({ length: hops }, (_, i) =>
    i === hops - 1 ? ip : i < 2 ? `10.10.${i}.1` : `198.51.100.${1 + Math.floor(rnd() * 250)}`,
  );
  const hopTime = (i: number) => (base * (i + 1)) / hops + rnd() * 2;
  if (b.tool === "traceroute") {
    lines.push(`traceroute to ${dest} (${ip}), 30 hops max, 60 byte packets`);
    route.forEach((h, i) => {
      if (unreachable && i >= 3) return lines.push(`${String(i + 1).padStart(2)}  * * *`);
      if (i > 1 && i < hops - 1 && rnd() < 0.12) return lines.push(`${String(i + 1).padStart(2)}  * * *`);
      lines.push(`${String(i + 1).padStart(2)}  ${h} (${h})  ${[0, 1, 2].map(() => ms(hopTime(i))).join(" ms  ")} ms`);
    });
    return { command: `traceroute${src ? ` -s ${src}` : ""} ${dest}`, lines, exitCode: 0, durationMs: hops * 300 };
  }
  if (b.tool === "mtr") {
    lines.push(
      `Start: ${new Date().toISOString().slice(0, 19)}+0000`,
      "HOST: sms-switch-01              Loss%   Snt   Last   Avg  Best  Wrst StDev",
    );
    route.forEach((h, i) => {
      const lost = unreachable && i >= 3 ? 100 : i > 1 && i < hops - 1 && rnd() < 0.15 ? Math.round(rnd() * 20) : 0;
      const avg = hopTime(i);
      const label = lost === 100 ? "???" : h;
      lines.push(
        `  ${String(i + 1).padStart(2)}.|-- ${label.padEnd(26)} ${lost.toFixed(1).padStart(5)}%  ${String(count).padStart(4)}  ${[
          avg * 1.02,
          avg,
          avg * 0.9,
          avg * 1.3,
          avg * 0.08,
        ]
          .map((v) => (lost === 100 ? "0.0" : v.toFixed(1)).padStart(5))
          .join(" ")}`,
      );
    });
    return {
      command: `mtr --report -c ${count}${src ? ` -a ${src}` : ""} ${dest}`,
      lines,
      exitCode: 0,
      durationMs: count * 1000,
    };
  }
  // telnet
  lines.push(`Trying ${ip}...`);
  const open = !unreachable && OPEN_PORTS.has(b.port!);
  if (open) lines.push(`Connected to ${dest}.`, "Escape character is '^]'.", "Connection closed by foreign host.");
  else if (unreachable) lines.push(`telnet: Unable to connect to remote host: Connection timed out`);
  else lines.push(`telnet: Unable to connect to remote host: Connection refused`);
  return {
    command: `telnet${src ? ` -b ${src}` : ""} ${dest} ${b.port}`,
    lines,
    exitCode: open ? 0 : 1,
    durationMs: unreachable ? 10_000 : Math.round(base),
  };
}

export function runNetworkDiagnosis(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as NetworkDiagnosisInput;
  const errors = [];
  if (!isIP(b.destination.trim()) && !HOSTNAME.test(b.destination.trim()))
    errors.push({ path: "/destination", message: "a host name or IP address" });
  if (b.source && !isIP(b.source.trim())) errors.push({ path: "/source", message: "an IP address of the switch host" });
  if (b.tool === "telnet" && !b.port) errors.push({ path: "/port", message: "telnet needs a port" });
  if (errors.length) return badInput(reply, errors);
  return diagnose(b);
}
