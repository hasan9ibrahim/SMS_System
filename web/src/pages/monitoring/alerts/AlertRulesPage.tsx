// Alert Rules (§13.6, §13.7): Add, Edit, Clone, Enable / Disable, Delete, Test. Grid: Name, Scope,
// Metric, Condition, Severity, Channels, Status, Last Triggered, Updated By. The form covers scope,
// metric, condition (fixed value, % change against the previous window / yesterday / last week,
// started / stopped sending, bind down), window and minimum sample, active hours, severity, who is
// notified and how (pop-up, sound, e-mail with extra addresses and the partner's contact), repeat,
// cooldown and recovery notice. Test evaluates the form on live traffic without raising anything.
import { useCan } from "../../../api/access";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AlertRuleInput, AlertRuleRow, AlertRuleTest, DepartmentRow, UserRow } from "@sms/contract";
import { usePickRows } from "../../../api/admin";
import { fetchListPage, useMe } from "../../../api/hooks";
import { useRestore } from "../../../api/records";
import { testAlertRule, useCloneAlertRule, useSaveAlertRule, useSetAlertRuleStatus } from "../../../api/alerts";
import { emptyState, encodeState } from "../../../grid/filterModel";
import { FormField, NumberField, SelectField, TextField, useForm, type FormApi } from "../../../form/form";
import { HistoryList, useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { isAdminUser, useDeleteRecord } from "../../../records/parts";
import { useTabNavigate } from "../../../shell/tabContext";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen, RecordActions } from "../../reference/shared";
import { parseEmails } from "../../switch/tools/toolsModel";
import { Kv, statusCell } from "../../admin/parts";
import {
  activeHoursLabel,
  blankRule,
  channelsLabel,
  CONDITIONS,
  DAYS,
  METRIC_SHORT,
  METRICS,
  needsBaseline,
  needsValue,
  ruleInput,
  SCOPES,
  SEVERITY_LABEL,
} from "./alertsModel";
import { IdChips, severityCell } from "./parts";

const page = pageForPath("/monitoring/alert-rules")!;
const SCOPE_LIST = {
  customer: "enterprises",
  vendor: "enterprises",
  customer_trunk: "customer_trunks",
  vendor_trunk: "vendor_trunks",
  product_category: "product_categories",
} as const;

function TestResult({ result }: { result: AlertRuleTest }) {
  return (
    <div className="rule-test">
      <strong>
        {result.firing ? `${result.firing} would fire now` : "Nothing would fire now"} · {fmtWhen(result.evaluatedAt)}
      </strong>
      <table className="simple-table">
        <thead>
          <tr>
            <th>Scope</th>
            <th>Now</th>
            <th>Baseline</th>
            <th>Messages</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {result.entities.slice(0, 12).map((e) => (
            <tr key={e.name}>
              <td>{e.name}</td>
              <td className="num">{e.value ?? "—"}</td>
              <td className="num">{e.baseline ?? "—"}</td>
              <td className="num">{e.sample.toLocaleString("en-US")}</td>
              <td>
                <StatusDot tone={e.firing ? "error" : "good"} /> {e.reason}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.entities.length > 12 && <p className="muted small">{result.entities.length - 12} more not shown.</p>}
    </div>
  );
}

function ScopeFields({ form }: { form: FormApi<AlertRuleInput> }) {
  const v = form.values;
  const def = SCOPES.find((s) => s.value === v.scope.kind)!;
  return (
    <>
      <SelectField
        form={form}
        path="scope.kind"
        label="Scope"
        required
        options={SCOPES.map((s) => ({ value: s.value, label: s.label }))}
      />
      {def.picks === "ids" && (
        <FormField
          label={`${def.label} (empty = each one)`}
          wide
          error={form.error("scope.ids")}
          hint={v.scope.kind === "product_category" ? "Choose at least one" : "Each chosen one is watched on its own"}
        >
          <IdChips
            list={SCOPE_LIST[v.scope.kind as keyof typeof SCOPE_LIST]}
            ids={v.scope.ids}
            onChange={(ids) => form.set("scope.ids", ids)}
            placeholder="Add…"
          />
        </FormField>
      )}
      {def.picks === "values" && (
        <FormField label={`${def.label}, comma-separated`} wide required error={form.error("scope.values")}>
          <input
            value={v.scope.values.join(", ")}
            onChange={(e) =>
              form.set(
                "scope.values",
                e.target.value
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              )
            }
            placeholder={
              v.scope.kind === "country" ? "NG, KE" : v.scope.kind === "mccmnc" ? "62130, 63902" : "BANKALERT"
            }
          />
        </FormField>
      )}
    </>
  );
}

function RuleDialog({ row, done }: { row: AlertRuleRow | null; done: () => void }) {
  const form = useForm<AlertRuleInput>(row ? ruleInput(row) : blankRule());
  const save = useSaveAlertRule();
  const notifySaved = useNotifySaved();
  const departments = usePickRows<DepartmentRow>("departments");
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<AlertRuleTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [emails, setEmails] = useState((row?.emailAddresses ?? []).join(", "));
  const v = form.values;
  const t = v.condition.type;
  const input = (): AlertRuleInput => ({ ...v, emailAddresses: parseEmails(emails).emails });
  const badEmails = parseEmails(emails).invalid;
  const runTest = () => {
    setTesting(true);
    testAlertRule(input())
      .then(setTest, (e: unknown) => setError(form.fail(e)))
      .finally(() => setTesting(false));
  };
  return (
    <Modal
      title={row ? `Edit ${row.name}` : "Add alert rule"}
      width={1000}
      onClose={done}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button icon="play" disabled={testing} onClick={runTest}>
            Test on live traffic
          </Button>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            disabled={save.isPending || badEmails.length > 0}
            onClick={() =>
              save.mutate(
                { id: row?.id ?? null, input: input() },
                {
                  onSuccess: (r) => {
                    if (r.change) notifySaved(r.change, `Saved ${r.record.name}`);
                    done();
                  },
                  onError: (e) => setError(form.fail(e)),
                },
              )
            }
          >
            {row ? "Save" : "Add rule"}
          </Button>
        </>
      }
    >
      <div className="rule-form">
        <section>
          <h3 className="part-title">Rule</h3>
          <div className="fgrid cols-3">
            <TextField form={form} path="name" label="Name" required maxLength={120} />
            <SelectField
              form={form}
              path="status"
              label="Status"
              required
              options={[
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" },
              ]}
            />
            <SelectField
              form={form}
              path="severity"
              label="Severity"
              required
              options={[
                { value: "info", label: "Info" },
                { value: "warning", label: "Warning" },
                { value: "critical", label: "Critical" },
              ]}
            />
            <ScopeFields form={form} />
          </div>
        </section>
        <section>
          <h3 className="part-title">What to watch</h3>
          <div className="fgrid cols-3">
            <SelectField
              form={form}
              path="metric"
              label="Metric"
              required
              options={METRICS.map((m) => ({ value: m.value, label: m.label }))}
            />
            <SelectField
              form={form}
              path="condition.type"
              label="Condition"
              required
              options={CONDITIONS.map((c) => ({ value: c.value, label: c.label }))}
            />
            {needsValue(t) && (
              <NumberField
                form={form}
                path="condition.value"
                label={needsBaseline(t) ? "Change (%)" : "Value"}
                required
                min={0}
                step={0.1}
              />
            )}
            {needsBaseline(t) && (
              <SelectField
                form={form}
                path="condition.baseline"
                label="Compared with"
                required
                options={[
                  { value: "previous_window", label: "The previous window" },
                  { value: "yesterday", label: "Same time yesterday" },
                  { value: "last_week", label: "Same weekday last week" },
                ]}
              />
            )}
            {t !== "bind_down" && v.metric !== "bind_status" && (
              <>
                <SelectField
                  form={form}
                  path="windowMinutes"
                  label="Evaluate over"
                  required
                  options={[1, 5, 15, 30, 60].map((m) => ({ value: m, label: `${m} min` }))}
                />
                <NumberField
                  form={form}
                  path="minSample"
                  label="Only with at least (messages)"
                  min={0}
                  step={1}
                  hint="Avoids noise on tiny volumes"
                />
              </>
            )}
          </div>
          <div className="fgrid cols-3">
            <FormField
              label="Active hours (UTC)"
              wide
              error={form.error("activeHours.days") ?? form.error("activeHours.toHour")}
            >
              <div className="hours-row">
                <label className="toggle-inline">
                  <input
                    type="checkbox"
                    checked={v.activeHours.always}
                    onChange={(e) => form.set("activeHours.always", e.target.checked)}
                  />
                  Always
                </label>
                {!v.activeHours.always && (
                  <>
                    {DAYS.map((d, i) => (
                      <label key={d} className="toggle-inline">
                        <input
                          type="checkbox"
                          checked={v.activeHours.days.includes(i)}
                          onChange={(e) =>
                            form.set(
                              "activeHours.days",
                              e.target.checked
                                ? [...v.activeHours.days, i].sort()
                                : v.activeHours.days.filter((x) => x !== i),
                            )
                          }
                        />
                        {d}
                      </label>
                    ))}
                    <select
                      aria-label="From hour"
                      value={v.activeHours.fromHour}
                      onChange={(e) => form.set("activeHours.fromHour", Number(e.target.value))}
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, "0")}:00
                        </option>
                      ))}
                    </select>
                    to
                    <select
                      aria-label="To hour"
                      value={v.activeHours.toHour}
                      onChange={(e) => form.set("activeHours.toHour", Number(e.target.value))}
                    >
                      {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, "0")}:00
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </FormField>
          </div>
        </section>
        <section>
          <h3 className="part-title">Notify</h3>
          <div className="fgrid cols-3">
            <FormField label="How" error={form.error("channels")}>
              <div className="check-row">
                {(["popup", "sound", "email"] as const).map((k) => (
                  <label key={k} className="toggle-inline">
                    <input
                      type="checkbox"
                      checked={v.channels[k]}
                      onChange={(e) => form.set(`channels.${k}`, e.target.checked)}
                    />
                    {k === "popup" ? "Pop-up" : k === "sound" ? "Sound" : "E-mail"}
                  </label>
                ))}
              </div>
            </FormField>
            <FormField label="Users (none and no department = everyone)" wide>
              <IdChips
                list="users"
                ids={v.notifyUserIds}
                onChange={(ids) => form.set("notifyUserIds", ids)}
                placeholder="Add a user…"
                detailOf={(u) => (u as unknown as UserRow).username ?? ""}
              />
            </FormField>
            <FormField label="Departments" wide>
              <div className="check-row">
                {(departments.data ?? []).map((d) => (
                  <label key={d.id} className="toggle-inline">
                    <input
                      type="checkbox"
                      checked={v.notifyDepartmentIds.includes(d.id)}
                      onChange={(e) =>
                        form.set(
                          "notifyDepartmentIds",
                          e.target.checked
                            ? [...v.notifyDepartmentIds, d.id]
                            : v.notifyDepartmentIds.filter((x) => x !== d.id),
                        )
                      }
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            </FormField>
            {v.channels.email && (
              <>
                <FormField
                  label="More e-mail addresses"
                  wide
                  error={
                    badEmails.length ? `Not an e-mail address: ${badEmails.join(", ")}` : form.error("emailAddresses")
                  }
                >
                  <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="noc@company.example" />
                </FormField>
                <SelectField
                  form={form}
                  path="partnerContactType"
                  label="Also e-mail the partner's contact"
                  options={[
                    { value: "technical", label: "Technical" },
                    { value: "commercial", label: "Commercial" },
                    { value: "rates", label: "Rates" },
                    { value: "finance", label: "Finance" },
                  ]}
                  placeholder="No (internal alert)"
                />
              </>
            )}
          </div>
        </section>
        <section>
          <h3 className="part-title">Repeat and recovery</h3>
          <div className="fgrid cols-3">
            <NumberField
              form={form}
              path="repeatMinutes"
              label="Re-alert every (min)"
              min={1}
              max={1440}
              step={1}
              hint="Empty = alert once"
            />
            <NumberField
              form={form}
              path="cooldownMinutes"
              label="Quiet after recovery (min)"
              required
              min={0}
              max={1440}
              step={1}
            />
            <FormField label="Recovery">
              <label className="toggle-inline">
                <input
                  type="checkbox"
                  checked={v.recoveryNotice}
                  onChange={(e) => form.set("recoveryNotice", e.target.checked)}
                />
                Send an OK notice when it is back to normal
              </label>
            </FormField>
          </div>
        </section>
        {test && <TestResult result={test} />}
      </div>
    </Modal>
  );
}

const openDialog = (row: AlertRuleRow | null) => ask<void>((d) => <RuleDialog row={row} done={() => d()} />);

/** Enable / Disable, Clone and Incidents of one rule: the detail panel and the record actions share them. */
function useRuleHandlers() {
  const status = useSetAlertRuleStatus();
  const clone = useCloneAlertRule();
  const notifySaved = useNotifySaved();
  const navigate = useTabNavigate();
  return {
    statusPending: status.isPending,
    toggle: (r: AlertRuleRow) =>
      status.mutate(
        { id: r.id, status: r.status === "active" ? "inactive" : "active" },
        {
          onSuccess: (x) =>
            x.change && notifySaved(x.change, `${x.record.status === "active" ? "Enabled" : "Disabled"} ${r.name}`),
          onError: (e) => toast({ tone: "error", message: problemText(e) }),
        },
      ),
    clone: (r: AlertRuleRow) => {
      const name = window.prompt("Name of the copy", `${r.name} (copy)`);
      if (name?.trim())
        clone.mutate(
          { id: r.id, name: name.trim() },
          {
            onSuccess: (x) => x.change && notifySaved(x.change, `Cloned as ${x.record.name}`),
            onError: (e) => toast({ tone: "error", message: problemText(e) }),
          },
        );
    },
    incidents: (r: AlertRuleRow) =>
      navigate(
        `/monitoring/incidents?g=${encodeState({ ...emptyState(), columns: { ruleName: { field: "ruleName", op: "eq", value: r.name } } })}`,
      ),
  };
}

function RuleActions({ r }: { r: AlertRuleRow }) {
  const h = useRuleHandlers();
  if (r.archivedAt) return <RecordActions kind="alert_rule" id={r.id} name={r.name} archived />;
  return (
    <>
      <Button
        small
        icon={r.status === "active" ? "minus" : "check"}
        disabled={h.statusPending}
        onClick={() => h.toggle(r)}
      >
        {r.status === "active" ? "Disable" : "Enable"}
      </Button>
      <Button small icon="copy" onClick={() => h.clone(r)}>
        Clone
      </Button>
      <Button small icon="alert" onClick={() => h.incidents(r)}>
        Incidents
      </Button>
      <RecordActions kind="alert_rule" id={r.id} name={r.name} archived={false} onEdit={() => void openDialog(r)} />
    </>
  );
}

const SEV_TONE = { critical: "red", warning: "amber", info: "blue" } as const;

/** "11 open incidents" in the header, opening Incidents on the open ones (team trial round 4). */
function OpenIncidentsButton() {
  const navigate = useTabNavigate();
  const q = useQuery({
    queryKey: ["list", "incidents", "open-count"],
    queryFn: () =>
      fetchListPage<{ id: number }>("incidents", {
        filter: { logic: "and", conditions: [{ field: "state", op: "eq", value: "open" }] },
        limit: 1,
        withTotal: true,
      }),
    refetchInterval: 30_000,
  });
  const n = q.data?.total ?? 0;
  if (!n) return null;
  return (
    <button
      type="button"
      className="btn btn-default open-inc-btn"
      onClick={() =>
        navigate(
          `/monitoring/incidents?g=${encodeState({ ...emptyState(), columns: { state: { field: "state", op: "in", values: ["open"] } } })}`,
        )
      }
    >
      <span className="dot-mini" /> {n.toLocaleString("en-US")} open incident{n === 1 ? "" : "s"}
    </button>
  );
}

/** Summary tiles over the rules (team trial round 4): totals by severity and the ones that never fired. */
function AlertKpis() {
  const rules = useQuery({
    queryKey: ["list", "alert_rules", "kpis"],
    queryFn: () => fetchListPage<AlertRuleRow>("alert_rules", { limit: 200, withTotal: false }),
    staleTime: 30_000,
  });
  const rows = rules.data?.rows ?? [];
  const count = (f: (r: AlertRuleRow) => boolean) => rows.filter(f).length;
  const tiles: { label: string; value: number; note?: string; tone?: string }[] = [
    { label: "Rules", value: rows.length, note: `${count((r) => r.status === "inactive")} paused` },
    { label: "Critical", value: count((r) => r.severity === "critical"), tone: "red" },
    { label: "Warning", value: count((r) => r.severity === "warning"), tone: "amber" },
    { label: "Info", value: count((r) => r.severity === "info"), tone: "blue" },
    { label: "Never triggered", value: count((r) => !r.lastTriggeredAt) },
  ];
  return (
    <div className="kpi-tiles">
      {tiles.map((t) => (
        <div key={t.label} className="kpi-tile">
          <span className={`kpi-label${t.tone ? ` tone-dot ${t.tone}` : ""}`}>{t.label}</span>
          <span className="kpi-value">
            {rules.data ? t.value : "…"}
            {t.note && t.label === "Rules" && <small> · {t.note}</small>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AlertRulesPage() {
  const h = useRuleHandlers();
  const canIncidents = useCan("incidents");
  const { data: me } = useMe();
  const deleteOne = useDeleteRecord();
  const restore = useRestore("alert_rule");
  const notifySaved = useNotifySaved();
  const isAdmin = isAdminUser(me?.permissions);
  return (
    <ListScreen<AlertRuleRow>
      list="alert_rules"
      page={page}
      noSelection
      historyScope={{ entityTypes: ["alert_rule"] }}
      primary={{ label: "Add rule", icon: "plus", onClick: () => void openDialog(null) }}
      actions={canIncidents ? <OpenIncidentsButton /> : undefined}
      // Rules as cards (team trial round 4): a severity edge, the name with its severity and metric, the condition
      // and what it applies to; channels as tags; when it last fired with its open incidents; an Active box.
      rowHeight={78}
      above={<AlertKpis />}
      initialState={{ visible: ["name", "channels", "lastTriggeredAt", "status"] }}
      columns={{
        name: {
          width: 620,
          label: "Rule",
          render: (r) => (
            <span className="two-line rule-card-main">
              <span>
                <strong>{r.name}</strong>{" "}
                <span className={`chip-tag ${SEV_TONE[r.severity]}`}>{SEVERITY_LABEL[r.severity]}</span>{" "}
                <span className="chip-tag">{METRIC_SHORT[r.metric]}</span>
              </span>
              <span className="small">{r.conditionLabel}</span>
              <span className="muted small">Applies to: {r.scopeLabel}</span>
            </span>
          ),
        },
        scopeLabel: { width: 260 },
        metric: { width: 110, render: (r) => METRIC_SHORT[r.metric] },
        conditionType: { width: 320, render: (r) => r.conditionLabel },
        severity: { width: 110, render: (r) => severityCell(r.severity) },
        channels: {
          width: 260,
          render: (r) => (
            <span className="tag-row">
              {channelsLabel(r.channels)
                .split(", ")
                .filter((c) => c && c !== "—")
                .map((c) => (
                  <span key={c} className="chip-tag">
                    {c}
                  </span>
                ))}
            </span>
          ),
        },
        status: {
          width: 130,
          render: (r) => (
            <label className="toggle-inline rule-active" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={r.status === "active"}
                disabled={!!r.archivedAt || h.statusPending}
                onChange={() => h.toggle(r)}
              />
              <span className={r.status === "active" ? "tone-good strong" : "muted"}>
                {r.status === "active" ? "Active" : "Paused"}
              </span>
            </label>
          ),
        },
        lastTriggeredAt: {
          width: 260,
          label: "Last triggered",
          render: (r) => (
            <span className="two-line">
              {r.openIncidents > 0 && (
                <button
                  type="button"
                  className="chip-tag red open-inc"
                  onClick={(e) => {
                    e.stopPropagation();
                    h.incidents(r);
                  }}
                >
                  <span className="dot-mini" />
                  {r.openIncidents} open · view
                </button>
              )}
              <span className="muted small">
                {r.lastTriggeredAt ? `Last triggered ${fmtWhen(r.lastTriggeredAt)}` : "Never triggered"}
              </span>
              {r.updatedBy && <span className="muted small">by {r.updatedBy}</span>}
            </span>
          ),
        },
        openIncidents: {
          width: 80,
          align: "right",
          render: (r) => <span className={`num${r.openIncidents ? " tone-error" : ""}`}>{r.openIncidents}</span>,
        },
        updatedBy: { width: 140 },
      }}
      rowClass={(r) =>
        `rule-row sev-${r.severity}${r.archivedAt || r.status === "inactive" ? " row-muted" : ""}${r.openIncidents ? " has-open" : ""}`
      }
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      rowActions={(r) => {
        const gone = r.archivedAt ? "Deleted rule" : undefined;
        return [
          { label: "Edit", icon: "file", main: true, disabled: !!gone, hint: gone, onSelect: () => void openDialog(r) },
          { label: "Clone", icon: "copy", disabled: !!gone, hint: gone, onSelect: () => h.clone(r) },
          {
            label: r.status === "active" ? "Disable" : "Enable",
            icon: r.status === "active" ? "minus" : "check",
            disabled: !!gone || h.statusPending,
            hint: gone,
            onSelect: () => h.toggle(r),
          },
          { label: "Incidents", icon: "alert", onSelect: () => h.incidents(r) },
          "separator",
          r.archivedAt
            ? {
                label: "Restore",
                icon: "undo",
                disabled: !isAdmin || restore.isPending,
                hint: isAdmin ? undefined : "Deleted. An administrator can restore it.",
                onSelect: () =>
                  restore.mutate(r.id, {
                    onSuccess: (res) => res.change && notifySaved(res.change, `Restored ${r.name}`),
                    onError: (e) => toast({ tone: "error", message: problemText(e) }),
                  }),
              }
            : {
                label: "Delete",
                icon: "trash",
                danger: true,
                onSelect: () => void deleteOne("alert_rule", r.id, r.name),
              },
        ];
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.scopeLabel} · {r.conditionLabel}
            </span>
          </>
        ),
        sections: [
          {
            key: "rule",
            label: "Rule",
            actions: <RuleActions r={r} />,
            content: (
              <Kv
                items={[
                  ["Scope", r.scopeLabel],
                  ["Condition", r.conditionLabel],
                  ["Severity", severityCell(r.severity)],
                  ["Active hours", activeHoursLabel(r.activeHours)],
                  ["Notify", channelsLabel(r.channels)],
                  [
                    "Who",
                    r.notifyUserIds.length || r.notifyDepartmentIds.length
                      ? `${r.notifyUserIds.length} user(s), ${r.notifyDepartmentIds.length} department(s)`
                      : "Everyone",
                  ],
                  [
                    "E-mail also to",
                    [...r.emailAddresses, r.partnerContactType ? `partner's ${r.partnerContactType} contact` : ""]
                      .filter(Boolean)
                      .join(", ") || null,
                  ],
                  ["Repeat", r.repeatMinutes ? `every ${r.repeatMinutes} min while it lasts` : "once"],
                  ["After recovery", `${r.recoveryNotice ? "OK notice, then " : ""}quiet for ${r.cooldownMinutes} min`],
                  ["Last triggered", r.lastTriggeredAt ? fmtWhen(r.lastTriggeredAt) : "never"],
                  ["Incidents", `${r.openIncidents} open · ${r.incidents30d} in 30 days`],
                ]}
              />
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["alert_rule"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
