// Network Status from the switch (§9.2, §13.1; backend step 11): the switch's session events (`sms.session.*`,
// backend/apps/sms_switch/lib/sms/switch/{customer,vendor}/events.ex) keep `bind_sessions` and `trunk_binds` as the
// SMPP sessions really are, instead of the bind simulator of api/network.ts. A trunk is online while it has a bound
// session; one stopped from the GUI stays stopped. The Bind Down Alert (§5.1 Bind Alert, §5.5) goes out when the
// switch reports a vendor connection down for the trunk's Bind Alert time.
import type pg from "pg";
import { fillBody, fillText } from "../email/html.js";
import { companyDetails, companyMailbox, companyPlaceholders, companyTemplate, logEmail } from "../api/emailLog.js";
import { contactEmails } from "../api/switchTools.js";

type Db = pg.Pool | pg.PoolClient;

export interface SessionEvent {
  session_id?: string;
  trunk_id?: number;
  ip?: string;
  host?: string;
  port?: number;
  bind?: string;
  down_for_ms?: number;
}

const BIND_TYPES: Record<string, "TX" | "RX" | "TR"> = { tx: "TX", rx: "RX", trx: "TR", tr: "TR", transceiver: "TR" };
const bindType = (b: string | undefined) => BIND_TYPES[String(b ?? "").toLowerCase()] ?? "TR";

/** Applies one session event (`session.customer.bound`, `session.vendor.closed`, …); exported for tests. */
export async function applySessionEvent(c: Db, type: string, raw: Record<string, unknown>): Promise<void> {
  const [, side, what] = type.split(".") as [string, "customer" | "vendor", string];
  if (side !== "customer" && side !== "vendor") return;
  const e = raw as SessionEvent;
  const trunkId = Number(e.trunk_id);
  if (!trunkId || !e.session_id) return;
  if (what === "bound") {
    await c.query(
      `INSERT INTO bind_sessions (session_id, side, trunk_id, ip, port, bind_type)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (session_id) DO NOTHING`,
      [e.session_id, side, trunkId, ipOf(e.ip ?? e.host), Number(e.port ?? 0), bindType(e.bind)],
    );
    await recount(c, side, trunkId);
  } else if (what === "closed") {
    await c.query("DELETE FROM bind_sessions WHERE session_id = $1", [e.session_id]);
    await recount(c, side, trunkId);
  } else if (what === "bind_down" && side === "vendor") {
    await bindDownAlert(c, trunkId, Number(e.down_for_ms ?? 0));
  }
}

/** A host name is not an inet: the vendor's address is kept as 0.0.0.0 then (the host shows on the trunk). */
const ipOf = (v: string | undefined) => (v && /^[0-9a-f.:]+$/i.test(v) ? v : "0.0.0.0");

/** The trunk's connection count and status from its sessions; a trunk stopped from the GUI stays stopped. */
async function recount(c: Db, side: string, trunkId: number) {
  await c.query(
    `INSERT INTO trunk_binds AS b (side, trunk_id, status, connections, queue, tps, since)
     SELECT $1, $2, CASE WHEN n > 0 THEN 'online' ELSE 'offline' END, n, CASE WHEN $1 = 'vendor' THEN 0 END, 0, now()
       FROM (SELECT count(*)::int AS n FROM bind_sessions WHERE side = $1 AND trunk_id = $2) s
     ON CONFLICT (side, trunk_id) DO UPDATE SET
       connections = EXCLUDED.connections,
       status = CASE WHEN b.status = 'stopped' THEN 'stopped' ELSE EXCLUDED.status END,
       since = CASE WHEN b.status <> 'stopped' AND b.status <> EXCLUDED.status THEN now() ELSE b.since END,
       changed_by_id = CASE WHEN b.status <> 'stopped' AND b.status <> EXCLUDED.status THEN NULL ELSE b.changed_by_id END`,
    [side, trunkId],
  );
}

/** The Bind Down e-mail to the vendor's technical contacts, when its enterprise has Bind Alert on. */
async function bindDownAlert(c: Db, trunkId: number, downForMs: number) {
  const { rows } = await c.query(
    `SELECT t.name, t.enterprise_id, e.bind_alert FROM vendor_trunks t JOIN enterprises e ON e.id = t.enterprise_id
      WHERE t.id = $1`,
    [trunkId],
  );
  const t = rows[0];
  if (!t || t.bind_alert === false) return;
  const enterpriseId = Number(t.enterprise_id);
  const since = new Date(Date.now() - downForMs).toISOString().slice(0, 16).replace("T", " ");
  const vars: Record<string, string> = {
    ...companyPlaceholders(await companyDetails(c, { enterpriseId })),
    trunk: String(t.name),
    since,
  };
  const tpl = await companyTemplate(c, { enterpriseId }, "bind_down");
  const sender = await companyMailbox(c, enterpriseId, "techInfo");
  await logEmail(c, {
    type: "bind_down_alert",
    enterpriseId,
    vendorTrunkId: trunkId,
    to: await contactEmails(c, enterpriseId, ["technical"]),
    cc: sender ? [sender] : [],
    sender,
    subject: tpl ? fillText(tpl.subject, vars) : `Bind down: ${vars.trunk}`,
    body: tpl ? fillBody(tpl.body, vars) : `<p>Our connection to ${vars.trunk} has been down since ${since} UTC.</p>`,
  });
}
