// The screens' actions that the switch carries out in production (backend step 11c, §9.1, §9.2), over the command
// subjects of switch/commands.ts. Outside production these screens keep their simulated behaviour (api/network.ts,
// api/observation.ts, api/routeSimulator.ts).
import { Readable } from "node:stream";
import { isIP } from "node:net";
import type pg from "pg";
import { chRows } from "../edr.js";
import { askAll, askAny, askNode, dataOf, SwitchRefused, SwitchUnreachable, type SwitchAnswer } from "./commands.js";

type Side = "customer" | "vendor";

// ---------------------------------------------------------------- Network Status Stop / Start

/**
 * Stop: the trunk is marked stopped (sessions closed, binds refused, a vendor's connections closed, until Start); Start:
 * it may bind again (its status follows the switch's session events). The switch re-reads it at once; when no switch
 * server answers, within its 5 s refresh.
 */
export async function switchBind(pool: pg.Pool, side: Side, trunkId: number, action: "start" | "stop", userId: number) {
  if (action === "stop") {
    await pool.query("DELETE FROM bind_sessions WHERE side = $1 AND trunk_id = $2", [side, trunkId]);
    await pool.query(
      `INSERT INTO trunk_binds (side, trunk_id, status, connections, tps, queue, since, changed_by_id)
       VALUES ($1, $2, 'stopped', 0, 0, CASE WHEN $1 = 'vendor' THEN 0 END, now(), $3)
       ON CONFLICT (side, trunk_id) DO UPDATE SET status = 'stopped', connections = 0, tps = 0,
         queue = CASE WHEN EXCLUDED.side = 'vendor' THEN 0 END, since = now(), changed_by_id = $3`,
      [side, trunkId, userId],
    );
  } else {
    await pool.query(
      `UPDATE trunk_binds SET status = 'offline', since = now(), changed_by_id = $3
        WHERE side = $1 AND trunk_id = $2 AND status = 'stopped'`,
      [side, trunkId, userId],
    );
  }
  await askAll("bind", { side, trunk_id: trunkId }).catch((err: unknown) => {
    if (!(err instanceof SwitchUnreachable)) throw err;
  });
}

// ---------------------------------------------------------------- EDR Repush

interface RepushAnswer {
  sent: number;
  refused: number;
  not_found: number;
  reasons: { reason: string; count: number }[];
}

/**
 * A Repush Request: the eligible EDRs' messages sent again on the vendor trunk by one switch server, each a new attempt
 * with the request's id. Returns the request id; when no switch server answers nothing is kept (`SwitchUnreachable`).
 */
export async function switchRepush(
  pool: pg.Pool,
  vendorTrunkId: number,
  edrIds: string[],
  skipped: number,
  userId: number,
): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO repush_requests (vendor_trunk_id, edr_count, skipped, created_by_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [vendorTrunkId, edrIds.length, skipped, userId],
  );
  const id = Number(rows[0].id);
  if (!edrIds.length) {
    await pool.query("UPDATE repush_requests SET status = 'done' WHERE id = $1", [id]);
    return id;
  }
  try {
    const answer = dataOf(
      await askAny<RepushAnswer>("repush", { request_id: id, vendor_trunk_id: vendorTrunkId, edr_ids: edrIds }, 120_000),
    );
    // What the switch could not send counts as skipped, as the ineligible ones do.
    const notSent = answer.refused + answer.not_found;
    if (notSent)
      await pool.query("UPDATE repush_requests SET skipped = skipped + $2, edr_count = edr_count - $2 WHERE id = $1", [
        id,
        notSent,
      ]);
    if (!answer.sent) await pool.query("UPDATE repush_requests SET status = 'done' WHERE id = $1", [id]);
    return id;
  } catch (err) {
    await pool.query("DELETE FROM repush_requests WHERE id = $1", [id]);
    throw err;
  }
}

const FAILED = ["UNDELIV", "REJECTD", "EXPIRED", "DELETED", "UNKNOWN"].map((s) => `'${s}'`).join(",");

/** Delivered and failed counts of the pending requests of the last week, from their attempts' outcomes; done when all are known. */
export async function updateRepushProgress(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, edr_count AS sent FROM repush_requests
      WHERE status = 'pending' AND inserted_at > now() - interval '7 days' ORDER BY id LIMIT 200`,
  );
  let updated = 0;
  for (const r of rows) {
    const id = Number(r.id);
    const counts = await chRows<{ d: string; f: string }>(
      `SELECT countIf(msg_status = 'DELIVRD') AS d, countIf(msg_status IN (${FAILED}) OR (kind = 'attempt' AND is_submit_success = 0)) AS f
         FROM edr_all WHERE edr_id IN (SELECT edr_id FROM edr WHERE repush_request_id = ${id})`,
    );
    if (!counts?.[0]) continue;
    const delivered = Number(counts[0].d);
    const failed = Number(counts[0].f);
    await pool.query(
      `UPDATE repush_requests SET delivered = $2, failed = $3,
              status = CASE WHEN $2 + $3 >= $4 THEN 'done' ELSE status END WHERE id = $1`,
      [id, delivered, failed, Number(r.sent)],
    );
    updated++;
  }
  return updated;
}

// ---------------------------------------------------------------- Test SMS

export interface TestSmsInput {
  customerTrunkId: number;
  receiver: string;
  sender?: string | null;
  text?: string | null;
  dataCoding?: number | null;
  sourceTon?: number | null;
  sourceNpi?: number | null;
  vendorTrunkId?: number | null;
}

/** Test SMS through the switch: taken (ACCEPTD, its receipt then shows in EDR Search) or refused with the reason. */
export async function switchTestSms(input: TestSmsInput) {
  try {
    const answer = await askAny<{ message_id: string | null; status: "ACCEPTD" | "REJECTD"; detail: string }>("test_sms", {
      customer_trunk_id: input.customerTrunkId,
      receiver: input.receiver,
      sender: input.sender ?? null,
      text: input.text ?? null,
      data_coding: input.dataCoding ?? null,
      source_ton: input.sourceTon ?? null,
      source_npi: input.sourceNpi ?? null,
      vendor_trunk_id: input.vendorTrunkId ?? null,
    });
    if (!answer.ok) return { messageId: "", status: "REJECTD" as const, detail: `Refused: ${answer.error}` };
    const d = answer.data!;
    return { messageId: d.message_id ?? "", status: d.status, detail: d.detail };
  } catch (err) {
    if (err instanceof SwitchUnreachable)
      return { messageId: "", status: "REJECTD" as const, detail: "The switch did not answer; nothing was sent" };
    throw err;
  }
}

// ---------------------------------------------------------------- captures and the recording

interface CaptureStatus {
  id: number;
  running: boolean;
  exists: boolean;
  size: number;
  packets: number;
}

const accepted = <T>(answers: SwitchAnswer<T>[]) => answers.filter((a) => a.ok);
const firstError = (answers: SwitchAnswer<unknown>[]) => answers.find((a) => !a.ok)?.error ?? "the switch refused it";

/** A live capture on every switch server; fails (and marks the row failed) when none of them could start it. */
export async function switchStartCapture(
  pool: pg.Pool,
  id: number,
  ipFilter: string | null,
  maxDurationSeconds: number,
  maxFileSizeBytes: number,
) {
  try {
    const answers = await askAll("pcap_capture", {
      id,
      ip_filter: ipFilter,
      max_duration_s: maxDurationSeconds,
      max_bytes: maxFileSizeBytes,
    });
    if (!accepted(answers).length) throw new SwitchRefused(firstError(answers));
  } catch (err) {
    await pool.query("UPDATE signaling_captures SET status = 'failed', updated_at = now() WHERE id = $1", [id]);
    throw err;
  }
}

export async function switchStopCapture(id: number) {
  await askAll("pcap_stop", { id }).catch((err: unknown) => {
    if (!(err instanceof SwitchUnreachable)) throw err;
  });
}

export interface ExtractCriteria {
  from: string;
  to: string;
  ipFilters: string[];
  number: string | null;
  messageId: string | null;
}

/** A recording extract on every switch server (each cuts its own recording); the files are joined on download. */
export async function switchExtract(pool: pg.Pool, id: number, c: ExtractCriteria) {
  try {
    const answers = await askAll("pcap_extract", {
      id,
      from: c.from,
      to: c.to,
      ip_filters: c.ipFilters,
      number: c.number,
      message_id: c.messageId,
    });
    if (!accepted(answers).length) throw new SwitchRefused(firstError(answers));
  } catch (err) {
    await pool.query("UPDATE signaling_captures SET status = 'failed', updated_at = now() WHERE id = $1", [id]);
    throw err;
  }
}

/** The addresses a trunk's packets come from (its host IPs; a vendor's host when it is an address). */
export async function trunkAddresses(pool: pg.Pool, side: Side, id: number): Promise<string[]> {
  const { rows } =
    side === "customer"
      ? await pool.query("SELECT host_ips::text[] AS ips FROM customer_trunks WHERE id = $1", [id])
      : await pool.query("SELECT ARRAY[host] AS ips FROM vendor_trunks WHERE id = $1", [id]);
  const ips = ((rows[0]?.ips as string[] | null) ?? []).filter(Boolean);
  return ips.filter((ip) => isIP(ip.split("/")[0]!) !== 0);
}

/** Size, packets and state of the running captures and extracts from the switch servers (both servers' files summed). */
export async function refreshCaptures(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query("SELECT id FROM signaling_captures WHERE status = 'running' ORDER BY id LIMIT 500");
  if (!rows.length) return 0;
  const ids = rows.map((r) => Number(r.id));
  const answers = await askAll<{ captures: CaptureStatus[] }>("pcap_status", { ids }).catch(() => null);
  if (!answers) return 0;
  const byId = new Map<number, { running: boolean; exists: boolean; size: number; packets: number }>();
  for (const a of accepted(answers))
    for (const c of a.data!.captures) {
      const t = byId.get(c.id) ?? { running: false, exists: false, size: 0, packets: 0 };
      byId.set(c.id, {
        running: t.running || c.running,
        exists: t.exists || c.exists,
        size: t.size + c.size,
        packets: t.packets + c.packets,
      });
    }
  for (const id of ids) {
    const s = byId.get(id) ?? { running: false, exists: false, size: 0, packets: 0 };
    await pool.query(
      `UPDATE signaling_captures SET size_bytes = $2, packets = $3, updated_at = now(),
              status = $4 WHERE id = $1 AND status = 'running'`,
      [id, s.size, s.packets, s.running ? "running" : s.exists ? "done" : "failed"],
    );
  }
  return ids.length;
}

/** Capture files past their 30 days (not kept) are deleted on the switch servers, then listed no more. */
export async function purgeSwitchCaptures(pool: pg.Pool, keepDays: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id FROM signaling_captures WHERE NOT keep AND status <> 'running'
       AND updated_at < now() - make_interval(days => $1) ORDER BY id LIMIT 1000`,
    [keepDays],
  );
  if (!rows.length) return 0;
  const ids = rows.map((r) => Number(r.id));
  const answers = await askAll("pcap_delete", { ids }).catch(() => null);
  if (!answers || !accepted(answers).length) return 0;
  await pool.query("DELETE FROM signaling_captures WHERE id = ANY($1)", [ids]);
  return ids.length;
}

/** The recording's files on every switch server that answers, kept in pcap_files for the PCAP Trace list. */
export async function refreshPcapFiles(pool: pg.Pool): Promise<number> {
  type File = { name: string; started_at: string; size: number; modified_at: string };
  const answers = await askAll<{ files: File[] }>("pcap_files", {}, 10_000).catch(() => null);
  if (!answers) return 0;
  let n = 0;
  for (const a of accepted(answers)) {
    const files = a.data!.files;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM pcap_files WHERE node = $1", [a.node]);
      if (files.length)
        await c.query(
          `INSERT INTO pcap_files (node, name, started_at, size_bytes, modified_at)
           SELECT $1, * FROM unnest($2::text[], $3::timestamptz[], $4::bigint[], $5::timestamptz[])`,
          [a.node, files.map((f) => f.name), files.map((f) => f.started_at), files.map((f) => f.size), files.map((f) => f.modified_at)],
        );
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
    n += files.length;
  }
  return n;
}

/** The servers holding capture `id`'s file (size > 0). */
export async function captureSources(id: number): Promise<{ node: string; file: string }[]> {
  const answers = await askAll<{ captures: CaptureStatus[] }>("pcap_status", { ids: [id] });
  return accepted(answers)
    .filter((a) => a.data!.captures.some((c) => c.id === id && c.exists && c.size > 0))
    .map((a) => ({ node: a.node, file: `capture-${id}.pcapng` }))
    .sort((x, y) => x.node.localeCompare(y.node));
}

/** The recording files of the quarter starting at `start` (one per switch server). */
export async function traceSources(pool: pg.Pool, start: Date): Promise<{ node: string; file: string }[]> {
  const { rows } = await pool.query(
    `SELECT node, name FROM pcap_files WHERE started_at >= $1 AND started_at < $1 + interval '15 minutes' ORDER BY node`,
    [start],
  );
  return rows.map((r) => ({ node: r.node as string, file: r.name as string }));
}

/** The files one after another (pcapng sections), read from their servers in chunks. */
export function switchFiles(sources: { node: string; file: string }[]): Readable {
  async function* chunks() {
    for (const s of sources) {
      let offset = 0;
      for (;;) {
        const d = dataOf(
          await askNode<{ data: string; size: number; eof: boolean }>(s.node, "pcap_read", { file: s.file, offset }, 30_000),
        );
        const bytes = Buffer.from(d.data, "base64");
        if (bytes.length) yield bytes;
        offset += bytes.length;
        if (d.eof || !bytes.length) break;
      }
    }
  }
  return Readable.from(chunks());
}

// ---------------------------------------------------------------- Network Diagnosis

export interface DiagnosisInput {
  tool: string;
  destination: string;
  source?: string | null;
  port?: number | null;
  count?: number;
}

/** A probe on the switch server that has the source address (any server when none is given). */
export async function switchDiagnose(b: DiagnosisInput) {
  type Result = { command: string; lines: string[]; exit_code: number; duration_ms: number };
  const data = { tool: b.tool, destination: b.destination.trim(), source: b.source?.trim() || null, port: b.port ?? null, count: b.count ?? 4 };
  let result: Result;
  if (data.source) {
    const answers = await askAll<Result>("diagnose", data, 120_000);
    const done = answers.find((a) => a.ok && !a.skip);
    if (!done) {
      const refused = answers.find((a) => !a.ok);
      throw new SwitchRefused(refused?.error ?? `no switch server has the address ${data.source}`);
    }
    result = done.data!;
  } else {
    result = dataOf(await askAny<Result>("diagnose", data, 120_000));
  }
  return { command: result.command, lines: result.lines, exitCode: result.exit_code, durationMs: result.duration_ms };
}
