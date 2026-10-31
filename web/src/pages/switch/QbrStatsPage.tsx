// QBR stats (§6.3): the quality feed for QBR routing. ASR, DLR and ADD (average delivery
// delay) per trunk and destination over the last 24 hours, refreshed every 5 minutes. "QBR
// Stats For" switches between customer and vendor trunks (kept in the tab URL, ?side=). A
// vendor stat can be set by hand (Add Vendor Stat); the override wins until it is cleared, and
// QBR rules order vendors by the destination's effective DLR. Each change can be undone.
import { useState } from "react";
import { useLocation } from "react-router";
import type { Destination, ListQuery, QbrStat, TrunkListRow } from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import { useClearQbrOverride, useQbrOverride } from "../../api/routingExtras";
import { FormField } from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ListLookup } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { qualityClass } from "../../ui/quality";
import { problemText } from "../routing/dialogs";
import { RecordDialog } from "../reference/shared";
import { destLabel } from "../rates/DestinationTree";

const page = pageForPath("/switch/qbr-stats")!;
type Side = QbrStat["side"];

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
const secs = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} s`);

function OverrideDialog({ row, done }: { row: QbrStat | null; done: () => void }) {
  const [vendorTrunkId, setVendor] = useState<number | null>(row?.trunkId ?? null);
  const [destinationId, setDest] = useState<number | null>(row?.destinationId ?? null);
  const num = (v: number | null) => (v === null ? "" : String(v));
  const [asr, setAsr] = useState(num(row?.overridden ? row.asr : null));
  const [dlr, setDlr] = useState(num(row?.overridden ? row.dlr : null));
  const [add, setAdd] = useState(num(row?.overridden ? row.addSeconds : null));
  const [error, setError] = useState<string | null>(null);
  const save = useQbrOverride();
  const notifySaved = useNotifySaved();
  const parse = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));
  const submit = () => {
    if (!vendorTrunkId || !destinationId) return setError("Choose the vendor trunk and the MCCMNC code.");
    const body = { vendorTrunkId, destinationId, asr: parse(asr), dlr: parse(dlr), addSeconds: parse(add) };
    if ([body.asr, body.dlr, body.addSeconds].some((x) => x !== null && !Number.isFinite(x)))
      return setError("ASR, DLR and ADD must be numbers.");
    save.mutate(body, {
      onSuccess: (r) => {
        if (r.change) notifySaved(r.change, `QBR stat set: ${r.record.trunk} · ${r.record.mccmnc}`);
        done();
      },
      onError: (e) => setError(problemText(e)),
    });
  };
  return (
    <RecordDialog
      title={row ? `Override ${row.trunk} · ${row.mccmnc}` : "Add Vendor Stat"}
      saveLabel="Save stat"
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={done}
      width={560}
    >
      <FormField label="Vendor Trunk" required wide>
        <ListLookup<TrunkListRow>
          list="vendor_trunks"
          value={vendorTrunkId}
          onChange={(t) => setVendor(t?.id ?? null)}
          labelOf={(t) => t.name}
          detailOf={(t) => t.enterpriseName}
          placeholder="Search vendor trunks…"
          disabled={!!row}
        />
      </FormField>
      <FormField label="MCCMNC" required wide>
        <ListLookup<Destination>
          list="destinations"
          value={destinationId}
          onChange={(d) => setDest(d?.id ?? null)}
          labelOf={(d) => destLabel(d.country, d.network, d.allNetworks, d.mccmnc)}
          placeholder="Country, network or MCCMNC…"
          disabled={!!row}
        />
      </FormField>
      {(
        [
          ["ASR %", asr, setAsr, row?.trafficAsr],
          ["DLR %", dlr, setDlr, row?.trafficDlr],
          ["ADD (s)", add, setAdd, row?.trafficAddSeconds],
        ] as const
      ).map(([label, value, setter, traffic]) => (
        <FormField
          key={label}
          label={label}
          hint={`Empty = traffic figure${traffic != null ? ` (${traffic})` : ""}`}
        >
          <input className="num" inputMode="decimal" value={value} onChange={(e) => setter(e.target.value)} />
        </FormField>
      ))}
    </RecordDialog>
  );
}

const openOverride = (row: QbrStat | null) => ask<void>((done) => <OverrideDialog row={row} done={() => done()} />);

function ClearButton({ row }: { row: QbrStat }) {
  const clear = useClearQbrOverride();
  const notifySaved = useNotifySaved();
  return (
    <Button
      small
      icon="undo"
      disabled={clear.isPending}
      onClick={() =>
        clear.mutate(row.id, {
          onSuccess: (r) => r.change && notifySaved(r.change, `Override cleared: ${row.trunk} · ${row.mccmnc}`),
          onError: (e) => toast({ tone: "error", message: problemText(e) }),
        })
      }
    >
      Clear override
    </Button>
  );
}

export function QbrStatsPage() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const side: Side = new URLSearchParams(location.search).get("side") === "customer" ? "customer" : "vendor";
  const setSide = (s: Side) => navigate(`/switch/qbr-stats?side=${s}`, { replace: true });
  const clear = useClearQbrOverride();
  const notifySaved = useNotifySaved();
  const clearOverride = (row: QbrStat) =>
    clear.mutate(row.id, {
      onSuccess: (r) => r.change && notifySaved(r.change, `Override cleared: ${row.trunk} · ${row.mccmnc}`),
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  const withSide = (body: ListQuery): ListQuery => ({
    ...body,
    filter: {
      logic: "and",
      conditions: [{ field: "side", op: "eq", value: side }, ...(body.filter ? [body.filter] : [])],
    },
  });
  return (
    <ListScreen<QbrStat>
      key={side}
      list="qbr_stats"
      listExport={{ query: withSide }}
      page={page}
      noSelection
      queryScope={side}
      fetchPage={(body) => fetchListPage<QbrStat>("qbr_stats", withSide(body))}
      historyScope={{ entityTypes: ["qbr_stat"] }}
      rowActions={(r) => [
        {
          label: "Override…",
          icon: "file",
          main: true,
          disabled: r.side !== "vendor",
          hint: r.side === "vendor" ? undefined : "Only vendor stats can be set by hand",
          onSelect: () => void openOverride(r),
        },
        {
          label: "Clear override",
          icon: "undo",
          disabled: r.side !== "vendor" || !r.overridden || clear.isPending,
          hint: r.overridden ? undefined : "No manual override on this stat",
          onSelect: () => clearOverride(r),
        },
      ]}
      primary={
        side === "vendor"
          ? { label: "Add vendor stat", icon: "plus", onClick: () => void openOverride(null) }
          : undefined
      }
      above={
        <div className="rm-trunk">
          <span className="muted">QBR Stats For</span>
          <div className="segmented small" role="radiogroup" aria-label="QBR stats for">
            {(["customer", "vendor"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={side === s}
                className={side === s ? "on" : ""}
                onClick={() => setSide(s)}
              >
                {s === "customer" ? "Customer trunks" : "Vendor trunks"}
              </button>
            ))}
          </div>
        </div>
      }
      columns={{
        trunk: { width: 190 },
        mccmnc: { width: 90, render: (r) => <span className="num">{r.mccmnc}</span> },
        country: { width: 170 },
        network: { width: 210 },
        attempts: {
          width: 120,
          align: "right",
          render: (r) => <span className="num">{r.attempts.toLocaleString("en-US")}</span>,
        },
        asr: {
          width: 90,
          align: "right",
          render: (r) => <span className={`num ${qualityClass(r.asr)}`}>{pct(r.asr)}</span>,
        },
        dlr: {
          width: 90,
          align: "right",
          render: (r) => <span className={`num ${qualityClass(r.dlr)}`}>{pct(r.dlr)}</span>,
        },
        addSeconds: { width: 90, align: "right", render: (r) => <span className="num">{secs(r.addSeconds)}</span> },
        overridden: {
          width: 100,
          render: (r) => (r.overridden ? <span className="rr-badge tone-warning">Manual</span> : ""),
        },
        updatedAt: { width: 160, render: (r) => r.updatedAt.slice(0, 16).replace("T", " ") },
      }}
      onOpen={(r) => r.side === "vendor" && void openOverride(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.trunk} · {r.mccmnc}
            </strong>
            <span className="muted">
              {r.country} · {r.network}
            </span>
          </>
        ),
        sections: [
          {
            key: "stat",
            label: "Stat",
            actions:
              r.side === "vendor" ? (
                <>
                  <Button small icon="file" onClick={() => void openOverride(r)}>
                    Override
                  </Button>
                  {r.overridden && <ClearButton row={r} />}
                </>
              ) : undefined,
            content: (
              <table className="rr-summary qbr-compare">
                <thead>
                  <tr>
                    <th />
                    <th className="r">ASR</th>
                    <th className="r">DLR</th>
                    <th className="r">ADD</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Traffic, 24 h ({r.attempts.toLocaleString("en-US")} attempts)</td>
                    <td className={`r num ${qualityClass(r.trafficAsr)}`}>{pct(r.trafficAsr)}</td>
                    <td className={`r num ${qualityClass(r.trafficDlr)}`}>{pct(r.trafficDlr)}</td>
                    <td className="r num">{secs(r.trafficAddSeconds)}</td>
                  </tr>
                  <tr className="strong">
                    <td>
                      Used by QBR routing
                      {r.overridden && <span className="muted"> (override by {r.updatedBy ?? "—"})</span>}
                    </td>
                    <td className={`r num ${qualityClass(r.asr)}`}>{pct(r.asr)}</td>
                    <td className={`r num ${qualityClass(r.dlr)}`}>{pct(r.dlr)}</td>
                    <td className="r num">{secs(r.addSeconds)}</td>
                  </tr>
                </tbody>
              </table>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter overrides a vendor stat · Ctrl+Z undo"
    />
  );
}
