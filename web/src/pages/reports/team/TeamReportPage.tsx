// Reports › Team (§13.18): each team member's business results and their work in the system, for a
// period with the previous one, in the viewer's scope (admins everyone, department managers their
// department). Sections switch the columns (?section=); a member opens their detail (daily results,
// activity by hour, login days, new and stopped clients, devices) and timeline. Charts: activity by
// hour and a ranking for any metric. Targets per user and month; CSV export; a weekly summary is a
// scheduled report of kind Team (Reports › Scheduled).
import { useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { TeamMemberRow, TeamReport, TeamReportQuery, TeamRole, TeamTimelineRow } from "@sms/contract";
import { downloadTeamCsv, useSaveTeamTargets, useTeamMember, useTeamReport, useTeamTargets } from "../../../api/team";
import { Withheld } from "../../../grid/DataGrid";
import { pageForPath } from "../../../nav/registry";
import { PageHeader } from "../../../page/PageHeader";
import { ChildGrid, ListLookup } from "../../../records/parts";
import { useTabNavigate } from "../../../shell/tabContext";
import { ask, toast } from "../../../ui/feedback";
import { Chart, useChartColors } from "../../../ui/Chart";
import { Button, Modal } from "../../../ui/primitives";
import { VirtualTable, type VColumn } from "../../lookup/VirtualTable";
import { fmtWhen } from "../../reference/shared";
import { problemText } from "../../routing/dialogs";
import { fmtHours, isSection, METRICS, PERIODS, ranking, recordLink, SECTIONS, type Section } from "./teamModel";

const page = pageForPath("/reports/team")!;
const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
const int = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-US"));
const money = (v: number | null | undefined, ccy?: string) =>
  v == null ? "—" : `${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}${ccy ? ` ${ccy}` : ""}`;
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(1)}%`);
const ROLE: Record<TeamRole, string> = {
  account_manager: "AM",
  team_lead: "Team lead",
  department_manager: "Dept manager",
  admin: "Admin",
};

function useTeamNav() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const p = new URLSearchParams(location.search);
  const raw = p.get("section");
  const section: Section = isSection(raw) ? raw : "business";
  const member = p.get("member") ? Number(p.get("member")) : null;
  const set = (key: string, value: string | null) => {
    const q = new URLSearchParams(location.search);
    if (value === null || value === "") q.delete(key);
    else q.set(key, value);
    navigate(`/reports/team?${q.toString()}`, { replace: true });
  };
  return { section, member, set };
}

/** A withheld value (§13.17) or the formatted one. */
function cell(r: { masked: TeamReport["masked"] }, row: TeamMemberRow, field: string, shown: ReactNode): ReactNode {
  const m = r.masked.find((x) => x.id === row.id && x.field === field);
  return m ? <Withheld text={m.text} /> : shown;
}

function columnsFor(section: Section, r: TeamReport, onOpen: (row: TeamMemberRow) => void): VColumn<TeamMemberRow>[] {
  const name: VColumn<TeamMemberRow> = {
    key: "name",
    header: "Member",
    width: 220,
    sticky: true,
    render: (x) => (
      <button type="button" className="link team-name" onClick={() => onOpen(x)}>
        <span className={`team-dot${x.online ? " on" : ""}`} title={x.online ? "Online now" : "Offline"} />
        {x.name}
      </button>
    ),
  };
  const dept: VColumn<TeamMemberRow> = {
    key: "dept",
    header: "Department",
    width: 120,
    render: (x) => x.department ?? "—",
  };
  const roles: VColumn<TeamMemberRow> = {
    key: "roles",
    header: "Roles",
    width: 130,
    render: (x) => <span className="muted small">{x.roles.map((k) => ROLE[k]).join(", ") || "—"}</span>,
  };
  const num = (
    key: string,
    header: string,
    f: (x: TeamMemberRow) => ReactNode,
    width = 100,
  ): VColumn<TeamMemberRow> => ({
    key,
    header,
    width,
    align: "right",
    render: f,
  });
  const b = (x: TeamMemberRow) => x.business;
  switch (section) {
    case "business":
      return [
        name,
        dept,
        num("clients", "Active clients", (x) => int(b(x)?.activeClients)),
        num(
          "new",
          "New",
          (x) => (b(x)?.newClients ? <span className="tone-good">+{b(x)!.newClients}</span> : int(b(x)?.newClients)),
          70,
        ),
        num(
          "stopped",
          "Stopped",
          (x) =>
            b(x)?.stoppedClients ? (
              <span className="tone-warning">{b(x)!.stoppedClients}</span>
            ) : (
              int(b(x)?.stoppedClients)
            ),
          80,
        ),
        num("messages", "Messages", (x) => int(b(x)?.messages), 110),
        num("revenue", "Revenue", (x) => cell(r, x, "revenue", money(b(x)?.revenue)), 110),
        num("margin", "Margin", (x) => cell(r, x, "margin", money(b(x)?.margin)), 100),
        num("marginPct", "Margin %", (x) => cell(r, x, "marginPct", pct(b(x)?.marginPct)), 90),
        num(
          "growth",
          "Growth",
          (x) => {
            const g = b(x)?.growthPct;
            return cell(
              r,
              x,
              "revenue",
              g == null ? (
                "—"
              ) : (
                <span className={g < 0 ? "tone-warning" : "tone-good"}>
                  {g > 0 ? "+" : ""}
                  {g.toFixed(1)}%
                </span>
              ),
            );
          },
          90,
        ),
        num("target", "Target", (x) => cell(r, x, "revenue", money(b(x)?.revenueTarget)), 100),
        num(
          "achieved",
          "Achieved",
          (x) => {
            const a = b(x)?.achievedPct;
            return cell(
              r,
              x,
              "revenue",
              a == null ? (
                "—"
              ) : (
                <span className={a >= 100 ? "tone-good" : a < 70 ? "tone-warning" : undefined}>{a.toFixed(0)}%</span>
              ),
            );
          },
          90,
        ),
      ];
    case "rates":
      return [
        name,
        dept,
        num("tables", "Rate tables", (x) => int(x.rates.rateTablesChanged)),
        num("lines", "Line changes", (x) => int(x.rates.rateLineChanges)),
        num("rnOk", "RNs accepted", (x) => int(x.rates.rnAccepted), 110),
        num("rnNo", "RNs rejected", (x) => int(x.rates.rnRejected), 110),
        num("moves", "Market moves", (x) => int(x.rates.marketMovesHandled), 110),
        num(
          "moveH",
          "Avg to handle",
          (x) => (x.rates.avgMoveHandleHours == null ? "—" : `${x.rates.avgMoveHandleHours} h`),
          110,
        ),
        num("rules", "Route rules", (x) => int(x.rates.routeRulesChanged)),
        num("bulk", "Bulk jobs", (x) => int(x.rates.bulkJobs), 90),
        num(
          "undone",
          "Undone by others",
          (x) => (x.rates.undoneByOthers ? <span className="tone-warning">{x.rates.undoneByOthers}</span> : "0"),
          130,
        ),
      ];
    case "billing":
      return [
        name,
        dept,
        num("inv", "Invoices generated", (x) => int(x.billing.invoicesGenerated), 140),
        num("invSent", "Invoices sent", (x) => int(x.billing.invoicesSent), 110),
        num("soa", "SOAs generated", (x) => int(x.billing.soasGenerated), 120),
        num("soaSent", "SOAs sent", (x) => int(x.billing.soasSent)),
        num("pay", "Payments recorded", (x) => int(x.billing.paymentsRecorded), 140),
        num("dOpen", "Disputes opened", (x) => int(x.billing.disputesOpened), 130),
        num("dClosed", "Disputes closed", (x) => int(x.billing.disputesClosed), 130),
        num(
          "soaConfirm",
          "Avg vendor SOA confirm",
          (x) => (x.billing.avgVendorSoaConfirmHours == null ? "—" : `${x.billing.avgVendorSoaConfirmHours} h`),
          170,
        ),
      ];
    case "noc":
      return [
        name,
        dept,
        num("acked", "Alerts acknowledged", (x) => int(x.noc.alertsAcknowledged), 150),
        num(
          "ack",
          "Avg to acknowledge",
          (x) => (x.noc.avgAckMinutes == null ? "—" : `${x.noc.avgAckMinutes} min`),
          140,
        ),
        num(
          "resolve",
          "Avg to resolve",
          (x) => (x.noc.avgResolveMinutes == null ? "—" : `${x.noc.avgResolveMinutes} min`),
          120,
        ),
        num("handled", "Incidents handled", (x) => int(x.noc.incidentsHandled), 130),
        num("tickets", "Tickets raised", (x) => int(x.noc.ticketsRaised), 110),
        num("binds", "Binds started / stopped", (x) => int(x.noc.bindActions), 170),
      ];
    case "activity":
      return [
        name,
        dept,
        roles,
        num("days", "Days active", (x) => int(x.activity.daysActive), 100),
        num("hours", "Hours online", (x) => fmtHours(x.activity.hoursOnline), 110),
        {
          key: "last",
          header: "Last sign-in",
          width: 150,
          render: (x) => (x.activity.lastLoginAt ? fmtWhen(x.activity.lastLoginAt) : "—"),
        },
        num("saves", "Saves", (x) => int(x.activity.saves), 80),
        {
          key: "pages",
          header: "Pages most used",
          width: 300,
          render: (x) => (
            <span
              className="small"
              title={x.activity.topPages.map((p) => `${pageForPath(p.path)?.label ?? p.path}: ${p.views}`).join("\n")}
            >
              {x.activity.topPages.map((p) => pageForPath(p.path)?.label ?? p.path).join(", ") || "—"}
            </span>
          ),
        },
        num(
          "devices",
          "New devices / IPs",
          (x) => (x.activity.newDevices ? <span className="tone-warning">{x.activity.newDevices}</span> : "0"),
          130,
        ),
      ];
  }
}

// ---------------------------------------------------------------- charts

function HourlyChart({ hours, label }: { hours: number[]; label: string }) {
  const c = useChartColors();
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 36, right: 8, top: 10, bottom: 22 },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.panel,
        borderColor: c.border,
        textStyle: { color: c.text, fontSize: 12 },
      },
      xAxis: {
        type: "category",
        data: hours.map((_, h) => String(h).padStart(2, "0")),
        axisLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.secondary, fontSize: 10, interval: 2 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.secondary, fontSize: 10 },
      },
      series: [
        {
          name: "Saves",
          type: "bar",
          data: hours,
          itemStyle: { color: c.accent, borderRadius: [2, 2, 0, 0] },
          barMaxWidth: 12,
        },
      ],
    }),
    [hours, c],
  );
  return <Chart option={option} height={150} label={label} />;
}

function RankingChart({ rows, ccy }: { rows: TeamMemberRow[]; ccy: string }) {
  const c = useChartColors();
  const [key, setKey] = useState("revenue");
  const metric = METRICS.find((m) => m.key === key)!;
  const data = ranking(rows, metric).reverse();
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 120, right: 30, top: 6, bottom: 20 },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.panel,
        borderColor: c.border,
        textStyle: { color: c.text, fontSize: 12 },
      },
      xAxis: {
        type: "value",
        splitLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.secondary, fontSize: 10 },
      },
      yAxis: {
        type: "category",
        data: data.map((d) => d.name),
        axisLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.secondary, fontSize: 11, width: 110, overflow: "truncate" },
      },
      series: [
        {
          name: metric.label,
          type: "bar",
          data: data.map((d) => d.value),
          itemStyle: { color: c.accent, borderRadius: [0, 2, 2, 0] },
          barMaxWidth: 12,
          label: {
            show: true,
            position: "right",
            color: c.secondary,
            fontSize: 10,
            formatter: (p: { value: number }) =>
              metric.money ? money(p.value) : metric.pct ? pct(p.value) : int(p.value),
          },
        },
      ],
    }),
    [data, c, metric],
  );
  return (
    <div className="team-card">
      <div className="team-card-head">
        <strong>Ranking</strong>
        <select value={key} aria-label="Ranking metric" onChange={(e) => setKey(e.target.value)}>
          {METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
              {m.money ? ` (${ccy})` : ""}
            </option>
          ))}
        </select>
      </div>
      {data.length ? (
        <Chart option={option} height={Math.max(120, data.length * 22 + 30)} label={`Ranking by ${metric.label}`} />
      ) : (
        <p className="muted small">No member has a value for {metric.label.toLowerCase()} in this period.</p>
      )}
    </div>
  );
}

function TrendChart({
  points,
  ccy,
}: {
  points: { date: string; messages: number; revenue: number | null; margin: number | null }[];
  ccy: string;
}) {
  const c = useChartColors();
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 46, right: 50, top: 26, bottom: 22 },
      legend: { top: 0, right: 0, textStyle: { color: c.secondary, fontSize: 11 }, itemHeight: 8 },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.panel,
        borderColor: c.border,
        textStyle: { color: c.text, fontSize: 12 },
      },
      xAxis: {
        type: "category",
        data: points.map((p) => p.date.slice(5)),
        axisLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.secondary, fontSize: 10 },
      },
      yAxis: [
        {
          type: "value",
          splitLine: { lineStyle: { color: c.border } },
          axisLabel: { color: c.secondary, fontSize: 10 },
        },
        { type: "value", splitLine: { show: false }, axisLabel: { color: c.secondary, fontSize: 10 } },
      ],
      series: [
        {
          name: "Messages",
          type: "bar",
          data: points.map((p) => p.messages),
          itemStyle: { color: c.accent },
          barMaxWidth: 14,
        },
        {
          name: `Revenue (${ccy})`,
          type: "line",
          yAxisIndex: 1,
          data: points.map((p) => p.revenue),
          symbol: "none",
          lineStyle: { color: c.good, width: 1.5 },
          itemStyle: { color: c.good },
        },
      ],
    }),
    [points, c, ccy],
  );
  return <Chart option={option} height={170} label="Their clients' results per day" />;
}

// ---------------------------------------------------------------- member detail

function MemberPanel({ id, q, ccy, onClose }: { id: number; q: TeamReportQuery; ccy: string; onClose: () => void }) {
  const d = useTeamMember(id, q);
  const navigate = useTabNavigate();
  const [tab, setTab] = useState<"overview" | "timeline">("overview");
  if (d.isError) return <div className="team-panel grid-message tone-error">{problemText(d.error)}</div>;
  if (!d.data) return <div className="team-panel grid-message muted">Loading…</div>;
  const { row } = d.data;
  return (
    <div className="team-panel">
      <div className="team-card-head">
        <div>
          <strong>{row.name}</strong>{" "}
          <span className="muted small">
            {row.username} · {row.department ?? "—"} · {row.roles.map((k) => ROLE[k]).join(", ") || "staff"}
            {row.online ? " · online now" : ""}
          </span>
        </div>
        <div className="segmented small" role="radiogroup" aria-label="Member view">
          {(["overview", "timeline"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={tab === t}
              className={tab === t ? "on" : ""}
              onClick={() => setTab(t)}
            >
              {t === "overview" ? "Overview" : "Timeline"}
            </button>
          ))}
        </div>
        <button type="button" className="link small" onClick={onClose}>
          Close
        </button>
      </div>
      {tab === "timeline" ? (
        <div className="team-timeline">
          <ChildGrid<TeamTimelineRow>
            key={id}
            list="team_timeline"
            fixed={{ userId: { field: "userId", op: "eq", value: id } }}
            columns={{
              at: { width: 150, render: (r) => fmtWhen(r.at) },
              kind: {
                width: 90,
                render: (r) => (r.kind === "change" ? "Change" : r.kind === "login" ? "Sign-in" : "Action"),
              },
              type: { width: 220 },
              summary: { width: 420 },
            }}
            onOpen={(r) => {
              const link = recordLink(r.entityType, r.entityId);
              if (link) navigate(link, { newTab: true });
            }}
          />
        </div>
      ) : (
        <div className="team-detail">
          {row.business && (
            <div className="team-card">
              <div className="team-card-head">
                <strong>Their clients</strong>
                <span className="muted small">
                  {int(row.business.activeClients)} active ·{" "}
                  {cell(d.data, row, "revenue", money(row.business.revenue, ccy))} revenue ·{" "}
                  {cell(d.data, row, "marginPct", pct(row.business.marginPct))} margin
                </span>
              </div>
              <TrendChart points={d.data.trend} ccy={ccy} />
              <div className="team-cols">
                <div>
                  <div className="stat-label">New clients</div>
                  {d.data.newClients.length ? (
                    d.data.newClients.map((c) => (
                      <div key={c.enterpriseId} className="small">
                        <button
                          type="button"
                          className="link"
                          onClick={() => navigate(`/enterprises/${c.enterpriseId}`, { newTab: true })}
                        >
                          {c.enterpriseName}
                        </button>{" "}
                        <span className="muted">first traffic {fmtWhen(c.at)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="muted small">None</div>
                  )}
                </div>
                <div>
                  <div className="stat-label">Stopped sending</div>
                  {d.data.stoppedClients.length ? (
                    d.data.stoppedClients.map((c) => (
                      <div key={c.enterpriseId} className="small">
                        {c.enterpriseName} <span className="muted">last {fmtWhen(c.at)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="muted small">None</div>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="team-card">
            <div className="team-card-head">
              <strong>Activity by hour (UTC)</strong>
              <span className="muted small">
                {int(row.activity.saves)} saves · {fmtHours(row.activity.hoursOnline)} h online ·{" "}
                {row.activity.daysActive} days
              </span>
            </div>
            <HourlyChart hours={d.data.hourly} label={`${row.name}: saves by hour of day`} />
          </div>
          <div className="team-card">
            <strong>Sign-in days</strong>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>First sign-in</th>
                  <th>Last seen</th>
                  <th className="num">Hours</th>
                  <th className="num">Saves</th>
                </tr>
              </thead>
              <tbody>
                {d.data.days.map((x) => (
                  <tr key={x.date}>
                    <td>{x.date}</td>
                    <td>{x.firstLogin.slice(11, 16)}</td>
                    <td>{x.lastSeen.slice(11, 16)}</td>
                    <td className="num">{fmtHours(x.hours)}</td>
                    <td className="num">{x.saves}</td>
                  </tr>
                ))}
                {!d.data.days.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No sign-ins in the period
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="team-card">
            <strong>Devices and IPs</strong>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>IP</th>
                  <th>Location</th>
                  <th>First seen</th>
                  <th className="num">Sessions</th>
                </tr>
              </thead>
              <tbody>
                {d.data.devices.map((x, i) => (
                  <tr key={i}>
                    <td>
                      {[x.device, x.os, x.browser].filter(Boolean).join(" · ")}
                      {x.isNew && <span className="chip-mini tone-warning"> new</span>}
                    </td>
                    <td>{x.ip ?? "—"}</td>
                    <td>{x.location ?? "—"}</td>
                    <td>{fmtWhen(x.firstSeen)}</td>
                    <td className="num">{x.sessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- targets

function TargetsDialog({ done }: { done: (v: null) => void }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const t = useTeamTargets(month);
  const save = useSaveTeamTargets();
  const [edits, setEdits] = useState<Record<number, { revenueTarget: number | null; marginTarget: number | null }>>({});
  const rows = t.data ?? [];
  const val = (id: number, k: "revenueTarget" | "marginTarget") =>
    edits[id] ? edits[id]![k] : (rows.find((r) => r.userId === id)?.[k] ?? null);
  const setVal = (id: number, k: "revenueTarget" | "marginTarget", v: string) =>
    setEdits({
      ...edits,
      [id]: {
        revenueTarget: val(id, "revenueTarget"),
        marginTarget: val(id, "marginTarget"),
        [k]: v === "" ? null : Number(v),
      },
    });
  return (
    <Modal
      title="Monthly targets"
      width={640}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!Object.keys(edits).length || save.isPending}
            onClick={() =>
              save.mutate(
                { month, items: Object.entries(edits).map(([id, v]) => ({ userId: Number(id), ...v })) },
                {
                  onSuccess: () => {
                    toast({ tone: "good", message: `Saved ${Object.keys(edits).length} target(s) for ${month}` });
                    done(null);
                  },
                  onError: fail,
                },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Month</span>
        <input
          type="month"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setEdits({});
          }}
        />
      </label>
      <div className="team-targets">
        <table className="mini-table">
          <thead>
            <tr>
              <th>Account manager</th>
              <th>Department</th>
              <th className="num">Revenue target</th>
              <th className="num">Margin target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId}>
                <td>{r.userName}</td>
                <td>{r.department ?? "—"}</td>
                {(["revenueTarget", "marginTarget"] as const).map((k) => (
                  <td key={k} className="num">
                    <input
                      className="mm-num"
                      type="number"
                      min={0}
                      step={100}
                      aria-label={`${r.userName} ${k === "revenueTarget" ? "revenue" : "margin"} target`}
                      value={val(r.userId, k) ?? ""}
                      onChange={(e) => setVal(r.userId, k, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Platform currency. A period's target is the months' targets prorated by day.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- page

export function TeamReportPage() {
  const { section, member, set } = useTeamNav();
  const navigate = useTabNavigate();
  const [period, setPeriod] = useState<TeamReportQuery["period"]>("last_7_days");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [compare, setCompare] = useState(true);
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [role, setRole] = useState<TeamRole | "">("");
  const [search, setSearch] = useState("");
  const q: TeamReportQuery = {
    period,
    compare,
    departmentId,
    role: role || null,
    search: search.trim() || null,
    ...(period === "custom" && from && to
      ? { from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T00:00:00Z`).toISOString() }
      : {}),
  };
  const ready = period !== "custom" || (!!from && !!to);
  const r = useTeamReport(q);
  const data = ready ? r.data : undefined;
  // Business results are for account managers; the other sections list everyone.
  const rows = useMemo(
    () => (data?.rows ?? []).filter((x) => section !== "business" || x.business !== null),
    [data, section],
  );
  const ccy = data?.currency ?? "EUR";
  const columns = useMemo(
    () => (data ? columnsFor(section, data, (x) => set("member", String(x.id))) : []),
    [data, section, set],
  );
  const t = data?.totals;
  return (
    <div className="page team-page">
      <PageHeader
        page={page}
        actions={
          <>
            <Button
              icon="calendar"
              onClick={() => navigate("/reports/scheduled", { newTab: true })}
              title="A weekly summary is a scheduled report of kind Team"
            >
              Scheduled e-mail
            </Button>
            <Button icon="download" disabled={!data} onClick={() => void downloadTeamCsv(q).catch(fail)}>
              Export
            </Button>
            <Button
              variant="primary"
              icon="tag"
              disabled={data?.scope === "self" || data?.scope === "team"}
              title="Revenue and margin targets per account manager and month"
              onClick={() => void ask<null>((done) => <TargetsDialog done={done} />)}
            >
              Targets
            </Button>
          </>
        }
      />
      <div className="lcr-controls">
        <label className="field">
          <span>Period</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as TeamReportQuery["period"])}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {period === "custom" && (
          <>
            <label className="field">
              <span>From (UTC)</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>To (UTC, not included)</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
        <div className="field">
          <span>Department</span>
          <ListLookup<{ id: number; name: string }>
            list="departments"
            value={departmentId}
            onChange={(x) => setDepartmentId(x?.id ?? null)}
            labelOf={(x) => x.name}
            placeholder="All departments"
          />
        </div>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as TeamRole | "")}>
            <option value="">All roles</option>
            {(Object.keys(ROLE) as TeamRole[]).map((k) => (
              <option key={k} value={k}>
                {ROLE[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Member</span>
          <input value={search} placeholder="Name or username" onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="toggle-inline">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare with the
          previous period
        </label>
      </div>
      {data && (
        <div className="stat-cards">
          <div className="stat-card">
            <span className="stat-label">Members</span>
            <span className="stat-value">{int(t!.members)}</span>
            <span className="muted small">
              {int(t!.activeMembers)} active · scope: {data.scopeLabel}
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Messages</span>
            <span className="stat-value">{int(t!.messages)}</span>
            <span className="muted small">their clients</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Revenue</span>
            <span className="stat-value">
              {t!.revenue === null ? <Withheld text="Hidden" /> : money(t!.revenue, ccy)}
            </span>
            <span className="muted small">
              margin {t!.margin === null ? "hidden" : `${money(t!.margin, ccy)} · ${pct(t!.marginPct)}`}
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Saves</span>
            <span className="stat-value">{int(t!.saves)}</span>
            <span className="muted small">{fmtHours(t!.hoursOnline)} hours online</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Alerts acknowledged</span>
            <span className="stat-value">{int(t!.alertsAcknowledged)}</span>
            <span className="muted small">
              {fmtWhen(data.period.from).slice(0, 10)} – {fmtWhen(data.period.to).slice(0, 10)}
              {data.previous ? " vs previous" : ""}
            </span>
          </div>
        </div>
      )}
      <div className="rm-trunk">
        <div className="segmented small" role="radiogroup" aria-label="Section">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={section === s.key}
              className={section === s.key ? "on" : ""}
              onClick={() => set("section", s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="team-body">
        <div className="rate-grid-card">
          {!ready ? (
            <div className="grid-message muted">Choose the custom period&apos;s dates.</div>
          ) : r.isError ? (
            <div className="grid-message tone-error">{problemText(r.error)}</div>
          ) : (
            <VirtualTable<TeamMemberRow>
              label="Team report"
              rows={rows}
              columns={columns}
              rowKey={(x) => String(x.id)}
              rowClass={(x) => (x.id === member ? "team-active" : undefined)}
              empty={r.isPending ? "Loading…" : "No team member matches"}
            />
          )}
        </div>
        <aside className="team-side">
          {member !== null && data ? (
            <MemberPanel key={member} id={member} q={q} ccy={ccy} onClose={() => set("member", null)} />
          ) : (
            data && (
              <>
                <div className="team-card">
                  <div className="team-card-head">
                    <strong>Activity by hour (UTC)</strong>
                    <span className="muted small">saves by everyone listed</span>
                  </div>
                  <HourlyChart hours={data.hourly} label="Team saves by hour of day" />
                </div>
                <RankingChart rows={data.rows} ccy={ccy} />
              </>
            )
          )}
        </aside>
      </div>
    </div>
  );
}
