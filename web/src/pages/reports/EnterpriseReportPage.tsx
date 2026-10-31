// Enterprise report (§10 /report/2, §13.31): the billing team's traffic report per customer or
// vendor enterprise. Settings (side, period, time zone, report by, grouping, filters) are run
// with "Run report"; the result is a standard grid with a filter under every column, server-side
// sort and paging, Column Selection for the 27 metrics, totals and CSV export. Day and month
// totals are cut at midnight in the partner's billing time zone by default (§13.31).
import { useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { EnterpriseReportPage, EnterpriseReportParams, Enterprise, ListQuery, ReportGroup } from "@sms/contract";
import { usePlatformCurrency, useReference } from "../../api/records";
import { exportEnterpriseReport, fetchEnterpriseReport, type ReportRow } from "../../api/reports";
import { encodeState, toListQuery } from "../../grid/filterModel";
import { pageForPath } from "../../nav/registry";
import { ListScreen, useGridUrlState } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Popover } from "../../ui/primitives";
import { DestinationPick, MultiPick, RefMulti, TrunkPick, type Picked } from "../routing/pickers";
import {
  columnsFor,
  decodeParams,
  defaultParams,
  DEFAULT_METRICS,
  encodeParams,
  KEY_FIELDS,
  quickPeriod,
} from "./reportModel";
import { metricQualityClass } from "../../ui/quality";
import { tzLabel } from "../../ui/timezones";
import { PeriodTabs, RangeChip } from "../../ui/DateRange";

const page = pageForPath("/reports/enterprise")!;

const GROUPS: { value: ReportGroup; label: string }[] = [
  { value: "enterprise", label: "Enterprise" },
  { value: "trunk", label: "Trunk" },
  { value: "country", label: "Country" },
  { value: "destination", label: "Destination" },
  { value: "account_manager", label: "Account manager" },
];

const QUICK = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last_7", label: "Last 7 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
] as const;

const fmtInt = (v: unknown) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US"));
const fmtMoney = (v: unknown, digits = 2) =>
  v === null || v === undefined
    ? "—"
    : Number(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtPct = (v: unknown) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(1)}%`);

const INT = [
  "attempts",
  "successful",
  "billableCustomer",
  "billableVendor",
  "submitted",
  "reportedCustomer",
  "reportedVendor",
  "hlrCached",
  "hlrLive",
  "hlrTotal",
  "hlrAccomplished",
  "hlrPorted",
];
const MONEY = ["revenue", "revenuePlatform", "cost", "costPlatform", "margin", "hlrCost", "hlrCostPlatform"];
const RATE = ["avgRateCustomer", "avgRateVendor", "costAvg"];
const PCT = ["asr", "dlrCustomer", "dlrVendor", "marginPct"];

function metricText(field: string, v: unknown): string {
  if (INT.includes(field)) return fmtInt(v);
  if (MONEY.includes(field)) return fmtMoney(v);
  if (RATE.includes(field)) return v === null || v === undefined ? "—" : Number(v).toFixed(6);
  if (PCT.includes(field)) return fmtPct(v);
  if (field === "deliveryDelayS") return v === null || v === undefined ? "—" : `${Number(v).toFixed(1)} s`;
  return v === null || v === undefined ? "—" : String(v);
}

/** ASR / DLR coloured by value (§13.4); other metrics get no class. */
const qualityOf = (field: string, v: unknown) =>
  metricQualityClass(field, v === null || v === undefined ? null : Number(v));

type Names = Record<string, Picked<number>[]>;

function Settings({
  draft,
  set,
  names,
  setNames,
  onRun,
  running,
}: {
  draft: EnterpriseReportParams;
  set: (patch: Partial<EnterpriseReportParams>) => void;
  names: Names;
  setNames: (k: string, v: Picked<number>[]) => void;
  onRun: () => void;
  running: boolean;
}) {
  const ref = useReference();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const groupBy = draft.groupBy ?? ["enterprise", "trunk"];
  const nFilters =
    [draft.enterpriseIds, draft.trunkIds, draft.mccmncs, draft.accountManagerIds].filter((x) => x?.length).length +
    (draft.msgType ? 1 : 0);
  const picked = (k: "enterpriseIds" | "trunkIds") =>
    (draft[k] ?? []).map((id) => names[k]?.find((p) => p.key === id) ?? { key: id, label: `#${id}` });
  const pick = (k: "enterpriseIds" | "trunkIds") => (v: Picked<number>[]) => {
    setNames(k, v);
    set({ [k]: v.map((p) => p.key) });
  };
  const platformTz = ref.data?.platformTimezone ?? "UTC";
  return (
    <div className="rp-settings">
      <div className="rp-row">
        <div className="segmented" role="radiogroup" aria-label="Enterprise type">
          {(["customer", "vendor"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={draft.side === s}
              className={draft.side === s ? "on" : ""}
              onClick={() => set({ side: s, trunkIds: [], enterpriseIds: [] })}
            >
              {s === "customer" ? "Customers" : "Vendors"}
            </button>
          ))}
        </div>
        {/* Period in the shared style (design refresh, team trial round 2). */}
        <PeriodTabs
          options={QUICK}
          value={
            QUICK.find((q) => {
              const p = quickPeriod(q.key);
              return p.from === draft.from && p.to === draft.to;
            })?.key ?? null
          }
          onPick={(k) => set(quickPeriod(k))}
        />
        <RangeChip withTime from={draft.from} to={draft.to} onChange={(from, to) => from && to && set({ from, to })} />
      </div>
      <div className="rp-row">
        <label className="toggle-inline" title="Day and month totals are cut at midnight in this zone">
          Time zone
          <select
            value={draft.timezone ?? "partner"}
            onChange={(e) => set({ timezone: e.target.value as EnterpriseReportParams["timezone"] })}
          >
            <option value="partner">Partner's billing time zone</option>
            <option value="utc">UTC</option>
            <option value="platform">Platform ({platformTz})</option>
          </select>
        </label>
        <label className="toggle-inline">
          Report by
          <select
            value={draft.reportBy ?? "daily"}
            onChange={(e) => set({ reportBy: e.target.value as EnterpriseReportParams["reportBy"] })}
          >
            <option value="none">Whole period</option>
            <option value="hourly">Hour</option>
            <option value="daily">Day</option>
            <option value="weekly">Week</option>
            <option value="monthly">Month</option>
          </select>
        </label>
        <span className="muted">Rows by</span>
        {GROUPS.map((g) => {
          const on = groupBy.includes(g.value);
          return (
            <button
              key={g.value}
              type="button"
              className={`chip${on ? " accent" : ""}`}
              aria-pressed={on}
              onClick={() => set({ groupBy: on ? groupBy.filter((x) => x !== g.value) : [...groupBy, g.value] })}
            >
              {g.label}
            </button>
          );
        })}
        <button
          ref={anchor}
          type="button"
          className={`btn btn-default${nFilters ? " has-value" : ""}`}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="filter" size={14} /> Filters{nFilters ? ` (${nFilters})` : ""}
        </button>
        <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} className="lk-filters-pop">
          <div className="rp-filters">
            <div className="field">
              <span>{draft.side === "customer" ? "Customers" : "Vendors"}</span>
              <MultiPick<Enterprise, number>
                list="enterprises"
                fixed={[
                  {
                    field: "type",
                    op: "in",
                    values: draft.side === "customer" ? ["customer", "reciprocal"] : ["vendor", "reciprocal"],
                  },
                ]}
                value={picked("enterpriseIds")}
                onChange={pick("enterpriseIds")}
                toPicked={(e) => ({ key: e.id, label: e.name })}
                detailOf={(e) => e.alias}
                placeholder="Search enterprises…"
              />
            </div>
            <div className="field">
              <span>Trunks</span>
              <TrunkPick kind={draft.side} value={picked("trunkIds")} onChange={pick("trunkIds")} />
            </div>
            <div className="field">
              <span>Destinations</span>
              <DestinationPick value={draft.mccmncs ?? []} onChange={(mccmncs) => set({ mccmncs })} />
            </div>
            <div className="field">
              <span>Account managers (at send time)</span>
              <RefMulti
                options={(ref.data?.accountManagers ?? []).map((u) => ({ value: u.id, label: u.displayName }))}
                value={draft.accountManagerIds ?? []}
                onChange={(accountManagerIds) => set({ accountManagerIds })}
                placeholder="Find an account manager…"
              />
            </div>
            <label className="field">
              <span>Type</span>
              <select
                value={draft.msgType ?? ""}
                onChange={(e) => set({ msgType: (e.target.value || null) as EnterpriseReportParams["msgType"] })}
              >
                <option value="">MT and MO</option>
                <option value="MT">MT</option>
                <option value="MO">MO</option>
              </select>
            </label>
          </div>
        </Popover>
        <span className="fb-spacer" />
        <Button variant="primary" icon="play" onClick={onRun} disabled={running}>
          Run report
        </Button>
      </div>
    </div>
  );
}

function Totals({ data, visible, ccy }: { data: EnterpriseReportPage | null; visible: string[]; ccy: string }) {
  if (!data) return null;
  if (!data.available) return <p className="muted small">The EDR store is not answering; the report is empty.</p>;
  const metrics = visible.filter((f) => !KEY_FIELDS.has(f));
  const t = data.totals as unknown as Record<string, unknown>;
  const zones = data.timezones;
  return (
    <div className="rp-totals">
      <span className="rp-total-label">Total</span>
      {metrics.map((m) => (
        <span key={m} className="rp-total">
          <span className="muted small">{labelOf(m, ccy)}</span>
          <span
            className={`num strong${m === "margin" && Number(t[m]) < 0 ? " tone-error" : ""} ${qualityOf(m, t[m])}`}
            title={t[m] === null && PARTNER_MONEY.has(m) ? "Rows are in several currencies; see each row" : undefined}
          >
            {metricText(m, t[m])}
          </span>
        </span>
      ))}
      <span className="fb-spacer" />
      <span
        className="muted small"
        title={zones.map((z) => `${tzLabel(z.timezone)}: ${z.enterprises} enterprises`).join("\n")}
      >
        Cut in {zones.length === 1 ? tzLabel(zones[0]!.timezone) : `${zones.length} time zones`}
      </span>
    </div>
  );
}

const LABELS: Record<string, string> = {
  attempts: "Attempts",
  successful: "Successful",
  billableCustomer: "Billable (C)",
  billableVendor: "Billable (V)",
  submitted: "Submitted",
  asr: "ASR",
  dlrCustomer: "DLR (C)",
  dlrVendor: "DLR (V)",
  revenue: "Revenue",
  revenuePlatform: "Revenue",
  cost: "Cost",
  costPlatform: "Cost",
  margin: "Margin",
  marginPct: "Margin %",
  avgRateCustomer: "Avg rate (C)",
  avgRateVendor: "Avg rate (V)",
  costAvg: "Cost avg",
  reportedCustomer: "Reported (C)",
  reportedVendor: "Reported (V)",
  deliveryDelayS: "Delay",
  hlrCached: "HLR cached",
  hlrLive: "HLR live",
  hlrTotal: "HLR",
  hlrAccomplished: "HLR done",
  hlrPorted: "Ported",
  hlrCost: "HLR cost",
  hlrCostPlatform: "HLR cost",
};
const PARTNER_MONEY = new Set(["revenue", "cost", "hlrCost", "avgRateCustomer", "avgRateVendor"]);
const PLATFORM_MONEY = new Set(["revenuePlatform", "costPlatform", "margin", "costAvg", "hlrCostPlatform"]);
const labelOf = (m: string, ccy?: string) => `${LABELS[m] ?? m}${ccy && PLATFORM_MONEY.has(m) ? ` (${ccy})` : ""}`;

export function EnterpriseReportPage() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const ccy = usePlatformCurrency();
  const [grid] = useGridUrlState();
  const params = new URLSearchParams(location.search);
  const applied = decodeParams(params.get("r"));
  const [draft, setDraft] = useState<EnterpriseReportParams>(applied ?? defaultParams());
  const [names, setNamesState] = useState<Names>({});
  const [result, setResult] = useState<EnterpriseReportPage | null>(null);
  const set = (patch: Partial<EnterpriseReportParams>) => setDraft((d) => ({ ...d, ...patch }));

  const visible = grid.visible ?? columnsFor(applied ?? draft, DEFAULT_METRICS[(applied ?? draft).side]);

  const run = () => {
    if (draft.to <= draft.from) return toast({ tone: "error", message: "The end must be after the start." });
    const prev = applied;
    const metrics = (grid.visible ?? []).filter((f) => !KEY_FIELDS.has(f));
    const keepMetrics = prev && prev.side === draft.side && metrics.length ? metrics : DEFAULT_METRICS[draft.side];
    const p = new URLSearchParams(location.search);
    p.set("r", encodeParams(draft));
    // Columns follow the new grouping; the chosen metrics stay. Filters on keys that are gone are dropped.
    const columns = columnsFor(draft, keepMetrics);
    const keptFilters = Object.fromEntries(
      Object.entries(grid.columns).filter(([f]) => columns.includes(f) || !KEY_FIELDS.has(f)),
    );
    const g = encodeState({ ...grid, visible: columns, columns: keptFilters, viewId: null });
    if (g) p.set("g", g);
    else p.delete("g");
    navigate(`${location.pathname}?${p.toString()}`, { replace: true });
  };

  const fetchPage = useMemo(
    () => async (body: ListQuery) => {
      const page = await fetchEnterpriseReport(applied!, body);
      if (!body.cursor) setResult(page);
      return page;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.get("r")],
  );

  const columns = useMemo(() => {
    const out: Record<
      string,
      { width?: number; align?: "left" | "right"; render?: (r: ReportRow) => React.ReactNode; label?: string }
    > = {
      period: { width: 130 },
      enterpriseName: { width: 220 },
      trunkName: { width: 180 },
      country: { width: 150 },
      mccmnc: { width: 90 },
      network: { width: 180 },
      accountManagerName: { width: 160 },
      currency: { width: 80 },
      timezone: { width: 150 },
    };
    for (const m of Object.keys(LABELS)) {
      const platform = PLATFORM_MONEY.has(m);
      out[m] = {
        width: MONEY.includes(m) || RATE.includes(m) ? 130 : 118,
        align: "right",
        ...(platform ? { label: labelOf(m, ccy) } : {}),
        render: (r: ReportRow) => {
          const v = (r as unknown as Record<string, unknown>)[m];
          return (
            <span className={m === "margin" && Number(v) < 0 ? "tone-error strong" : qualityOf(m, v)}>
              {metricText(m, v)}
            </span>
          );
        },
      };
    }
    return out;
  }, [ccy]);

  return (
    <ListScreen<ReportRow>
      list="enterprise_report"
      page={page}
      title="Enterprise report"
      noSelection
      enabled={applied !== null}
      idleMessage="Choose customers or vendors, the period and the rows, then press Run report."
      queryScope={params.get("r")}
      fetchPage={applied ? fetchPage : undefined}
      initialState={{ visible }}
      columns={columns}
      onExport={(state) =>
        applied
          ? void exportEnterpriseReport(applied, toListQuery(state) as ListQuery, state.visible ?? visible).catch((e) =>
              toast({ tone: "error", message: (e as Error).message }),
            )
          : toast({ tone: "info", message: "Run the report first." })
      }
      above={
        <>
          <Settings
            draft={draft}
            set={set}
            names={names}
            setNames={(k, v) => setNamesState((n) => ({ ...n, [k]: v }))}
            onRun={run}
            running={false}
          />
          {applied && <Totals data={result} visible={visible} ccy={ccy} />}
        </>
      }
      shortcuts="Run report applies the settings"
    />
  );
}
