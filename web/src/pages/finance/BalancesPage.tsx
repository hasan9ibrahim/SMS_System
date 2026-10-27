// Enterprise Balance (§7): customer, vendor and net balance (customer − vendor) per enterprise,
// positive = the partner's credit, negative = owed (decided 2026-10-17), with account manager,
// customer credit and use, billing cycle and currency. Server-side filters and sort; CSV export.
// Send SOA opens the SOA screen for the enterprise (§7, build step 5.7).
import type { EnterpriseBalanceRow } from "@sms/contract";
import { downloadCsv } from "../../api/masterData";
import { toListQuery } from "../../grid/filterModel";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { balanceWords, money6 as money, netWords } from "./financeModel";
import { soaLink } from "./soaModel";

const page = pageForPath("/finance/balances")!;
const muted = (v: string) => <span className="muted">{v}</span>;

/** Credit use: red at the limit, amber from 80 % (§7 Notice/Warning/Critical). */
const creditTone = (pct: number | null) =>
  pct === null ? "" : pct >= 100 ? "tone-error" : pct >= 80 ? "tone-warning" : "";

export function BalancesPage() {
  const navigate = useTabNavigate();
  return (
    <ListScreen<EnterpriseBalanceRow>
      list="enterprise_balances"
      page={page}
      noSelection
      historyScope={null}
      rowActions={(r) => [
        { label: "Send SOA", icon: "mail", main: true, onSelect: () => navigate(soaLink([r.id])) },
        { label: "Billing settings", icon: "file", onSelect: () => navigate(`/enterprises/${r.id}?tab=billing`) },
        {
          label: "Transactions",
          icon: "wallet",
          hint: "Filter Name on the Transactions page for this enterprise",
          onSelect: () => navigate(`/finance/transactions`),
        },
      ]}
      above={
        <div className="rm-trunk">
          <span className="muted small">
            Balance = opening + payments − usage: positive = the partner&apos;s credit, negative = owed (red; positive green). Net =
            customer − vendor in the customer currency. Payments left off the SOA still count (§13.33).
          </span>
        </div>
      }
      onExport={(s) =>
        void downloadCsv("/enterprise-balances/export", toListQuery(s)).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        enterprise: { width: 240, render: (r) => <strong>{r.enterprise}</strong> },
        customerBalance: {
          width: 160,
          align: "right",
          render: (r) =>
            r.customerBalance === null ? (
              muted("—")
            ) : (
              <span
                className={`num ${balanceWords(r.customerBalance, "customer").tone}`}
                title={balanceWords(r.customerBalance, "customer").text}
              >
                {money(r.customerBalance, r.customerCurrency)}
              </span>
            ),
        },
        vendorBalance: {
          width: 160,
          align: "right",
          render: (r) =>
            r.vendorBalance === null ? (
              muted("—")
            ) : (
              <span
                className={`num ${balanceWords(r.vendorBalance, "vendor").tone}`}
                title={balanceWords(r.vendorBalance, "vendor").text}
              >
                {money(r.vendorBalance, r.vendorCurrency)}
              </span>
            ),
        },
        netBalance: {
          width: 160,
          align: "right",
          render: (r) => (
            <strong className={`num ${(r.netBalance ?? 0) < 0 ? "tone-error" : (r.netBalance ?? 0) > 0 ? "tone-good" : ""}`} title={netWords(r.netBalance)}>
              {money(r.netBalance, r.currency)}
            </strong>
          ),
        },
        accountManager: { width: 170, render: (r) => r.accountManager ?? muted("—") },
        billingType: {
          width: 100,
          render: (r) => (r.billingType ? (r.billingType === "prepaid" ? "Prepaid" : "Postpaid") : muted("—")),
        },
        creditLimit: {
          width: 140,
          align: "right",
          render: (r) =>
            r.creditLimit === null ? (
              muted("—")
            ) : (
              <span className="num">{money(r.creditLimit, r.customerCurrency)}</span>
            ),
        },
        creditUsedPct: {
          width: 110,
          align: "right",
          render: (r) =>
            r.creditUsedPct === null ? (
              muted("—")
            ) : (
              <span className={`num ${creditTone(r.creditUsedPct)}`}>{r.creditUsedPct.toFixed(1)} %</span>
            ),
        },
        billingCycle: { width: 170, render: (r) => r.billingCycle ?? muted("—") },
        currency: { width: 80 },
      }}
      onOpen={(r) => navigate(`/enterprises/${r.id}?tab=billing`)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.enterprise}</strong>
            <span className="muted">
              net {money(r.netBalance, r.currency)} · {r.enterpriseType}
            </span>
          </>
        ),
        sections: [
          {
            key: "balance",
            label: "Balance",
            actions: (
              <>
                <Button small icon="mail" onClick={() => navigate(soaLink([r.id]))}>
                  Send SOA
                </Button>
                <Button small icon="file" onClick={() => navigate(`/enterprises/${r.id}?tab=billing`)}>
                  Billing settings
                </Button>
                <Button
                  small
                  icon="wallet"
                  onClick={() => navigate(`/finance/transactions`)}
                  title="Filter Name on the Transactions page for this enterprise"
                >
                  Transactions
                </Button>
              </>
            ),
            content: (
              <dl className="kv">
                <dt>Customer</dt>
                <dd>
                  {r.customerBalance === null
                    ? "no customer billing"
                    : `${money(r.customerBalance, r.customerCurrency)} · ${balanceWords(r.customerBalance, "customer").text}`}
                  {r.creditLimit !== null && (
                    <span className="muted small">
                      {" "}
                      · credit {money(r.creditLimit, r.customerCurrency)}
                      {r.creditUsedPct !== null ? ` (${r.creditUsedPct.toFixed(1)} % used)` : ""}
                    </span>
                  )}
                </dd>
                <dt>Vendor</dt>
                <dd>
                  {r.vendorBalance === null
                    ? "no vendor billing"
                    : `${money(r.vendorBalance, r.vendorCurrency)} · ${balanceWords(r.vendorBalance, "vendor").text}`}
                </dd>
                <dt>Net</dt>
                <dd>
                  <strong>{money(r.netBalance, r.currency)}</strong> · {netWords(r.netBalance)}
                  {r.vendorCurrency && r.customerCurrency && r.vendorCurrency !== r.customerCurrency && (
                    <span className="muted small"> · vendor side converted at today&apos;s rate</span>
                  )}
                </dd>
                <dt>Account manager</dt>
                <dd>{r.accountManager ?? "—"}</dd>
                <dt>Billing cycle</dt>
                <dd>{r.billingCycle ?? "—"}</dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter opens the enterprise's billing settings"
    />
  );
}
