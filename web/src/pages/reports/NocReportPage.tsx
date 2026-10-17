// NOC report (§13.15): is traffic flowing well, and where are the problems? The Master Report preset
// per vendor trunk (TPS, ASR, DLR, delay, failed submits, re-routes) against last week, plus binds
// that are down, the top error codes and the worst vendor trunks in the window. Refreshes every minute.
import { useNocInsights } from "../../api/masterReports";
import { pageForPath } from "../../nav/registry";
import { useTabNavigate } from "../../shell/tabContext";
import { StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import type { Settings } from "./masterModel";
import { ReportScreen, type ReportPreset } from "./ReportScreen";

const page = pageForPath("/reports/noc")!;
const PRESET: ReportPreset = {
  settings: {
    groupBy: ["vendorTrunk"],
    metrics: ["attempts", "tpsAvg", "tpsPeak", "asr", "dlrVendor", "deliveryDelayS", "failedSubmits", "reroutes"],
    timezone: "UTC",
    period: "today",
    compare: "previous_week",
  },
  sort: [{ field: "attempts", dir: "desc" }],
};

function NocPanel({ settings }: { settings: Settings }) {
  const navigate = useTabNavigate();
  const q = useNocInsights({
    period: settings.period,
    from: settings.from ?? null,
    to: settings.to ?? null,
    timezone: settings.timezone,
  });
  if (!q.data) return <p className="muted small">{q.isError ? problemText(q.error) : "Loading problems…"}</p>;
  const d = q.data;
  return (
    <div className="sales-cards noc-cards">
      <section className="card sales-card">
        <h3>
          Binds down <span className="muted small">({d.bindsDown.length})</span>
        </h3>
        <table className="mini-table">
          <tbody>
            {d.bindsDown.slice(0, 8).map((b) => (
              <tr key={`${b.side}-${b.trunkId}`}>
                <td className="small">
                  <StatusDot tone={b.status === "stopped" ? "warning" : "error"} /> {b.trunk}
                </td>
                <td className="small muted">{b.side}</td>
                <td className="small num">
                  {b.downMinutes < 120 ? `${b.downMinutes} min` : `${Math.round(b.downMinutes / 60)} h`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="link small" onClick={() => navigate("/monitoring/network-status?side=vendor")}>
          Network status
        </button>
      </section>
      <section className="card sales-card">
        <h3>Top error codes</h3>
        <table className="mini-table">
          <tbody>
            {d.topErrors.map((e) => (
              <tr key={e.causeCode}>
                <td className="small">
                  {e.causeCode} {e.causeText}
                </td>
                <td className="small num">{e.count.toLocaleString("en-US")}</td>
                <td className="small num muted">{e.sharePct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card sales-card noc-wide">
        <h3>
          Worst vendor trunks <span className="muted small">(at least 100 attempts)</span>
        </h3>
        <table className="mini-table">
          <thead>
            <tr>
              <th>Vendor trunk</th>
              <th className="num">Attempts</th>
              <th className="num">ASR</th>
              <th className="num">DLR</th>
              <th className="num">Delay (s)</th>
              <th>Problem</th>
            </tr>
          </thead>
          <tbody>
            {d.worstVendors.slice(0, 8).map((v) => (
              <tr key={v.vendorTrunkId}>
                <td className="small">{v.vendorTrunk}</td>
                <td className="small num">{v.attempts.toLocaleString("en-US")}</td>
                <td className={`small num${(v.asr ?? 100) < 75 ? " tone-error" : ""}`}>{v.asr ?? "—"}</td>
                <td className={`small num${(v.dlr ?? 100) < 70 ? " tone-error" : ""}`}>{v.dlr ?? "—"}</td>
                <td className={`small num${(v.deliveryDelayS ?? 0) > 20 ? " tone-warning" : ""}`}>
                  {v.deliveryDelayS ?? "—"}
                </td>
                <td className="small">{v.problem}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function NocReportPage() {
  return <ReportScreen page={page} title="NOC report" preset={PRESET} insights={(s) => <NocPanel settings={s} />} />;
}
