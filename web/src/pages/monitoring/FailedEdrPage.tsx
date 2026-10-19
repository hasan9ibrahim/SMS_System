// Failed EDR Search and Failed EDR Download (§9.2): messages rejected before routing (no vendor
// leg). From / To Date in the filter row, every column filters; Generate Request queues a CSV / XLSX
// export, listed on the Downloads tab.
import type { FailedEdrRow, ListQuery } from "@sms/contract";
import { fetchListPage, type ListPage } from "../../api/hooks";
import type { GridState } from "../../grid/filterModel";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { RepushDialog } from "./EdrSearchPage";
import { ask } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { fmtSeconds, timeBounds, timeCondition, uuidKey } from "./monitorModel";
import { DownloadsList, RequestDialog, useView, ViewTabs } from "./parts";

const page = pageForPath("/monitoring/failed-edr")!;
const VIEWS = [
  { key: "search", label: "Failed EDR Search" },
  { key: "downloads", label: "Failed EDR Download" },
] as const;
type View = (typeof VIEWS)[number]["key"];
type Row = Omit<FailedEdrRow, "id"> & { id: number; uuid: string };

const fetchFailed = (body: ListQuery): Promise<ListPage<Row>> =>
  fetchListPage<FailedEdrRow>("failed_edrs", body).then((p) => ({
    ...p,
    rows: p.rows.map((r) => ({ ...r, id: uuidKey(r.id), uuid: r.id })),
  }));

function Tabs() {
  const [view, go] = useView<View>(
    "/monitoring/failed-edr",
    VIEWS.map((v) => v.key),
  );
  return <ViewTabs label="Failed EDRs" views={[...VIEWS]} value={view} onChange={go} />;
}

function TimeBoxes({ state, setState }: { state: GridState; setState: (s: GridState) => void }) {
  const b = timeBounds(state.columns.startTime);
  const set = (from: string, to: string) => {
    const columns = { ...state.columns };
    const c = timeCondition("startTime", from, to);
    if (c) columns.startTime = c;
    else delete columns.startTime;
    setState({ ...state, columns });
  };
  return (
    <div className="edr-toolbar">
      <label className="small">
        From Date *
        <input
          type="datetime-local"
          value={b.from}
          onChange={(e) => set(e.target.value, b.to)}
          aria-label="From (UTC)"
        />
      </label>
      <label className="small">
        To Date *
        <input type="datetime-local" value={b.to} onChange={(e) => set(b.from, e.target.value)} aria-label="To (UTC)" />
      </label>
      <span className="muted small">UTC</span>
    </div>
  );
}

export function FailedEdrPage() {
  const [view] = useView<View>(
    "/monitoring/failed-edr",
    VIEWS.map((v) => v.key),
  );
  const tabs = (
    <div className="deck-above">
      <Tabs />
    </div>
  );
  if (view === "downloads")
    return <DownloadsList kind="failed_edr" page={page} title="Failed EDR Download" above={tabs} />;
  return (
    <ListScreen<Row>
      list="failed_edrs"
      page={page}
      title="Failed EDR Search"
      rowActions={(r) => [
        {
          label: "Repush…",
          icon: "send",
          main: true,
          onSelect: () => void ask<void>((d) => <RepushDialog ids={[r.uuid]} eligible={1} done={() => d()} />),
        },
        {
          label: "Copy Msg ID",
          icon: "copy",
          onSelect: () => void window.navigator.clipboard?.writeText(r.customerMsgId),
        },
      ]}
      // Rejected messages can be re-sent on a vendor trunk (team trial round 1).
      selection={{
        summary: (_rows, ids) => `${ids.size} selected`,
        bulk: (_ids, clear, rows) => [
          {
            label: `Repush ${rows.length} to a vendor…`,
            icon: "send",
            disabled: !rows.length,
            onSelect: () =>
              void ask<void>((d) => (
                <RepushDialog ids={rows.map((r) => r.uuid)} eligible={rows.length} done={() => d()} />
              )).then(clear),
          },
        ],
      }}
      historyScope={null}
      fetchPage={fetchFailed}
      above={tabs}
      toolbar={(state, setState) => <TimeBoxes state={state} setState={setState} />}
      onExport={(s) => void ask<void>((d) => <RequestDialog kind="failed_edr" state={s} done={() => d()} />)}
      columns={{
        startTime: { width: 170, render: (r) => <span className="num">{fmtSeconds(r.startTime)}</span> },
        customerEnterprise: { width: 210, render: (r) => r.customerEnterprise ?? "—" },
        customerTrunk: { width: 170 },
        customerIp: { width: 130, render: (r) => <span className="num">{r.customerIp}</span> },
        customerMsgId: { width: 170, render: (r) => <span className="num small">{r.customerMsgId}</span> },
        senderId: { width: 130 },
        dnid: { width: 140, render: (r) => <span className="num">{r.dnid}</span> },
        customerMccmnc: { width: 100, render: (r) => <span className="num">{r.customerMccmnc}</span> },
        causeCode: { width: 210, render: (r) => <span className="tone-error">{`${r.causeCode} ${r.causeText}`}</span> },
        causeText: { width: 180 },
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.senderId} → {r.dnid}
            </strong>
            <span className="muted">
              {fmtSeconds(r.startTime)} · {r.causeText}
            </span>
          </>
        ),
        sections: [
          {
            key: "message",
            label: "Message",
            actions: (
              <Button small onClick={() => void window.navigator.clipboard?.writeText(r.customerMsgId)}>
                Copy Msg ID
              </Button>
            ),
            content: (
              <dl className="kv">
                <dt>Customer</dt>
                <dd>
                  {r.customerEnterprise} · {r.customerTrunk}
                </dd>
                <dt>From</dt>
                <dd className="num">
                  {r.customerIp}:{r.customerPort}
                </dd>
                <dt>Customer Msg ID</dt>
                <dd className="num">{r.customerMsgId}</dd>
                <dt>Destination</dt>
                <dd>
                  {r.customerMccmnc || "unknown"} {r.country}
                </dd>
                <dt>Error</dt>
                <dd className="tone-error">
                  {r.causeCode} {r.causeText}
                </dd>
                <dt>Text</dt>
                <dd>{r.messageText}</dd>
                <dt>UUID</dt>
                <dd className="num small">{r.uuid}</dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Export: Generate Request"
    />
  );
}
