// Charges Calculator (§7): usage charges for a period, for one enterprise or all of them
// (Select All), per side, in the trunk currency and the platform currency. Days are cut at
// midnight in each enterprise's billing time zone (§13.31).
import { useState } from "react";
import type { ChargesResult, Enterprise } from "@sms/contract";
import { calculateCharges } from "../../api/finance";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { ListLookup } from "../../records/parts";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { money, periodDays } from "./financeModel";

const page = pageForPath("/finance/charges")!;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function ChargesPage() {
  const today = new Date();
  const [enterpriseId, setEnterpriseId] = useState<number | null>(null);
  const [from, setFrom] = useState(ymd(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))));
  const [to, setTo] = useState(ymd(today));
  const [side, setSide] = useState<"all" | "customer" | "vendor">("all");
  const [result, setResult] = useState<ChargesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const go = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await calculateCharges({ enterpriseId, from, to }));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setRunning(false);
    }
  };
  const rows = (result?.rows ?? []).filter((r) => side === "all" || r.side === side);
  return (
    <div className="page charges-page">
      <PageHeader page={page} />
      <form
        className="charges-form"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div className="field">
          <span>Enterprise</span>
          <ListLookup<Enterprise>
            list="enterprises"
            value={enterpriseId}
            onChange={(e) => setEnterpriseId(e?.id ?? null)}
            labelOf={(e) => e.name}
            detailOf={(e) => `${e.alias} · ${e.type}`}
            placeholder="Select All"
          />
        </div>
        <label className="field">
          <span>Period From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>Period To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="field">
          <span>&nbsp;</span>
          <Button type="submit" variant="primary" icon="play" disabled={running || !from || !to}>
            {running ? "Calculating…" : "Go"}
          </Button>
        </div>
      </form>
      {error && <p className="error-text">{error}</p>}
      {result && (
        <div className="charges-result">
          <div className="charges-totals">
            <div>
              <span className="muted small">Period</span>
              <strong>
                {result.from} → {result.to}
              </strong>
              <span className="muted small">{periodDays(result.from, result.to)} days, billing time zones</span>
            </div>
            <div>
              <span className="muted small">Customer charges</span>
              <strong className="num">{money(result.totalPlatform.customer, result.platformCurrency)}</strong>
            </div>
            <div>
              <span className="muted small">Vendor charges</span>
              <strong className="num">{money(result.totalPlatform.vendor, result.platformCurrency)}</strong>
            </div>
            <div className="segmented small" role="radiogroup" aria-label="Side">
              {(["all", "customer", "vendor"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={side === s}
                  className={side === s ? "on" : ""}
                  onClick={() => setSide(s)}
                >
                  {s === "all" ? "Both sides" : s === "customer" ? "Customers" : "Vendors"}
                </button>
              ))}
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="muted">No traffic in the period.</p>
          ) : (
            <div className="charges-table">
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>Enterprise</th>
                    <th>Side</th>
                    <th>Time zone</th>
                    <th className="num">Messages</th>
                    <th className="num">Usage charges</th>
                    <th className="num">{result.platformCurrency}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.enterpriseId}:${r.side}:${r.currency}`}>
                      <td>{r.enterprise}</td>
                      <td>{r.side === "customer" ? "Customer" : "Vendor"}</td>
                      <td className="muted">{r.timezone}</td>
                      <td className="num">{r.messages.toLocaleString("en-US")}</td>
                      <td className="num">{money(r.amount, r.currency)}</td>
                      <td className="num">{money(r.amountPlatform)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
