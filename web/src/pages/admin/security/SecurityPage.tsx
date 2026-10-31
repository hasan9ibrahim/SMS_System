// Admin › Security settings (§13.28): the password policy on the left (lifetime, reminder days, temporary
// password hours, minimum length, history; 2FA and the leaked-password check always on), and on the right
// staff and portal users by password state (each opens the Users list filtered on it), users without
// 2FA, failed attempts, reminders with Send due reminders now, and the latest security events.
import { useState } from "react";
import type { PasswordState, PasswordStateCounts, SecurityEvent, SecuritySettingsInput } from "@sms/contract";
import { useMe } from "../../../api/hooks";
import { useRunReminders, useSaveSecuritySettings, useSecurityOverview } from "../../../api/security";
import { emptyState, encodeState } from "../../../grid/filterModel";
import { useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { PageHeader } from "../../../page/PageHeader";
import { useTabNavigate } from "../../../shell/tabContext";
import { toast } from "../../../ui/feedback";
import { Icon } from "../../../ui/Icon";
import { Button, StatusDot } from "../../../ui/primitives";
import { VirtualTable, type VColumn } from "../../lookup/VirtualTable";
import { fmtWhen } from "../../reference/shared";
import { problemText } from "../../routing/dialogs";
import {
  addReminderDay,
  LIMITS,
  policyLine,
  removeReminderDay,
  sameSettings,
  settingsInput,
  settingsProblems,
  STATES,
} from "./securityModel";

const page = pageForPath("/admin/security")!;
const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
const int = (n: number) => n.toLocaleString("en-US");

const COUNT_KEY: Record<PasswordState, keyof PasswordStateCounts> = {
  ok: "ok",
  expiring: "expiring",
  expired: "expired",
  temporary: "temporary",
  must_change: "mustChange",
};
const EVENT_TONE: Record<SecurityEvent["kind"], "good" | "warning" | "error" | "neutral"> = {
  changed: "good",
  failed: "error",
  forced: "warning",
  temporary: "warning",
  reminder: "neutral",
  settings: "neutral",
};

function NumberField({
  label,
  hint,
  value,
  range,
  unit,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  range: readonly [number, number];
  unit: string;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="sec-locked">
        <input
          type="number"
          min={range[0]}
          max={range[1]}
          step={1}
          value={Number.isNaN(value) ? "" : value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
          style={{ width: 90 }}
        />
        <span className="muted small">{unit}</span>
      </div>
      <small>{hint}</small>
    </label>
  );
}

function PolicyCard() {
  const o = useSecurityOverview();
  const save = useSaveSecuritySettings();
  const notifySaved = useNotifySaved();
  const { data: me } = useMe();
  const isAdmin = !!me?.permissions.includes("*");
  const [draft, setDraft] = useState<SecuritySettingsInput | null>(null);
  const [newDay, setNewDay] = useState("");
  const s = o.data?.settings;
  if (!s) return <div className="team-card muted small">{o.isError ? problemText(o.error) : "Loading…"}</div>;
  const base = settingsInput(s);
  const d = draft ?? base;
  const set = (patch: Partial<SecuritySettingsInput>) => setDraft({ ...d, ...patch });
  const problems = settingsProblems(d);
  const dirty = !sameSettings(d, base);
  const addDay = () => {
    set({ reminderDays: addReminderDay(d.reminderDays, Number(newDay)) });
    setNewDay("");
  };
  return (
    <div className="team-card">
      <div className="team-card-head">
        <strong>Password policy</strong>
        <span className="muted small">{policyLine(d)}</span>
      </div>
      <div className="form-grid cols-2">
        <NumberField
          label="Password lifetime"
          hint="Can't be turned off."
          value={d.passwordLifetimeDays}
          range={LIMITS.passwordLifetimeDays}
          unit="days"
          disabled={!isAdmin}
          onChange={(v) => set({ passwordLifetimeDays: v })}
        />
        <NumberField
          label="Temporary password"
          hint="How long an admin-set password works."
          value={d.tempPasswordHours}
          range={LIMITS.tempPasswordHours}
          unit="hours"
          disabled={!isAdmin}
          onChange={(v) => set({ tempPasswordHours: v })}
        />
        <NumberField
          label="Minimum length"
          hint="Never below 12."
          value={d.minPasswordLength}
          range={LIMITS.minPasswordLength}
          unit="characters"
          disabled={!isAdmin}
          onChange={(v) => set({ minPasswordLength: v })}
        />
        <NumberField
          label="Password history"
          hint="The last N can't be reused. Never below 12."
          value={d.passwordHistory}
          range={LIMITS.passwordHistory}
          unit="passwords"
          disabled={!isAdmin}
          onChange={(v) => set({ passwordHistory: v })}
        />
      </div>
      <div className="field">
        <span>Reminders before expiry</span>
        <div className="sec-chips">
          {d.reminderDays.map((day) => (
            <span key={day} className="sec-chip">
              {day} day{day === 1 ? "" : "s"}
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove the ${day}-day reminder`}
                disabled={!isAdmin}
                onClick={() => set({ reminderDays: removeReminderDay(d.reminderDays, day) })}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <input
            type="number"
            min={1}
            max={30}
            placeholder="Day"
            aria-label="Add a reminder day"
            value={newDay}
            disabled={!isAdmin || d.reminderDays.length >= 5}
            onChange={(e) => setNewDay(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addDay()}
            style={{ width: 70 }}
          />
          <Button small icon="plus" disabled={!isAdmin || !newDay} onClick={addDay}>
            Add
          </Button>
        </div>
        <small>The e-mail never holds a password or a sign-in link.</small>
      </div>
      <div className="field">
        <span>Always on</span>
        <div className="sec-locked small">
          <Icon name="lock" size={13} /> 2FA at every login and on every password change
        </div>
        <div className="sec-locked small">
          <Icon name="lock" size={13} /> Not the username or name · not on the known-leaked list (
          {int(s.leakedListSize)} entries)
        </div>
        <div className="sec-locked small">
          <Icon name="lock" size={13} /> A password change signs the user out of every other session
        </div>
      </div>
      <div className="mig-actions">
        <span className="muted small mig-foot">
          {problems[0] ?? (s.updatedBy ? `Last changed by ${s.updatedBy}, ${fmtWhen(s.updatedAt)}` : "")}
        </span>
        <Button disabled={!dirty} onClick={() => setDraft(null)}>
          Reset
        </Button>
        <Button
          variant="primary"
          icon="save"
          disabled={!isAdmin || !dirty || problems.length > 0 || save.isPending}
          title={isAdmin ? undefined : "Administrators only"}
          onClick={() =>
            save.mutate(d, {
              onSuccess: (r) => {
                setDraft(null);
                if (r.change) notifySaved(r.change, "Security settings saved");
              },
              onError: fail,
            })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function StatesCard() {
  const o = useSecurityOverview();
  const navigate = useTabNavigate();
  const run = useRunReminders();
  const data = o.data;
  if (!data) return null;
  const usersBy = (state: PasswordState, portal: boolean) =>
    navigate(
      `${portal ? "/admin/customer-portal" : "/admin/users"}?g=${encodeState({
        ...emptyState(),
        columns: portal ? {} : { passwordState: { field: "passwordState", op: "in", values: [state] } },
      })}`,
      { newTab: true },
    );
  return (
    <div className="team-card">
      <div className="team-card-head">
        <strong>Passwords now</strong>
        <span className="muted small">active users</span>
      </div>
      <table className="sec-states">
        <thead>
          <tr>
            <th>State</th>
            <th>Staff</th>
            <th>Portal users</th>
          </tr>
        </thead>
        <tbody>
          {STATES.map((st) => (
            <tr key={st.key}>
              <td>
                <StatusDot tone={st.tone} hollow={st.key === "ok"} /> {st.label}
              </td>
              <td>
                <button type="button" className="link" onClick={() => usersBy(st.key, false)}>
                  {int(data.staff[COUNT_KEY[st.key]])}
                </button>
              </td>
              <td>{int(data.portal[COUNT_KEY[st.key]])}</td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>Total</strong>
            </td>
            <td>{int(data.staff.total)}</td>
            <td>{int(data.portal.total)}</td>
          </tr>
        </tbody>
      </table>
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-label">Staff without 2FA</span>
          <span className={`stat-value${data.staff.without2fa ? " tone-warning" : ""}`}>
            {int(data.staff.without2fa)}
          </span>
          <span className="muted small">set it up under Users</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Failed changes, 24 h</span>
          <span className={`stat-value${data.failedAttempts24h ? " tone-error" : ""}`}>
            {int(data.failedAttempts24h)}
          </span>
          <span className="muted small">wrong password or 2FA code</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Reminders, 7 days</span>
          <span className="stat-value">{int(data.remindersSent7d)}</span>
          <span className="muted small">
            {data.lastReminderRunAt ? `last run ${fmtWhen(data.lastReminderRunAt)}` : "not run yet"}
          </span>
        </div>
      </div>
      <div className="mig-actions">
        <Button
          icon="mail"
          disabled={run.isPending}
          title="Normally hourly"
          onClick={() =>
            run.mutate(undefined, {
              onSuccess: (r) =>
                toast({
                  tone: "good",
                  message: r.sent
                    ? `${r.sent} reminder${r.sent === 1 ? "" : "s"} sent${r.skipped ? ` · ${r.skipped} already reminded` : ""}`
                    : "No reminder is due",
                }),
              onError: fail,
            })
          }
        >
          Send due reminders now
        </Button>
      </div>
    </div>
  );
}

function EventsCard() {
  const o = useSecurityOverview();
  const rows = o.data?.events ?? [];
  const columns: VColumn<SecurityEvent>[] = [
    {
      key: "kind",
      header: "",
      width: 28,
      render: (e) => <StatusDot tone={EVENT_TONE[e.kind]} hollow={EVENT_TONE[e.kind] === "neutral"} label={e.kind} />,
    },
    { key: "at", header: "When", width: 165, render: (e) => fmtWhen(e.at) },
    {
      key: "user",
      header: "User",
      width: 180,
      render: (e) => (
        <>
          {e.userName ?? "—"}
          {e.portal && <span className="muted small"> · portal</span>}
        </>
      ),
    },
    { key: "what", header: "What", width: 320, render: (e) => <span title={e.summary}>{e.summary}</span> },
    { key: "ip", header: "IP", width: 130, render: (e) => e.ip ?? "—" },
  ];
  return (
    <div className="team-card sec-events">
      <div className="team-card-head">
        <strong>Latest security events</strong>
        <span className="muted small">
          passwords are never stored or shown
        </span>
      </div>
      <VirtualTable<SecurityEvent>
        label="Security events"
        rows={rows}
        columns={columns}
        rowKey={(e) => e.id}
        rowHeight={30}
        empty={o.isPending ? "Loading…" : "No event yet"}
      />
    </div>
  );
}

export function SecurityPage() {
  const navigate = useTabNavigate();
  return (
    <div className="page team-page">
      <PageHeader
        page={page}
        actions={
          <Button
            icon="users"
            onClick={() => navigate("/admin/users")}
            title="Force change now and temporary passwords"
          >
            Users
          </Button>
        }
      />
      <div className="sec-body">
        <div className="sec-col">
          <PolicyCard />
        </div>
        <div className="sec-col">
          <StatesCard />
          <EventsCard />
        </div>
      </div>
    </div>
  );
}
