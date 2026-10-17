// Sales report (§13.15): how clients and destinations grow. The Master Report preset per customer
// and destination with the previous period, plus growing, declining, new and stopped clients for
// the same period, filtered by account manager, country, category and the change threshold.
import { useState } from "react";
import type { SalesMover, UserSummary } from "@sms/contract";
import { useSalesInsights } from "../../api/masterReports";
import { usePlatformCurrency } from "../../api/records";
import { pageForPath } from "../../nav/registry";
import { ListLookup } from "../../records/parts";
import { problemText } from "../routing/dialogs";
import type { Settings } from "./masterModel";
import { ReportScreen, type ReportPreset } from "./ReportScreen";

const page = pageForPath("/reports/sales")!;
const PRESET: ReportPreset = {
  settings: {
    groupBy: ["customer", "destination"],
    metrics: ["attempts", "delivered", "revenue", "margin", "marginPct", "avgRateCustomer"],
    timezone: "UTC",
    period: "last_7_days",
    compare: "previous_period",
  },
  sort: [{ field: "revenue", dir: "desc" }],
};

function MoverList({
  title,
  rows,
  ccy,
  tone,
  empty,
}: {
  title: string;
  rows: SalesMover[];
  ccy: string;
  tone: string;
  empty: string;
}) {
  const money = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return (
    <section className="card sales-card">
      <h3>
        {title} <span className="muted small">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <table className="mini-table">
          <tbody>
            {rows.slice(0, 6).map((m) => (
              <tr key={m.enterpriseId}>
                <td className="small" title={m.accountManager ?? ""}>
                  {m.enterprise}
                </td>
                <td className="small num">
                  {money(m.revenue)} {ccy}
                </td>
                <td className={`small num ${tone}`}>
                  {m.changePct === null
                    ? m.previousAttempts
                      ? "stopped"
                      : "new"
                    : `${m.changePct > 0 ? "+" : ""}${m.changePct.toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SalesPanel({ settings }: { settings: Settings }) {
  const ccy = usePlatformCurrency();
  const [amId, setAmId] = useState<number | null>(null);
  const [country, setCountry] = useState("");
  const [threshold, setThreshold] = useState(20);
  const q = useSalesInsights({
    period: settings.period,
    from: settings.from ?? null,
    to: settings.to ?? null,
    timezone: settings.timezone,
    accountManagerId: amId,
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    productCategoryId: null,
    thresholdPct: threshold,
  });
  return (
    <div className="sales-panel">
      <div className="rp-settings rp-master-settings">
        <div className="field small sales-am">
          <span>Account manager</span>
          <ListLookup<UserSummary>
            list="users"
            value={amId}
            onChange={(u) => setAmId(u?.id ?? null)}
            labelOf={(u) => u.displayName}
            placeholder="All account managers"
          />
        </div>
        <label className="small">
          Country
          <input
            value={country}
            maxLength={2}
            placeholder="ISO, e.g. NG"
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
          />
        </label>
        <label className="small">
          Growth / decline threshold %
          <input
            type="number"
            min={0}
            max={1000}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </label>
        {q.isError && <span className="tone-error small">{problemText(q.error)}</span>}
      </div>
      {q.data && (
        <div className="sales-cards">
          <MoverList
            title="Top growing"
            rows={q.data.growing}
            ccy={ccy}
            tone="tone-good"
            empty="No client grew past the threshold."
          />
          <MoverList
            title="Top declining"
            rows={q.data.declining}
            ccy={ccy}
            tone="tone-error"
            empty="No client fell past the threshold."
          />
          <MoverList
            title="New clients"
            rows={q.data.newClients}
            ccy={ccy}
            tone="tone-good"
            empty="No first traffic in this period."
          />
          <MoverList
            title="Stopped sending"
            rows={q.data.stopped}
            ccy={ccy}
            tone="tone-error"
            empty="Every client of the previous period still sends."
          />
        </div>
      )}
    </div>
  );
}

export function SalesReportPage() {
  return (
    <ReportScreen page={page} title="Sales report" preset={PRESET} insights={(s) => <SalesPanel settings={s} />} />
  );
}
