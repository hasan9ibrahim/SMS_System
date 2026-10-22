// The Master Report screen (§13.15), shared by the Master, Sales and NOC reports: settings (period,
// time zone, MO / MT, compare), group-by fields in order (up to 5) and metrics, then a standard grid
// whose columns are the group-by fields and metrics, with a filter under every column (field
// conditions before grouping, metric thresholds after), server-side sort and paging, totals with
// the change against the previous period, a chart, drill-down, the EDRs behind a row, export, and
// saved report views (settings included) that scheduled reports can e-mail.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type {
  FieldDescriptor,
  ListQuery,
  MasterReportPage,
  MasterReportSettings,
  ReportDimension,
  ReportMetric,
} from "@sms/contract";
import { useListFields, useSaveView, useViews, type ListPage } from "../../api/hooks";
import { exportMasterReport, runMasterReport } from "../../api/masterReports";
import { buildFilter, encodeState, toListQuery, type GridState } from "../../grid/filterModel";
import type { PageDef } from "../../nav/registry";
import { ListScreen, useGridUrlState } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { Chart, useChartColors } from "../../ui/Chart";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, Popover } from "../../ui/primitives";
import { metricQualityClass } from "../../ui/quality";
import { problemText } from "../routing/dialogs";
import {
  decodeSettings,
  defaultSettings,
  deltaPct,
  DIMENSIONS,
  drillConditions,
  edrSearchPath,
  encodeSettings,
  flatten,
  fmtMetric,
  isDimension,
  LOWER_IS_BETTER,
  PERIODS,
  periodWindow,
  splitVisible,
  TIMEZONES,
  visibleOf,
  type FlatRow,
  type Settings,
} from "./masterModel";
import { HoursChip, PeriodTabs, RangeChip } from "../../ui/DateRange";

const toLocal = (iso: string | null | undefined) => (iso ? iso.slice(0, 16) : "");
const fromLocal = (v: string) => (v ? `${v}:00.000Z` : null);
const fmtWindow = (from: string, to: string) =>
  `${from.slice(0, 16).replace("T", " ")} → ${to.slice(0, 16).replace("T", " ")} UTC`;

function Delta({
  metric,
  cur,
  prev,
}: {
  metric: string;
  cur: number | null | undefined;
  prev: number | null | undefined;
}) {
  const d = deltaPct(cur, prev);
  if (d === null) return null;
  const up = d > 0;
  const bad = LOWER_IS_BETTER.has(metric) ? up : !up;
  return (
    <span
      className={`rp-delta ${d === 0 ? "" : bad ? "tone-error" : "tone-good"}`}
      title={`Previous: ${fmtMetric(metric, prev)}`}
    >
      {d === 0 ? "=" : up ? "▲" : "▼"} {Math.abs(d).toFixed(1)}%
    </span>
  );
}

function MetricsPicker({
  fields,
  value,
  onChange,
}: {
  fields: FieldDescriptor[];
  value: ReportMetric[];
  onChange: (v: ReportMetric[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ReportMetric[]>(value);
  const ref = useRef<HTMLButtonElement>(null);
  const metrics = fields.filter((f) => !isDimension(f.field));
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn-sm"
        onClick={() => {
          setDraft(value);
          setOpen((v) => !v);
        }}
      >
        Column Selection ({value.length})
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="choice-pop rp-metrics-pop">
        <div className="rp-metrics">
          {metrics.map((f) => (
            <label key={f.field} className="choice-row">
              <input
                type="checkbox"
                checked={draft.includes(f.field as ReportMetric)}
                onChange={(e) =>
                  setDraft(
                    e.target.checked
                      ? metrics.map((m) => m.field as ReportMetric).filter((m) => m === f.field || draft.includes(m))
                      : draft.filter((m) => m !== f.field),
                  )
                }
              />
              {f.label}
            </label>
          ))}
        </div>
        <div className="rp-pop-actions">
          <Button small onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            small
            variant="primary"
            disabled={!draft.length}
            onClick={() => {
              onChange(draft);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </Popover>
    </>
  );
}

function GroupBy({
  labels,
  value,
  onChange,
}: {
  labels: Map<string, string>;
  value: ReportDimension[];
  onChange: (v: ReportDimension[]) => void;
}) {
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="rp-groupby" aria-label="Group by">
      <span className="muted small">Group by</span>
      {value.map((d, i) => (
        <span key={d} className="chip rp-chip">
          <span className="muted small">{i + 1}</span> {labels.get(d) ?? d}
          {i > 0 && (
            <button type="button" className="link small" aria-label="Move left" onClick={() => move(i, -1)}>
              ‹
            </button>
          )}
          {i < value.length - 1 && (
            <button type="button" className="link small" aria-label="Move right" onClick={() => move(i, 1)}>
              ›
            </button>
          )}
          {value.length > 1 && (
            <button
              type="button"
              className="link small"
              aria-label={`Remove ${labels.get(d)}`}
              onClick={() => onChange(value.filter((x) => x !== d))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {value.length < 5 && (
        <select
          aria-label="Add a group-by field"
          value=""
          onChange={(e) => e.target.value && onChange([...value, e.target.value as ReportDimension])}
        >
          <option value="">+ Add level</option>
          {DIMENSIONS.filter((d) => !value.includes(d)).map((d) => (
            <option key={d} value={d}>
              {labels.get(d) ?? d}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function SettingsBar({ settings, set }: { settings: Settings; set: (s: Settings) => void }) {
  const win = periodWindow(settings);
  return (
    <div className="rp-settings rp-master-settings">
      {/* Period in the shared style (design refresh, team trial round 2): quick periods, the range as a chip that
          opens From / To, and an hour range applied to every day of the period. */}
      <PeriodTabs
        options={PERIODS.filter((p) => p.value !== "custom").map((p) => ({ key: p.value, label: p.label }))}
        value={settings.period === "custom" ? null : settings.period}
        onPick={(period) => set({ ...settings, period, from: null, to: null })}
      />
      <RangeChip
        withTime
        from={toLocal(win.from)}
        to={toLocal(win.to)}
        suffix="UTC"
        onChange={(from, to) =>
          from && to && set({ ...settings, period: "custom", from: fromLocal(from), to: fromLocal(to) })
        }
      />
      <HoursChip
        from={settings.hourFrom ?? 0}
        to={settings.hourTo ?? 23}
        onChange={(hourFrom, hourTo) =>
          set({
            ...settings,
            ...(hourFrom === 0 && hourTo === 23 ? { hourFrom: null, hourTo: null } : { hourFrom, hourTo }),
          })
        }
      />
      <label className="small">
        Timezone
        <select value={settings.timezone} onChange={(e) => set({ ...settings, timezone: e.target.value })}>
          {TIMEZONES.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        Type
        <select
          value={settings.msgType ?? ""}
          onChange={(e) => set({ ...settings, msgType: (e.target.value || null) as Settings["msgType"] })}
        >
          <option value="">MT and MO</option>
          <option value="MT">MT</option>
          <option value="MO">MO</option>
        </select>
      </label>
      <label className="small">
        Compare
        <select
          value={settings.compare}
          onChange={(e) => set({ ...settings, compare: e.target.value as Settings["compare"] })}
        >
          <option value="none">No comparison</option>
          <option value="previous_period">Previous period</option>
          <option value="previous_week">Same time last week</option>
        </select>
      </label>
    </div>
  );
}

function Totals({
  page,
  metrics,
  labels,
}: {
  page: MasterReportPage | null;
  metrics: ReportMetric[];
  labels: Map<string, string>;
}) {
  if (!page) return <div className="rp-totals muted small">Loading totals…</div>;
  return (
    <div className="rp-totals" aria-label="Totals">
      <span className="rp-total-label small">
        {fmtWindow(page.from, page.to)}
        {page.previousFrom && <span className="muted"> · vs {fmtWindow(page.previousFrom, page.previousTo!)}</span>}
        <span className="muted">
          {" "}
          · {page.total.toLocaleString("en-US")} rows · {page.tookMs} ms
        </span>
      </span>
      {metrics.map((m) => (
        <span key={m} className="rp-total">
          <span className="muted small">{labels.get(m) ?? m}</span>{" "}
          <strong className={`num ${metricQualityClass(m, page.totals.metrics[m])}`}>
            {fmtMetric(m, page.totals.metrics[m])}
          </strong>{" "}
          {page.totals.previous && <Delta metric={m} cur={page.totals.metrics[m]} prev={page.totals.previous[m]} />}
        </span>
      ))}
    </div>
  );
}

function ReportChart({
  page,
  groupBy,
  metrics,
  labels,
}: {
  page: MasterReportPage;
  groupBy: ReportDimension[];
  metrics: ReportMetric[];
  labels: Map<string, string>;
}) {
  const c = useChartColors();
  const metric = metrics.find((m) => m !== "tpsPeak") ?? metrics[0]!;
  const timeLike = ["date", "hour", "week", "month"].includes(groupBy[0]!);
  const rows = timeLike
    ? [...page.rows]
        .sort((a, b) => String(a.dims[groupBy[0]!]!.id).localeCompare(String(b.dims[groupBy[0]!]!.id)))
        .slice(-200)
    : page.rows.slice(0, 15);
  const names = rows.map((r) => groupBy.map((d) => r.dims[d]!.label).join(" · "));
  const values = rows.map((r) => r.metrics[metric] ?? null);
  const prev = page.previousFrom ? rows.map((r) => r.previous?.[metric] ?? null) : null;
  const option = {
    color: [c.accent, c.secondary],
    textStyle: { color: c.text },
    tooltip: { trigger: "axis" },
    legend: prev ? { data: ["This period", "Previous"], textStyle: { color: c.secondary } } : undefined,
    grid: timeLike ? { left: 60, right: 20, top: 30, bottom: 40 } : { left: 220, right: 30, top: 24, bottom: 24 },
    xAxis: timeLike
      ? { type: "category", data: names, axisLabel: { color: c.secondary } }
      : { type: "value", axisLabel: { color: c.secondary }, splitLine: { lineStyle: { color: c.border } } },
    yAxis: timeLike
      ? { type: "value", axisLabel: { color: c.secondary }, splitLine: { lineStyle: { color: c.border } } }
      : {
          type: "category",
          data: names,
          inverse: true,
          axisLabel: { color: c.text, width: 200, overflow: "truncate" },
        },
    series: [
      { name: "This period", type: timeLike ? "line" : "bar", data: values, smooth: true, showSymbol: false },
      ...(prev
        ? [
            {
              name: "Previous",
              type: timeLike ? "line" : "bar",
              data: prev,
              smooth: true,
              showSymbol: false,
              lineStyle: { type: "dashed" },
            },
          ]
        : []),
    ],
  };
  return (
    <div className="card rp-chart">
      <div className="small muted">
        {labels.get(metric) ?? metric} by {groupBy.map((d) => labels.get(d) ?? d).join(" · ")}
        {timeLike ? "" : " · top 15 of this page"}
      </div>
      <Chart option={option} height={timeLike ? 240 : 300} label="Report chart" />
    </div>
  );
}

function ExportDialog({ done }: { done: (t: "csv" | "excel" | "pdf" | null) => void }) {
  return (
    <Modal
      title="Export the report"
      width={420}
      onClose={() => done(null)}
      footer={<Button onClick={() => done(null)}>Cancel</Button>}
    >
      <p className="muted small">Every row (up to 100,000) with the totals, in the current sort.</p>
      <div className="rp-export">
        <Button icon="download" onClick={() => done("excel")}>
          Excel
        </Button>
        <Button icon="download" onClick={() => done("csv")}>
          CSV
        </Button>
        <Button icon="download" onClick={() => done("pdf")}>
          PDF
        </Button>
      </div>
    </Modal>
  );
}

export interface ReportPreset {
  settings: MasterReportSettings;
  sort?: { field: string; dir: "asc" | "desc" }[];
}

export function ReportScreen({
  page,
  title,
  preset,
  insights,
  extraActions,
}: {
  page: PageDef;
  title?: string;
  preset: ReportPreset;
  /** Department panel above the grid; gets the applied settings. */
  insights?: (s: Settings) => ReactNode;
  extraActions?: ReactNode;
}) {
  const location = useLocation();
  const navigate = useTabNavigate();
  const fields = useListFields("master_report");
  const views = useViews("master_report");
  const saveView = useSaveView("master_report");
  const initial = useMemo(
    () => ({
      visible: visibleOf(preset.settings),
      builder: preset.settings.filter ?? null,
      sort: preset.sort ?? [],
    }),
    [preset],
  );
  const [grid, setGrid] = useGridUrlState(initial);
  const params = new URLSearchParams(location.search);
  const settings = decodeSettings(params.get("r"), defaultSettings(preset.settings));
  const [result, setResult] = useState<MasterReportPage | null>(null);
  const [chart, setChart] = useState(false);
  const labels = useMemo(() => new Map((fields.data?.fields ?? []).map((f) => [f.field, f.label])), [fields.data]);
  const { groupBy, metrics } = splitVisible(grid.visible ?? visibleOf(preset.settings));

  const setSettings = (s: Settings) => {
    const p = new URLSearchParams(location.search);
    p.set("r", encodeSettings(s));
    navigate(`${location.pathname}?${p.toString()}`, { replace: true });
  };
  const setColumns = (g: ReportDimension[], m: ReportMetric[]) => {
    // Sort keys and column filters on columns that are gone are dropped (the server checks both).
    const visible: string[] = [...g, ...m];
    setGrid({
      ...grid,
      visible,
      sort: grid.sort.filter((s) => visible.includes(s.field)),
      columns: Object.fromEntries(Object.entries(grid.columns).filter(([f]) => visible.includes(f))),
      viewId: null,
    });
  };
  const scope = JSON.stringify([settings, groupBy, metrics]);
  const fetchPage = useMemo(
    () =>
      async (body: ListQuery): Promise<ListPage<FlatRow>> => {
        const page = await runMasterReport({
          ...settings,
          groupBy,
          metrics,
          ...(body.filter ? { filter: body.filter } : {}),
          ...(body.sort?.length ? { sort: body.sort } : {}),
          limit: body.limit ?? 200,
          cursor: body.cursor ?? null,
        });
        if (!body.cursor) setResult(page);
        return {
          rows: page.rows.map(flatten),
          total: page.total,
          totalIsEstimate: page.totalIsEstimate,
          nextCursor: page.nextCursor,
        };
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope],
  );

  const reportOf = (state: GridState): MasterReportSettings => {
    const filter = buildFilter(state);
    return { ...settings, groupBy, metrics, ...(filter ? { filter } : {}) };
  };
  const doExport = async (state: GridState) => {
    const t = await ask<"csv" | "excel" | "pdf" | null>((d) => <ExportDialog done={d} />);
    if (!t) return;
    const q = toListQuery(state);
    void exportMasterReport({
      query: { ...reportOf(state), ...(q.sort ? { sort: q.sort } : {}), limit: 4000 },
      fileType: t,
    }).catch((e) => toast({ tone: "error", message: problemText(e) }));
  };
  const saveReportView = () => {
    const name = window.prompt("Name of the report view (scheduled reports can e-mail it)", title ?? page.label);
    if (!name?.trim()) return;
    const q = toListQuery(grid);
    saveView.mutate(
      {
        input: {
          list: "master_report",
          name: name.trim(),
          state: {
            ...(q.filter ? { filter: q.filter } : {}),
            ...(q.sort ? { sort: q.sort } : {}),
            columns: [...groupBy, ...metrics],
            report: reportOf(grid),
          },
        },
      },
      {
        onSuccess: () => toast({ tone: "good", message: `Report view "${name.trim()}" saved` }),
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
  };
  const openView = (id: number) => {
    const v = views.data?.find((x) => x.id === id);
    if (!v) return;
    const report = v.state.report;
    const p = new URLSearchParams(location.search);
    if (report) p.set("r", encodeSettings(defaultSettings(report)));
    const g = encodeState({
      columns: {},
      builder: v.state.filter ?? null,
      search: "",
      sort: v.state.sort ?? [],
      visible: v.state.columns ?? (report ? visibleOf(report) : null),
      viewId: v.id,
    });
    if (g) p.set("g", g);
    navigate(`${location.pathname}?${p.toString()}`, { replace: true });
  };
  const drill = (row: FlatRow, dim: ReportDimension) => {
    const conds = drillConditions(row.row, groupBy);
    const columns = { ...grid.columns };
    for (const c of conds) columns[c.field] = c;
    const visible = [...groupBy, dim, ...metrics];
    setGrid({ ...grid, columns, visible, viewId: null });
  };

  const metricColumns = Object.fromEntries(
    metrics.map((m) => [
      m,
      {
        width: settings.compare === "none" ? 120 : 165,
        align: "right" as const,
        render: (r: FlatRow) => {
          const v = r.row.metrics[m];
          return (
            <span className={`num${m === "margin" && (v ?? 0) < 0 ? " tone-error" : ""} ${metricQualityClass(m, v)}`}>
              {fmtMetric(m, v)} {r.row.previous && <Delta metric={m} cur={v} prev={r.row.previous[m]} />}
            </span>
          );
        },
      },
    ]),
  );
  const dimColumns = Object.fromEntries(
    groupBy.map((d) => [d, { width: d === "destination" || d === "vendorDestination" ? 240 : 190 }]),
  );

  return (
    <ListScreen<FlatRow>
      key={location.pathname}
      list="master_report"
      page={page}
      title={title}
      noSelection
      historyScope={null}
      rowActions={(r) => [
        {
          label: "View EDRs",
          icon: "search",
          main: true,
          disabled: !result,
          hint: "EDRs behind this row",
          onSelect: () => result && navigate(edrSearchPath(r.row, groupBy, result.from, result.to)),
        },
        ...(groupBy.length >= 5
          ? []
          : DIMENSIONS.filter((d) => !groupBy.includes(d)).map((d) => ({
              label: `Drill by ${labels.get(d) ?? d}`,
              icon: "filter" as const,
              hint: "Keep only this row and break it down",
              onSelect: () => drill(r, d),
            }))),
      ]}
      initialState={initial}
      queryScope={scope}
      fetchPage={fetchPage}
      enabled={groupBy.length > 0 && metrics.length > 0}
      idleMessage="Pick at least one grouping and one metric to see the report."
      onExport={(s) => void doExport(s)}
      actions={
        <>
          {extraActions}
          <select
            aria-label="Open a report view"
            className="rp-views"
            value=""
            onChange={(e) => e.target.value && openView(Number(e.target.value))}
          >
            <option value="">Report views…</option>
            {views.data?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.readOnly ? ` (${v.owner.displayName})` : ""}
              </option>
            ))}
          </select>
          <Button small icon="star" onClick={saveReportView}>
            Save view
          </Button>
          <Button small icon="chart" onClick={() => setChart((v) => !v)}>
            {chart ? "Hide chart" : "Chart"}
          </Button>
        </>
      }
      above={
        <>
          <SettingsBar settings={settings} set={setSettings} />
          <div className="rp-columns-row">
            <GroupBy labels={labels} value={groupBy} onChange={(g) => setColumns(g, metrics)} />
            {fields.data && (
              <MetricsPicker fields={fields.data.fields} value={metrics} onChange={(m) => setColumns(groupBy, m)} />
            )}
          </div>
          {insights && (
            <details className="rp-insights" open>
              <summary className="small">{title ?? page.label}: what stands out</summary>
              {insights(settings)}
            </details>
          )}
          {groupBy.length === 0 ? (
            <p className="muted rp-hint">Choose at least one group-by field.</p>
          ) : (
            <Totals page={result} metrics={metrics} labels={labels} />
          )}
          {chart && result && result.rows.length > 0 && (
            <ReportChart page={result} groupBy={groupBy} metrics={metrics} labels={labels} />
          )}
        </>
      }
      columns={{ ...dimColumns, ...metricColumns }}
      detail={(r) => ({
        title: (
          <>
            <strong>{groupBy.map((d) => r.row.dims[d]!.label).join(" · ")}</strong>
            {result && <span className="muted">{fmtWindow(result.from, result.to)}</span>}
          </>
        ),
        sections: [
          {
            key: "figures",
            label: "Figures",
            actions: result ? (
              <Button
                small
                icon="search"
                onClick={() => navigate(edrSearchPath(r.row, groupBy, result.from, result.to))}
              >
                EDRs behind this row
              </Button>
            ) : undefined,
            content: (
              <dl className="kv">
                {metrics.map((m) => (
                  <div key={m} className="kv-pair">
                    <dt>{labels.get(m) ?? m}</dt>
                    <dd className="num">
                      <span className={metricQualityClass(m, r.row.metrics[m])}>{fmtMetric(m, r.row.metrics[m])}</span>
                      {r.row.previous && (
                        <>
                          {" "}
                          <span className="muted">(was {fmtMetric(m, r.row.previous[m])})</span>{" "}
                          <Delta metric={m} cur={r.row.metrics[m]} prev={r.row.previous[m]} />
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            ),
          },
          {
            key: "drill",
            label: "Drill down",
            content: (
              <div className="rp-drill">
                <p className="muted small">Keep only this row and break it down by:</p>
                {groupBy.length >= 5 ? (
                  <p className="muted small">Five levels is the most; remove one first.</p>
                ) : (
                  DIMENSIONS.filter((d) => !groupBy.includes(d)).map((d) => (
                    <Button key={d} small onClick={() => drill(r, d)}>
                      {labels.get(d) ?? d}
                    </Button>
                  ))
                )}
              </div>
            ),
          },
        ],
      })}
      shortcuts="Column filters on group-by fields apply before grouping, on metrics after (e.g. margin < 0) · click a row to drill down"
    />
  );
}
