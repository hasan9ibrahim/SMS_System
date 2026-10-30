// Route map (§6.3): for one customer trunk, which rule and vendor each destination it sells
// gets today, with sell rate, vendor cost and margin. The trunk is in the tab URL (?trunk=);
// the grid is the standard server-side list, so every column filters and sorts, including the
// routed vendor and the margin. Rows link to the deciding route rule.
import { useLocation } from "react-router";
import type { ListQuery, RouteMapRow, TrunkListRow } from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import { downloadCsv } from "../../api/masterData";
import { usePlatformCurrency } from "../../api/records";
import { emptyState, encodeState, toListQuery } from "../../grid/filterModel";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ListLookup } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { toast } from "../../ui/feedback";
import { problemText } from "./dialogs";

const page = pageForPath("/routing/map")!;

const STATUS: Record<RouteMapRow["status"], { label: string; tone: string; help: string }> = {
  routed: { label: "Routed", tone: "good", help: "A rule picks a vendor" },
  blocked: { label: "Blocked", tone: "muted", help: "A block rule matches" },
  no_vendor: { label: "No vendor", tone: "warning", help: "Rules match but no vendor qualifies (rate, margin, scope)" },
  no_rule: { label: "No rule", tone: "error", help: "No route rule matches: messages would fail" },
};
const TYPE: Record<string, string> = { static: "Static", dynamic: "Least cost", qbr: "Quality", block: "Block" };
const rate = (v: number | null) => (v === null ? "—" : v.toFixed(6));

/** Opens the route rules page filtered to one rule, in this tab (Back returns here, team trial round 12). */
export function useOpenRule() {
  const navigate = useTabNavigate();
  return (id: number, name: string) =>
    navigate(
      `/routing/rules?g=${encodeState({ ...emptyState(), columns: { id: { field: "id", op: "eq", value: id } } })}`,
      { title: `Rule · ${name}` },
    );
}

export function RouteMapPage() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const currency = usePlatformCurrency();
  const openRule = useOpenRule();
  const params = new URLSearchParams(location.search);
  const trunk = params.get("trunk") ? Number(params.get("trunk")) : null;
  const setTrunk = (t: TrunkListRow | null) => {
    const p = new URLSearchParams(location.search);
    if (t) p.set("trunk", String(t.id));
    else p.delete("trunk");
    navigate(`/routing/map${p.size ? `?${p}` : ""}`, { replace: true, title: t ? `Route map · ${t.name}` : undefined });
  };
  const withTrunk = (body: ListQuery): ListQuery => ({
    ...body,
    filter: {
      logic: "and",
      conditions: [{ field: "customerTrunkId", op: "eq", value: trunk! }, ...(body.filter ? [body.filter] : [])],
    },
  });
  return (
    <ListScreen<RouteMapRow>
      list="route_map"
      page={page}
      noSelection
      enabled={trunk !== null}
      idleMessage="Choose a customer trunk above to see its route for every destination."
      queryScope={trunk}
      fetchPage={(body) => fetchListPage<RouteMapRow>("route_map", withTrunk(body))}
      // Read-only: the one record action is the deciding rule, like the Rule link (§6.3).
      rowActions={(r) => [
        {
          label: "Show rule",
          icon: "route",
          main: true,
          disabled: !r.ruleId,
          hint: r.ruleId ? undefined : "No rule routes this destination",
          onSelect: () => r.ruleId && openRule(r.ruleId, r.ruleName!),
        },
      ]}
      above={
        <div className="rm-trunk">
          <span className="muted">Customer trunk</span>
          <div className="rm-pick">
            <ListLookup<TrunkListRow>
              list="customer_trunks"
              value={trunk}
              onChange={setTrunk}
              labelOf={(t) => t.name}
              detailOf={(t) => `${t.enterpriseName}${t.category ? ` · ${t.category}` : ""}`}
              placeholder="Choose a customer trunk…"
            />
          </div>
        </div>
      }
      onExport={
        trunk === null
          ? undefined
          : (s) =>
              void downloadCsv(
                "/route-map/export",
                withTrunk({ ...toListQuery(s), limit: 100, withTotal: false }),
              ).catch((e) => toast({ tone: "error", message: problemText(e) }))
      }
      columns={{
        country: { width: 170 },
        network: {
          width: 200,
          render: (r) => (r.allNetworks ? <span className="muted">All networks</span> : r.network),
        },
        mccmnc: { width: 90, render: (r) => <span className="num">{r.mccmnc}</span> },
        sellRate: {
          width: 120,
          align: "right",
          render: (r) => (
            <span className="num" title={r.rateTableName}>
              {r.sellRate.toFixed(6)} {r.sellCurrency}
            </span>
          ),
        },
        sellRateConverted: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{rate(r.sellRateConverted)}</span>,
        },
        status: {
          width: 110,
          render: (r) => (
            <span className={`rm-status tone-${STATUS[r.status].tone}`} title={STATUS[r.status].help}>
              <span className="dot" /> {STATUS[r.status].label}
            </span>
          ),
        },
        ruleName: {
          width: 200,
          render: (r) =>
            r.ruleId ? (
              <button
                type="button"
                className="link"
                onClick={(e) => {
                  e.stopPropagation();
                  openRule(r.ruleId!, r.ruleName!);
                }}
              >
                {r.ruleName}
              </button>
            ) : (
              <span className="muted">—</span>
            ),
        },
        routeType: { width: 100, render: (r) => (r.routeType ? TYPE[r.routeType] : "") },
        vendor: { width: 300, render: (r) => <VendorSetup row={r} /> },
        vendorCost: { width: 110, align: "right", render: (r) => <span className="num">{rate(r.vendorCost)}</span> },
        margin: {
          width: 100,
          align: "right",
          render: (r) => (
            <span className={`num${r.margin !== null && r.margin < 0 ? " tone-error" : ""}`}>{rate(r.margin)}</span>
          ),
        },
        marginPct: {
          width: 90,
          align: "right",
          render: (r) => (
            <span className={`num${r.marginPct !== null && r.marginPct < 0 ? " tone-error" : ""}`}>
              {r.marginPct === null ? "—" : `${r.marginPct.toFixed(1)}%`}
            </span>
          ),
        },
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.country} · {r.network}
            </strong>
            <span className="num muted">{r.mccmnc}</span>
          </>
        ),
        sections: [
          {
            key: "route",
            label: "Route",
            content: (
              <dl className="kv">
                <dt>Sell rate</dt>
                <dd>
                  {r.sellRate.toFixed(6)} {r.sellCurrency} ({rate(r.sellRateConverted)} {currency}) · {r.rateTableName}
                </dd>
                <dt>Route</dt>
                <dd className={`tone-${STATUS[r.status].tone}`}>{STATUS[r.status].help}</dd>
                <dt>Rule</dt>
                <dd>
                  {r.ruleId ? (
                    <button type="button" className="link" onClick={() => openRule(r.ruleId!, r.ruleName!)}>
                      {r.ruleName} (priority {r.rulePriority}, {r.routeType ? TYPE[r.routeType] : ""})
                    </button>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt>Vendor</dt>
                <dd>{r.vendor ? `${r.vendor} · decided by ${r.decidedBy}` : "—"}</dd>
                <dt>Cost / margin</dt>
                <dd>
                  {rate(r.vendorCost)} / {rate(r.margin)} {currency}
                  {r.marginPct !== null && ` (${r.marginPct.toFixed(1)}%)`}
                </dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · click a rule to open it · the trunk stays in the tab URL"
    />
  );
}

/**
 * The rule's vendors as configured (team trial round 8), compact: each level in order ("›" to the next), every vendor
 * with its share, backups marked ↺, the one routed now in bold. Least cost and quality rules show the vendor picked.
 */
function VendorSetup({ row }: { row: RouteMapRow }) {
  if (!row.vendorSetup.length) {
    if (!row.vendor) return <span className="muted">—</span>;
    const how = row.routeType === "dynamic" ? "least cost" : row.routeType === "qbr" ? "quality" : null;
    return (
      <span>
        <strong>{row.vendor}</strong>
        {how && <span className="muted small"> · {how}</span>}
      </span>
    );
  }
  const levels = [...new Set(row.vendorSetup.map((v) => v.level))].sort((a, b) => a - b);
  const text = (v: RouteMapRow["vendorSetup"][number]) =>
    `${v.backup ? "↺ " : ""}${v.name}${v.sharePct !== null ? ` ${v.sharePct}%` : ""}`;
  const title = levels
    .map((l) => `Level ${l}: ${row.vendorSetup.filter((v) => v.level === l).map(text).join(", ")}`)
    .join("\n");
  return (
    <span className="rm-setup" title={title}>
      {levels.map((l, i) => (
        <span key={l}>
          {i > 0 && <span className="muted"> › </span>}
          {row.vendorSetup
            .filter((v) => v.level === l)
            .map((v, j) => (
              <span key={`${v.vendorTrunkId}-${v.backup}`}>
                {j > 0 && <span className="muted"> · </span>}
                {v.vendorTrunkId === row.vendorTrunkId ? <strong>{text(v)}</strong> : text(v)}
              </span>
            ))}
        </span>
      ))}
    </span>
  );
}
