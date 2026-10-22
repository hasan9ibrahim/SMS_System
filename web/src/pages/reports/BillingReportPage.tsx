// Billing report (§13.15): is everything billed correctly and paid? Per enterprise for the period:
// billable volume and amount on each side, invoices issued, payments, today's balance and credit use,
// disputed vendor invoices and their differences, negative-margin traffic and re-rating effects.
// Server-side filters, sort and paging; each row links to the finance pages.
import { useLocation } from "react-router";
import type { BillingReportParams, BillingReportRow, ReportPeriod } from "@sms/contract";
import { fetchBillingReport } from "../../api/masterReports";
import { usePlatformCurrency } from "../../api/records";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { Button } from "../../ui/primitives";
import { PERIODS } from "./masterModel";
import { PeriodTabs, RangeChip } from "../../ui/DateRange";

const page = pageForPath("/reports/billing")!;
const money = (v: number | null) =>
  v === null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (v: number) => v.toLocaleString("en-US");
const muted = (v: string) => <span className="muted">{v}</span>;

function useParams(): [BillingReportParams, (p: BillingReportParams) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const q = new URLSearchParams(location.search);
  const params: BillingReportParams = {
    period: (q.get("period") as ReportPeriod) ?? "last_month",
    from: q.get("from"),
    to: q.get("to"),
  };
  return [
    params,
    (p) => {
      const n = new URLSearchParams(location.search);
      n.set("period", p.period);
      for (const k of ["from", "to"] as const) {
        if (p[k]) n.set(k, p[k]!);
        else n.delete(k);
      }
      navigate(`${location.pathname}?${n.toString()}`, { replace: true });
    },
  ];
}

export function BillingReportPage() {
  const [params, setParams] = useParams();
  const navigate = useTabNavigate();
  const ccy = usePlatformCurrency();
  const ready = params.period !== "custom" || (!!params.from && !!params.to);
  return (
    <ListScreen<BillingReportRow>
      list="billing_report"
      page={page}
      title="Billing report"
      noSelection
      historyScope={null}
      rowActions={(r) => [
        { label: "SOA", icon: "mail", main: true, onSelect: () => navigate(`/finance/soa?enterprises=${r.id}`) },
        { label: "Billing settings", icon: "file", onSelect: () => navigate(`/enterprises/${r.id}?tab=billing`) },
      ]}
      queryScope={params}
      enabled={ready}
      idleMessage="Choose the From and To dates of the custom period."
      fetchPage={(body) => fetchBillingReport(params, body)}
      above={
        <div className="rp-settings rp-master-settings">
          {/* Period in the shared style (design refresh, team trial round 2); the range chip sets a custom period. */}
          <PeriodTabs
            options={PERIODS.filter((p) => p.value !== "custom").map((p) => ({ key: p.value, label: p.label }))}
            value={params.period === "custom" ? null : params.period}
            onPick={(period) => setParams({ ...params, period, from: null, to: null })}
          />
          <RangeChip
            from={params.period === "custom" ? (params.from?.slice(0, 10) ?? "") : ""}
            to={params.period === "custom" ? (params.to?.slice(0, 10) ?? "") : ""}
            empty="Custom period"
            suffix={params.period === "custom" ? "(To not included)" : undefined}
            onChange={(from, to) =>
              setParams({
                ...params,
                period: "custom",
                from: from ? `${from}T00:00:00.000Z` : null,
                to: to ? `${to}T00:00:00.000Z` : null,
              })
            }
          />
          <span className="muted small">
            Amounts in each enterprise's billing currency; negative margin in {ccy}. Balance and credit use are as of
            today.
          </span>
        </div>
      }
      columns={{
        enterprise: { width: 230, render: (r) => <strong>{r.enterprise}</strong> },
        type: { width: 100 },
        accountManager: { width: 150, render: (r) => r.accountManager ?? muted("—") },
        billingCycle: { width: 150, render: (r) => r.billingCycle ?? muted("—") },
        currency: { width: 80 },
        customerBillable: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{int(r.customerBillable)}</span>,
        },
        customerAmount: {
          width: 120,
          align: "right",
          render: (r) => <span className="num">{money(r.customerAmount)}</span>,
        },
        vendorBillable: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{int(r.vendorBillable)}</span>,
        },
        vendorAmount: {
          width: 120,
          align: "right",
          render: (r) => <span className="num">{money(r.vendorAmount)}</span>,
        },
        invoicesIssued: { width: 90, align: "right", render: (r) => <span className="num">{r.invoicesIssued}</span> },
        invoicedAmount: {
          width: 120,
          align: "right",
          render: (r) => <span className="num">{money(r.invoicedAmount)}</span>,
        },
        paymentsReceived: {
          width: 120,
          align: "right",
          render: (r) => <span className="num">{money(r.paymentsReceived)}</span>,
        },
        paymentsMade: {
          width: 120,
          align: "right",
          render: (r) => <span className="num">{money(r.paymentsMade)}</span>,
        },
        balance: {
          width: 120,
          align: "right",
          render: (r) => <span className={`num${(r.balance ?? 0) < 0 ? " tone-error" : ""}`}>{money(r.balance)}</span>,
        },
        creditUsePct: {
          width: 110,
          align: "right",
          render: (r) =>
            r.creditUsePct === null ? (
              muted("—")
            ) : (
              <span
                className={`num${r.creditUsePct >= 90 ? " tone-error" : r.creditUsePct >= 70 ? " tone-warning" : ""}`}
              >
                {r.creditUsePct.toFixed(1)}%
              </span>
            ),
        },
        disputedInvoices: {
          width: 90,
          align: "right",
          render: (r) =>
            r.disputedInvoices ? <span className="num tone-warning">{r.disputedInvoices}</span> : muted("0"),
        },
        vendorInvoiceDifference: {
          width: 140,
          align: "right",
          render: (r) => (
            <span className={`num${r.vendorInvoiceDifference ? " tone-warning" : ""}`}>
              {money(r.vendorInvoiceDifference)}
            </span>
          ),
        },
        negativeMarginMessages: {
          width: 140,
          align: "right",
          render: (r) =>
            r.negativeMarginMessages ? (
              <span className="num tone-error">{int(r.negativeMarginMessages)}</span>
            ) : (
              muted("0")
            ),
        },
        negativeMarginAmount: {
          width: 130,
          align: "right",
          render: (r) => (
            <span className={`num${r.negativeMarginAmount ? " tone-error" : ""}`}>{money(r.negativeMarginAmount)}</span>
          ),
        },
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.enterprise}</strong>
            <span className="muted">
              {r.type} · {r.currency} · {r.billingCycle ?? "no billing cycle"}
            </span>
          </>
        ),
        sections: [
          {
            key: "billing",
            label: "Billing",
            actions: (
              <>
                <Button small onClick={() => navigate(`/finance/soa?enterprises=${r.id}`)}>
                  SOA
                </Button>
                <Button small onClick={() => navigate(`/enterprises/${r.id}?tab=billing`)}>
                  Enterprise
                </Button>
              </>
            ),
            content: (
              <dl className="kv">
                <dt>Customer side</dt>
                <dd>
                  {int(r.customerBillable)} billable · {money(r.customerAmount)} {r.currency}
                </dd>
                <dt>Vendor side</dt>
                <dd>
                  {int(r.vendorBillable)} billable · {money(r.vendorAmount)} {r.currency}
                </dd>
                <dt>Invoiced</dt>
                <dd>
                  {r.invoicesIssued} invoice{r.invoicesIssued === 1 ? "" : "s"} · {money(r.invoicedAmount)}
                </dd>
                <dt>Payments</dt>
                <dd>
                  in {money(r.paymentsReceived)} · out {money(r.paymentsMade)}
                </dd>
                <dt>Balance today</dt>
                <dd>
                  {money(r.balance)}
                  {r.creditLimit !== null && ` · credit limit ${money(r.creditLimit)} (${r.creditUsePct ?? 0}% used)`}
                </dd>
                <dt>Disputes</dt>
                <dd>
                  {r.disputedInvoices} disputed vendor invoice{r.disputedInvoices === 1 ? "" : "s"} · difference{" "}
                  {money(r.vendorInvoiceDifference)}
                </dd>
                <dt>Negative margin</dt>
                <dd>
                  {int(r.negativeMarginMessages)} messages · {money(r.negativeMarginAmount)} {ccy} lost
                </dd>
                <dt>Re-rated</dt>
                <dd>{money(r.reratedAmount)}</dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="Filters under each column (e.g. Balance < 0, Credit Used % ≥ 90) · click a row for the finance links"
    />
  );
}
