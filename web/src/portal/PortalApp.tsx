// Customer portal at /portal (§1, team trial round 5): its own sign-in and a small, calm window with the
// customer's balance, rates, traffic and message log. Lists filter, sort and page on the server like every
// staff grid (CLAUDE.md rule 3); nothing about vendors, routes, costs or margins reaches this app.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router";
import type { PortalMessageRow, PortalRateRow, PortalTrafficQuery } from "@sms/contract";
import { ApiError } from "../api/client";
import type { ListPage } from "../api/hooks";
import { DataGrid, type ColumnOverride } from "../grid/DataGrid";
import { emptyState, toListQuery, type GridState } from "../grid/filterModel";
import { Chart, useChartColors } from "../ui/Chart";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/primitives";
import {
  downloadRates,
  fetchMessages,
  fetchRates,
  useChangePassword,
  useOverview,
  usePortalFields,
  usePortalSession,
  useSignIn,
  useSignOut,
  useTraffic,
} from "./api";
import { fmtAmount, fmtCount, fmtPct, fmtRate, periodRange, type Period } from "./format";
import "../styles/portal.css";

// ---------------------------------------------------------------- theme

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("portalTheme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // No saved choice.
    }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("portalTheme", theme);
    } catch {
      // Kept for this visit only.
    }
  }, [theme]);
  return [theme, () => setTheme(theme === "light" ? "dark" : "light")] as const;
}

const problem = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong");

// ---------------------------------------------------------------- sign-in and password

function SignIn() {
  const signIn = useSignIn();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate({ username, password });
  };
  return (
    <div className="portal-center">
      <form className="portal-card portal-signin" onSubmit={submit}>
        <div className="portal-brand">
          <span className="portal-logo">
            <Icon name="send" size={18} />
          </span>
          <div>
            <strong>Customer portal</strong>
            <span className="muted small">Your balance, rates and traffic</span>
          </div>
        </div>
        <label className="portal-field">
          <span>Username</span>
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="portal-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {signIn.error && <p className="error-text">{problem(signIn.error)}</p>}
        <Button variant="primary" type="submit" disabled={!username || !password || signIn.isPending}>
          Sign in
        </Button>
        <p className="muted small">Forgot your password? Ask your account manager for a new one.</p>
      </form>
    </div>
  );
}

function ChangePassword({ forced, onDone }: { forced: boolean; onDone?: () => void }) {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const errors = change.error instanceof ApiError ? (change.error.problem.errors as { message: string }[]) : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate({ currentPassword: current, newPassword: next }, { onSuccess: () => onDone?.() });
  };
  return (
    <form className="portal-card portal-signin" onSubmit={submit}>
      <h2>{forced ? "Choose a new password" : "Change password"}</h2>
      {forced && <p className="muted small">Your password expired or was set by your account manager.</p>}
      <label className="portal-field">
        <span>Current password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      <label className="portal-field">
        <span>New password</span>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="portal-field">
        <span>New password again</span>
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      {next && again && next !== again && <p className="error-text">The new passwords are not the same.</p>}
      {errors?.length ? (
        <ul className="error-text">
          {errors.map((x) => (
            <li key={x.message}>{x.message}</li>
          ))}
        </ul>
      ) : (
        change.error && <p className="error-text">{problem(change.error)}</p>
      )}
      {change.isSuccess && !forced && <p className="good-text">Password changed.</p>}
      <Button variant="primary" type="submit" disabled={!current || !next || next !== again || change.isPending}>
        Save password
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- overview

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="kpi-tile">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

function Overview() {
  const q = useOverview();
  const o = q.data;
  if (q.error) return <p className="error-text">{problem(q.error)}</p>;
  if (!o) return <p className="muted">Loading…</p>;
  const cur = o.currency ?? "";
  return (
    <div className="portal-page">
      <h1>Overview</h1>
      <div className="kpi-tiles portal-tiles">
        <Tile
          label="Balance"
          value={
            <span className={o.balance !== null && o.balance < 0 ? "bad-text" : undefined}>
              {o.balance === null ? "—" : `${fmtAmount(o.balance)} ${cur}`}
            </span>
          }
          sub={
            o.balance !== null && o.balance < 0
              ? "Amount due"
              : o.billingType === "prepaid"
                ? "Prepaid credit"
                : "In your favour"
          }
        />
        <Tile
          label="Available credit"
          value={o.availableCredit === null ? "—" : `${fmtAmount(o.availableCredit)} ${cur}`}
          sub={o.creditLimit ? `Credit limit ${fmtAmount(o.creditLimit)} ${cur}` : "No credit limit"}
        />
        <Tile
          label="Today"
          value={fmtCount(o.today.messages)}
          sub={`${fmtPct(o.today.deliveredPct)} delivered · ${fmtAmount(o.today.amount)} ${cur}`}
        />
        <Tile
          label="This month"
          value={fmtCount(o.thisMonth.messages)}
          sub={`${fmtPct(o.thisMonth.deliveredPct)} delivered · ${fmtAmount(o.thisMonth.amount)} ${cur}`}
        />
      </div>
      <div className="portal-columns">
        <section className="portal-card">
          <h2>Your connections</h2>
          <table className="portal-table">
            <thead>
              <tr>
                <th>Trunk</th>
                <th>Status</th>
                <th className="num">TPS limit</th>
              </tr>
            </thead>
            <tbody>
              {o.trunks.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <span className={`portal-dot ${t.connection === "up" ? "up" : "down"}`} />
                    {t.connection === "up" ? "Connected" : "Not connected"}
                  </td>
                  <td className="num">{fmtCount(t.tps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="portal-card">
          <h2>Last invoice</h2>
          {o.lastInvoice ? (
            <dl className="portal-kv">
              <dt>Number</dt>
              <dd>{o.lastInvoice.number}</dd>
              <dt>Date</dt>
              <dd>{o.lastInvoice.date}</dd>
              <dt>Amount due</dt>
              <dd className="num">
                {fmtAmount(o.lastInvoice.amount)} {cur}
              </dd>
              <dt>Due date</dt>
              <dd>{o.lastInvoice.dueDate ?? "—"}</dd>
            </dl>
          ) : (
            <p className="muted">No invoice yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- rates

const RATE_COLUMNS: Partial<Record<string, ColumnOverride<PortalRateRow>>> = {
  network: { render: (r) => r.network ?? <span className="muted">All networks</span> },
  rate: { render: (r) => <span className="num">{fmtRate(r.rate)}</span>, align: "right" },
  state: {
    render: (r) =>
      r.state === "upcoming" ? <span className="chip-tag">Upcoming</span> : <span className="muted">Current</span>,
  },
  changeType: {
    render: (r) =>
      r.changeType === "increase" ? (
        <span className="bad-text">Increase</span>
      ) : r.changeType === "decrease" ? (
        "Decrease"
      ) : (
        <span className="muted">{r.changeType === "new" ? "New" : r.changeType === "same" ? "Same" : "Closed"}</span>
      ),
  },
  blocked: {
    render: (r) => (r.blocked ? <span className="bad-text">Blocked</span> : <span className="muted">No</span>),
  },
};

function ListPage<Row extends { id: number }>({
  title,
  list,
  fetchPage,
  columns,
  initial,
  toolbar,
  aside,
}: {
  title: string;
  list: "portal_rates" | "portal_messages";
  fetchPage: (body: Parameters<typeof fetchRates>[0]) => Promise<ListPage<Row>>;
  columns: Partial<Record<string, ColumnOverride<Row>>>;
  initial?: Partial<GridState>;
  toolbar: (state: GridState, setState: (s: GridState) => void, total: number | null) => ReactNode;
  aside?: (row: Row, close: () => void) => ReactNode;
}) {
  const fields = usePortalFields(list);
  const [state, setState] = useState<GridState>(() => ({ ...emptyState(), ...initial }));
  const [active, setActive] = useState<Row | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [total, setTotal] = useState<number | null>(null);
  return (
    <div className="portal-page portal-list">
      <div className="portal-list-head">
        <h1>{title}</h1>
        {toolbar(state, setState, total)}
      </div>
      <div className="portal-list-body">
        {fields.data ? (
          <DataGrid<Row>
            list={list}
            fields={fields.data}
            state={state}
            onStateChange={setState}
            columns={columns}
            activeId={active?.id ?? null}
            onActiveChange={setActive}
            selected={selected}
            onSelectedChange={setSelected}
            fetchPage={fetchPage as never}
            onMeta={(m) => setTotal(m.total)}
          />
        ) : (
          <p className="muted">Loading…</p>
        )}
        {aside && active && <aside className="portal-card portal-aside">{aside(active, () => setActive(null))}</aside>}
      </div>
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <span className="portal-search">
      <Icon name="search" size={14} />
      <input type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

function Rates() {
  return (
    <ListPage<PortalRateRow>
      title="Rates"
      list="portal_rates"
      fetchPage={fetchRates}
      columns={RATE_COLUMNS}
      toolbar={(state, setState, total) => {
        const st = state.columns.state?.values?.[0] as string | undefined;
        const setSt = (v: string | null) => {
          const columns = { ...state.columns };
          if (v) columns.state = { field: "state", op: "in", values: [v] };
          else delete columns.state;
          setState({ ...state, columns });
        };
        return (
          <>
            <SearchBox
              value={state.search}
              onChange={(search) => setState({ ...state, search })}
              placeholder="Country, network or MCCMNC"
            />
            <div className="segmented small" role="radiogroup" aria-label="Rates shown">
              {(
                [
                  [null, "All"],
                  ["current", "Current"],
                  ["upcoming", "Upcoming"],
                ] as [string | null, string][]
              ).map(([v, label]) => (
                <button key={label} type="button" className={(st ?? null) === v ? "on" : ""} onClick={() => setSt(v)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="muted small fb-spacer">{total === null ? "" : `${fmtCount(total)} rates`}</span>
            <Button
              icon="download"
              variant="primary"
              onClick={() => void downloadRates({ ...toListQuery(state), limit: 4000, withTotal: false })}
            >
              Download rate sheet
            </Button>
          </>
        );
      }}
    />
  );
}

// ---------------------------------------------------------------- messages

const STATUS_TONE: Record<string, string> = { DELIVRD: "good", UNDELIV: "bad", REJECTD: "bad", EXPIRED: "bad" };
const MESSAGE_COLUMNS: Partial<Record<string, ColumnOverride<PortalMessageRow & { id: number }>>> = {
  status: {
    render: (r) => (
      <span className={STATUS_TONE[r.status] ? `${STATUS_TONE[r.status]}-text` : "muted"}>{r.status || "Pending"}</span>
    ),
  },
  rate: { render: (r) => <span className="num">{fmtRate(r.rate)}</span>, align: "right" },
  amount: { render: (r) => <span className="num">{fmtRate(r.amount)}</span>, align: "right" },
  messageText: { width: 320 },
};

function Messages() {
  const [period, setPeriod] = useState<Period>("today");
  const initial = useMemo(() => {
    const [a, b] = periodRange("today");
    return { columns: { submitTime: { field: "submitTime", op: "between" as const, values: [a, b] } } };
  }, []);
  return (
    <ListPage<PortalMessageRow & { id: number }>
      title="Messages"
      list="portal_messages"
      fetchPage={fetchMessages as never}
      columns={MESSAGE_COLUMNS}
      initial={initial}
      toolbar={(state, setState, total) => (
        <>
          <SearchBox
            value={state.search}
            onChange={(search) => setState({ ...state, search })}
            placeholder="Receiver, sender or message ID"
          />
          <div className="segmented small" role="radiogroup" aria-label="Period">
            {(
              [
                ["today", "Today"],
                ["yesterday", "Yesterday"],
                ["7d", "Last 7 days"],
                ["30d", "Last 30 days"],
              ] as [Period, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={period === v ? "on" : ""}
                onClick={() => {
                  setPeriod(v);
                  const [a, b] = periodRange(v);
                  setState({
                    ...state,
                    columns: { ...state.columns, submitTime: { field: "submitTime", op: "between", values: [a, b] } },
                  });
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="muted small fb-spacer">{total === null ? "" : `${fmtCount(total)} messages`}</span>
        </>
      )}
      aside={(m, close) => (
        <>
          <div className="portal-aside-head">
            <h2>Message</h2>
            <button type="button" className="toast-close" aria-label="Close" onClick={close}>
              <Icon name="x" size={13} />
            </button>
          </div>
          <dl className="portal-kv">
            <dt>Message ID</dt>
            <dd className="mono">{m.messageId}</dd>
            <dt>Sent</dt>
            <dd>{m.submitTime.slice(0, 19).replace("T", " ")} UTC</dd>
            <dt>Delivered</dt>
            <dd>{m.deliveryTime ? `${m.deliveryTime.slice(0, 19).replace("T", " ")} UTC` : "—"}</dd>
            <dt>Status</dt>
            <dd>
              {m.status || "Pending"}
              {m.errorCode && m.errorCode !== "000" ? ` · error ${m.errorCode}` : ""}
            </dd>
            <dt>From → to</dt>
            <dd>
              {m.senderId} → {m.receiver}
            </dd>
            <dt>Destination</dt>
            <dd>
              {m.country} · {m.mccmnc}
            </dd>
            <dt>Trunk</dt>
            <dd>{m.trunk ?? "—"}</dd>
            <dt>Parts</dt>
            <dd>{m.parts}</dd>
            <dt>Charged</dt>
            <dd className="num">
              {fmtRate(m.amount)} {m.currency}
            </dd>
          </dl>
          <h3 className="part-title">Text</h3>
          <p className="portal-text">{m.messageText || <span className="muted">Not kept</span>}</p>
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------- traffic

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function Traffic() {
  const [q, setQ] = useState<PortalTrafficQuery>(() => ({
    from: isoDay(new Date(Date.now() - 13 * 86_400_000)),
    to: isoDay(new Date()),
    groupBy: "day",
  }));
  const t = useTraffic(q);
  const colors = useChartColors();
  const cur = t.data?.currency ?? "";
  const option = useMemo(() => {
    const rows = t.data?.rows ?? [];
    return {
      grid: { left: 48, right: 48, top: 24, bottom: 28 },
      tooltip: { trigger: "axis" },
      legend: { top: 0, right: 0, textStyle: { color: colors.text } },
      xAxis: { type: "category", data: rows.map((r) => r.label), axisLabel: { color: colors.secondary } },
      yAxis: [
        { type: "value", axisLabel: { color: colors.secondary }, splitLine: { lineStyle: { color: colors.border } } },
        {
          type: "value",
          max: 100,
          axisLabel: { color: colors.secondary, formatter: "{value} %" },
          splitLine: { show: false },
        },
      ],
      series: [
        { name: "Messages", type: "bar", data: rows.map((r) => r.messages), itemStyle: { color: colors.accent } },
        {
          name: "Delivered %",
          type: "line",
          yAxisIndex: 1,
          data: rows.map((r) => r.deliveredPct),
          itemStyle: { color: colors.good },
          smooth: true,
        },
      ],
    };
  }, [t.data, colors]);
  return (
    <div className="portal-page">
      <div className="portal-list-head">
        <h1>Traffic</h1>
        <label className="portal-inline">
          From <input type="date" value={q.from} max={q.to} onChange={(e) => setQ({ ...q, from: e.target.value })} />
        </label>
        <label className="portal-inline">
          To <input type="date" value={q.to} min={q.from} onChange={(e) => setQ({ ...q, to: e.target.value })} />
        </label>
        <div className="segmented small" role="radiogroup" aria-label="Group by">
          {(
            [
              ["day", "By day"],
              ["country", "By country"],
              ["trunk", "By trunk"],
            ] as [PortalTrafficQuery["groupBy"], string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={q.groupBy === v ? "on" : ""}
              onClick={() => setQ({ ...q, groupBy: v })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {t.error && <p className="error-text">{problem(t.error)}</p>}
      {q.groupBy === "day" && (t.data?.rows.length ?? 0) > 0 && (
        <section className="portal-card">
          <Chart option={option} height={240} label="Messages and delivered % by day" />
        </section>
      )}
      <section className="portal-card portal-scroll">
        <table className="portal-table">
          <thead>
            <tr>
              <th>{q.groupBy === "day" ? "Day" : q.groupBy === "country" ? "Country" : "Trunk"}</th>
              <th className="num">Messages</th>
              <th className="num">Parts</th>
              <th className="num">Delivered</th>
              <th className="num">Failed</th>
              <th className="num">Delivered %</th>
              <th className="num">Amount ({cur})</th>
            </tr>
          </thead>
          <tbody>
            {t.data && (
              <tr className="portal-total">
                <td>Total</td>
                <td className="num">{fmtCount(t.data.total.messages)}</td>
                <td className="num">{fmtCount(t.data.total.parts)}</td>
                <td className="num">{fmtCount(t.data.total.delivered)}</td>
                <td className="num">{fmtCount(t.data.total.failed)}</td>
                <td className="num">{fmtPct(t.data.total.deliveredPct)}</td>
                <td className="num">{fmtAmount(t.data.total.amount)}</td>
              </tr>
            )}
            {t.data?.rows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td className="num">{fmtCount(r.messages)}</td>
                <td className="num">{fmtCount(r.parts)}</td>
                <td className="num">{fmtCount(r.delivered)}</td>
                <td className="num">{fmtCount(r.failed)}</td>
                <td className="num">{fmtPct(r.deliveredPct)}</td>
                <td className="num">{fmtAmount(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.data && !t.data.rows.length && <p className="muted pad">No traffic in this period.</p>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- shell

function Shell({ name, enterprise }: { name: string; enterprise: string }) {
  const signOut = useSignOut();
  const navigate = useNavigate();
  const [theme, toggle] = useTheme();
  return (
    <div className="portal">
      <header className="portal-top">
        <span className="portal-brand small-brand">
          <span className="portal-logo">
            <Icon name="send" size={15} />
          </span>
          <strong>{enterprise}</strong>
        </span>
        <nav className="portal-nav">
          <NavLink to="/portal" end>
            Overview
          </NavLink>
          <NavLink to="/portal/rates">Rates</NavLink>
          <NavLink to="/portal/traffic">Traffic</NavLink>
          <NavLink to="/portal/messages">Messages</NavLink>
        </nav>
        <span className="portal-user">
          <span className="muted small">{name}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate("/portal/password")}>
            Password
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={theme === "light" ? "Dark theme" : "Light theme"}
            onClick={toggle}
          >
            <Icon name={theme === "light" ? "moon" : "sun"} size={14} />
          </button>
          <button type="button" className="btn btn-sm btn-default" onClick={() => signOut.mutate()}>
            Sign out
          </button>
        </span>
      </header>
      <main className="portal-main">
        <Routes>
          <Route path="/portal" element={<Overview />} />
          <Route path="/portal/rates" element={<Rates />} />
          <Route path="/portal/traffic" element={<Traffic />} />
          <Route path="/portal/messages" element={<Messages />} />
          <Route
            path="/portal/password"
            element={
              <div className="portal-page">
                <ChangePassword forced={false} />
              </div>
            }
          />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function PortalApp() {
  useTheme();
  const session = usePortalSession();
  useEffect(() => {
    document.title = "Customer portal";
  }, []);
  if (session.isLoading) return <div className="portal-center muted">Loading…</div>;
  const s = session.data;
  if (!s) return <SignIn />;
  if (s.mustChangePassword)
    return (
      <div className="portal-center">
        <ChangePassword forced />
      </div>
    );
  return <Shell name={`${s.user.firstName} ${s.user.lastName}`} enterprise={s.enterprise.name} />;
}
