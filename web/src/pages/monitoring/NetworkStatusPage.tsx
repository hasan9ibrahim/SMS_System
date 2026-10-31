// Network Status (§9.2, §12.4, §13.1): Customer / Vendor tabs with Enterprise ID, trunk ID, Enterprise
// Name, Trunk Name, IP Address, Number of Connections, Queue (vendors), TPS and Status; per-row Start /
// Stop binds a vendor or kicks a customer's sessions; CSV and Excel export. The detail lists the SMPP
// sessions, where delivery receipts go back (session affinity, §13.1). Refreshes every 10 s.
import type { ListQuery, NetworkBindRow } from "@sms/contract";
import { fetchListPage, type ListPage } from "../../api/hooks";
import { exportNetworkBinds, useBindSessions, useTrunkBind } from "../../api/observation";
import { toListQuery } from "../../grid/filterModel";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen } from "../reference/shared";
import { bindTone } from "./monitorModel";
import { useAutoRefresh, useView, ViewTabs } from "./parts";

const page = pageForPath("/monitoring/network-status")!;
const muted = (v: string) => <span className="muted">{v}</span>;
type Side = "customer" | "vendor";
const SIDES = [
  { key: "customer", label: "Customer" },
  { key: "vendor", label: "Vendor" },
] as const;
type Row = Omit<NetworkBindRow, "id"> & { id: number; key: string };

function Sessions({ row }: { row: Row }) {
  const q = useBindSessions(row.side as Side, row.trunkId);
  if (!q.data) return <p className="muted small">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  if (!q.data.sessions.length) return <p className="muted small">No bound sessions.</p>;
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th>Session</th>
          <th>Remote</th>
          <th>Bind</th>
          <th>Since</th>
          <th className="num">Submitted</th>
          <th className="num">Receipts waiting</th>
        </tr>
      </thead>
      <tbody>
        {q.data.sessions.map((s) => (
          <tr key={s.sessionId}>
            <td className="small">{s.sessionId}</td>
            <td className="small">
              {s.ip}:{s.port}
            </td>
            <td className="small">{s.bindType}</td>
            <td className="small">{fmtWhen(s.since)}</td>
            <td className="small num">{s.submitted.toLocaleString("en-US")}</td>
            <td className="small num">{s.receiptsPending}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConfirmStop({ row, done }: { row: Row; done: (ok: boolean) => void }) {
  return (
    <Modal
      title={`Stop ${row.trunkName}?`}
      width={460}
      onClose={() => done(false)}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => done(true)}>
            Stop
          </Button>
        </>
      }
    >
      <p>
        {row.side === "vendor"
          ? `The switch unbinds its ${row.connections} connection(s) to ${row.enterpriseName}. Messages waiting in the queue are re-routed.`
          : `The ${row.connections} session(s) of ${row.enterpriseName} are closed and new binds are refused until Start.`}
      </p>
    </Modal>
  );
}

/** Each IP as a chip with its bound sessions; an allowed IP with none is dashed (team trial round 4). */
function IpSessions({ row }: { row: Row }) {
  const ips = row.ipSessions ?? row.ipAddresses.map((ip) => ({ ip, sessions: 1 }));
  if (!ips.length) return muted("—");
  const up = ips.filter((x) => x.sessions > 0).length;
  const summary =
    ips.length === 1
      ? up
        ? "Up on its only IP"
        : "Down on its only IP"
      : up === ips.length
        ? `Up on all ${ips.length} IPs`
        : `Up on ${up} of ${ips.length} IPs`;
  return (
    <span className="two-line">
      <span className={`small strong ${up === ips.length ? "tone-good" : up ? "tone-warning" : "tone-error"}`}>
        {summary}
      </span>
      <span className="ip-chips">
        {ips.map((x) => (
          <span key={x.ip} className={`ip-chip${x.sessions ? " on" : ""}`}>
            <span className="ip-dot" aria-hidden="true" />
            <span className="num">{x.ip}</span>
            <span className="ip-count">{x.sessions ? `×${x.sessions}` : "none"}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

export function NetworkStatusPage() {
  const [side, go] = useView<Side>("/monitoring/network-status", ["customer", "vendor"], "side");
  const bind = useTrunkBind();
  useAutoRefresh(10_000);
  const withSide = <Q extends Pick<ListQuery, "filter">>(body: Q): Q => ({
    ...body,
    filter: {
      logic: "and",
      conditions: [{ field: "side", op: "eq", value: side }, ...(body.filter ? [body.filter] : [])],
    },
  });
  const fetchPage = (body: ListQuery): Promise<ListPage<Row>> =>
    fetchListPage<NetworkBindRow>("network_binds", withSide(body)).then((p) => ({
      ...p,
      rows: p.rows.map((r) => ({ ...r, id: r.trunkId, key: r.id })),
    }));
  const act = async (row: Row, action: "start" | "stop") => {
    if (action === "stop" && !(await ask<boolean>((d) => <ConfirmStop row={row} done={(ok) => d(ok)} />))) return;
    bind.mutate(
      { side: row.side as Side, id: row.trunkId, action },
      {
        onSuccess: (r) =>
          toast({
            tone: "good",
            message:
              action === "stop"
                ? `${r.trunkName} stopped`
                : row.side === "vendor"
                  ? `${r.trunkName} bound with ${r.connections} connection(s)`
                  : `${r.trunkName}: binds accepted again; the customer reconnects shortly`,
          }),
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
  };
  const vendor = side === "vendor";
  return (
    <ListScreen<Row>
      key={side}
      list="network_binds"
      listExport={{ query: withSide }}
      page={page}
      title={`Network Status · ${vendor ? "Vendor" : "Customer"}`}
      queryScope={side}
      fetchPage={fetchPage}
      noSelection
      historyScope={null}
      // Two-line rows (team trial round 4): enterprise over trunk and IDs, IP chips with their sessions, a bar for
      // connections used, the status over its time.
      rowHeight={64}
      initialState={{
        visible: ["enterpriseName", "ipAddresses", "connections", ...(vendor ? ["queue"] : []), "tps", "since"],
      }}
      above={
        <div className="deck-above">
          <ViewTabs label="Side" views={[...SIDES]} value={side} onChange={go} />
        </div>
      }
      toolbar={(state) => (
        <span className="deck-export">
          {(["csv", "excel"] as const).map((t) => (
            <Button
              key={t}
              small
              icon="download"
              onClick={() =>
                void exportNetworkBinds({ query: withSide(toListQuery(state)), fileType: t }).catch((e) =>
                  toast({ tone: "error", message: problemText(e) }),
                )
              }
            >
              {t === "csv" ? "CSV" : "Excel"}
            </Button>
          ))}
        </span>
      )}
      columns={{
        enterpriseId: { width: 110 },
        trunkId: { width: 90 },
        enterpriseName: {
          width: 300,
          label: "Enterprise · trunk",
          render: (r) => (
            <span className="two-line">
              <strong>{r.enterpriseName}</strong>
              <span className="muted small">
                {r.trunkName} · ID {r.trunkId} · Ent {r.enterpriseId}
              </span>
            </span>
          ),
        },
        trunkName: { width: 190 },
        ipAddresses: { width: 520, label: "IPs and sessions", render: (r) => <IpSessions row={r} /> },
        connections: {
          width: 220,
          label: "Connections",
          render: (r) => {
            const pct = r.maxConnections ? Math.min(100, (r.connections / r.maxConnections) * 100) : 0;
            return (
              <span className="two-line conn-bar-cell">
                <span className="num">
                  <strong>{r.connections}</strong> <span className="muted">/ {r.maxConnections}</span>
                </span>
                <span className={`conn-bar${pct >= 100 ? " full" : ""}`}>
                  <span style={{ width: `${pct}%` }} />
                </span>
              </span>
            );
          },
        },
        queue: {
          width: 90,
          align: "right",
          render: (r) => <span className={`num${(r.queue ?? 0) > 200 ? " tone-warning" : ""}`}>{r.queue ?? "—"}</span>,
        },
        tps: { width: 80, align: "right", render: (r) => <strong className="num">{r.tps.toFixed(1)}</strong> },
        status: {
          width: 110,
          render: (r) => (
            <span>
              <StatusDot tone={bindTone(r.status)} /> {r.status[0]!.toUpperCase() + r.status.slice(1)}
            </span>
          ),
        },
        since: {
          width: 170,
          label: "Online since",
          render: (r) => (
            <span className="two-line">
              <span className={r.status === "online" ? "tone-good strong" : "muted strong"}>
                <StatusDot tone={bindTone(r.status)} /> {r.status[0]!.toUpperCase() + r.status.slice(1)}
              </span>
              <span className="muted small">{fmtWhen(r.since)}</span>
            </span>
          ),
        },
      }}
      rowActions={(r) => [
        {
          label: "Start",
          icon: "play",
          main: true,
          disabled: r.status === "online",
          hint: r.status === "online" ? "Already online" : vendor ? "Bind to the vendor" : "Accept binds again",
          onSelect: () => void act(r, "start"),
        },
        {
          label: "Stop…",
          icon: "pause",
          main: true,
          disabled: r.status !== "online",
          hint:
            r.status !== "online"
              ? "Only online trunks can be stopped"
              : vendor
                ? "Unbind from the vendor"
                : "Close the customer's sessions",
          onSelect: () => void act(r, "stop"),
        },
      ]}
      trailing={{
        header: "",
        width: 90,
        render: (r) =>
          r.status === "online" ? (
            <Button small variant="danger" className="btn-outline-danger" onClick={() => void act(r, "stop")}>
              Stop
            </Button>
          ) : (
            <Button small onClick={() => void act(r, "start")}>
              Start
            </Button>
          ),
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.trunkName}</strong>
            <span className="muted">
              {r.enterpriseName} · {r.status} since {fmtWhen(r.since)}
              {r.changedBy ? ` (by ${r.changedBy})` : ""}
            </span>
          </>
        ),
        sections: [{ key: "sessions", label: "SMPP sessions", content: <Sessions row={r} /> }],
      })}
      shortcuts="↑↓ move · refreshes every 10 s"
    />
  );
}
