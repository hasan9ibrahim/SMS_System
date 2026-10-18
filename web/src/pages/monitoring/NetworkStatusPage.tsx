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
      page={page}
      title={`Network Status · ${vendor ? "Vendor" : "Customer"}`}
      queryScope={side}
      fetchPage={fetchPage}
      noSelection
      historyScope={null}
      initialState={{
        visible: [
          "enterpriseId",
          "trunkId",
          "enterpriseName",
          "trunkName",
          "ipAddresses",
          "connections",
          ...(vendor ? ["queue"] : []),
          "tps",
          "status",
          "since",
        ],
      }}
      above={
        <div className="deck-above">
          <ViewTabs label="Side" views={[...SIDES]} value={side} onChange={go} />
          <span className="muted small">
            {vendor
              ? "Our binds to each vendor, with the messages waiting."
              : "Sessions each customer has bound to us."}{" "}
            Refreshes every 10 s.
          </span>
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
        enterpriseName: { width: 220, render: (r) => <strong>{r.enterpriseName}</strong> },
        trunkName: { width: 190 },
        ipAddresses: {
          width: 220,
          render: (r) =>
            r.ipAddresses.length ? <span className="num small">{r.ipAddresses.join(", ")}</span> : muted("—"),
        },
        connections: {
          width: 120,
          align: "right",
          render: (r) => <span className="num">{`${r.connections} / ${r.maxConnections}`}</span>,
        },
        queue: {
          width: 90,
          align: "right",
          render: (r) => <span className={`num${(r.queue ?? 0) > 200 ? " tone-warning" : ""}`}>{r.queue ?? "—"}</span>,
        },
        tps: { width: 80, align: "right", render: (r) => <span className="num">{r.tps.toFixed(1)}</span> },
        status: {
          width: 110,
          render: (r) => (
            <span>
              <StatusDot tone={bindTone(r.status)} /> {r.status[0]!.toUpperCase() + r.status.slice(1)}
            </span>
          ),
        },
        since: { width: 170, render: (r) => fmtWhen(r.since) },
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
        header: "Action",
        width: 90,
        render: (r) =>
          r.status === "online" ? (
            <Button small onClick={() => void act(r, "stop")}>
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
