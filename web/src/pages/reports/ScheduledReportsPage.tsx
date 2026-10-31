// Schedule Report (§10): Info ID, Name, Status. Form: Report Template (a ready-made report or a saved
// Master Report view), Description, Name, Status, Business Company, Notification Email, CRON
// Interval / Frequency / Scheduler Expression (UTC, with the next runs), file type and Email Body.
// Run now e-mails it at once (Email Logs). Saves are undoable (§13.10); delete archives (§13.29).
import { useEffect, useState } from "react";
import type { CronPreview, ScheduledReportInput, ScheduledReportRow } from "@sms/contract";
import { useMe, useViews } from "../../api/hooks";
import { previewCron, useReportPresets, useRunScheduledReport, useSaveScheduledReport } from "../../api/masterReports";
import { useReference, useRestore } from "../../api/records";
import { FormField, SelectField, TextArea, TextField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ask, toast } from "../../ui/feedback";
import { Button, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen, RecordActions, RecordDialog } from "../reference/shared";
import { parseEmails } from "../switch/tools/toolsModel";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../records/parts";

const page = pageForPath("/reports/scheduled")!;
const muted = (v: string) => <span className="muted">{v}</span>;

/** The expression the interval and frequency suggest (same as the backend's default). */
export function cronFor(interval: string, frequency: number): string {
  switch (interval) {
    case "minute":
      return `*/${frequency} * * * *`;
    case "hourly":
      return `0 */${frequency} * * *`;
    case "weekly":
      return "0 6 * * 1";
    case "monthly":
      return "0 6 1 * *";
    default:
      return frequency > 1 ? `0 6 */${frequency} * *` : "0 6 * * *";
  }
}

const blank = (businessCompanyId: number): ScheduledReportInput => ({
  name: "",
  description: null,
  templateKind: "preset",
  presetKey: "sales",
  viewId: null,
  teamDepartmentId: null,
  teamPeriod: null,
  status: "active",
  businessCompanyId,
  notificationEmails: [],
  cronInterval: "daily",
  cronFrequency: 1,
  cronExpression: "0 6 * * *",
  fileType: "excel",
  emailBody: "<p>Hello,</p><p>Attached: <b>{report}</b> for {from} to {to} UTC ({rows} rows).</p>",
});

function CronBox({ expression }: { expression: string }) {
  const [p, setP] = useState<CronPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(
      () =>
        void previewCron(expression)
          .then((r) => {
            setP(r);
            setError(null);
          })
          .catch((e) => {
            setP(null);
            setError(problemText(e));
          }),
      250,
    );
    return () => clearTimeout(t);
  }, [expression]);
  if (error) return <p className="tone-error small">{error}</p>;
  if (!p) return null;
  return (
    <p className="small muted">
      {p.description} · next:{" "}
      {p.runs
        .slice(0, 3)
        .map((r) => r.slice(0, 16).replace("T", " "))
        .join(", ")}{" "}
      UTC
    </p>
  );
}

function ScheduleDialog({ row, done }: { row: ScheduledReportRow | null; done: () => void }) {
  const ref = useReference();
  const presets = useReportPresets();
  const views = useViews("master_report");
  const form = useForm<ScheduledReportInput>(
    row
      ? {
          name: row.name,
          description: row.description,
          templateKind: row.templateKind,
          presetKey: row.presetKey,
          viewId: row.viewId,
          teamDepartmentId: row.teamDepartmentId ?? null,
          teamPeriod: row.teamPeriod ?? null,
          status: row.status,
          businessCompanyId: row.businessCompanyId,
          notificationEmails: row.notificationEmails,
          cronInterval: row.cronInterval,
          cronFrequency: row.cronFrequency,
          cronExpression: row.cronExpression,
          fileType: row.fileType,
          emailBody: row.emailBody,
        }
      : blank(ref.data?.businessCompanies[0]?.id ?? 1),
  );
  const [emails, setEmails] = useState(form.values.notificationEmails.join(", "));
  const save = useSaveScheduledReport();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  const setSchedule = (interval: string, frequency: number) => {
    form.set("cronInterval", interval);
    form.set("cronFrequency", frequency);
    form.set("cronExpression", cronFor(interval, frequency));
  };
  return (
    <RecordDialog
      form={form}
      title={row ? `Edit scheduled report ${row.name}` : "Add scheduled report"}
      saveLabel={row ? "Save" : "Add schedule"}
      saving={save.isPending}
      error={error}
      width={760}
      onClose={done}
      onSave={() => {
        const parsed = parseEmails(emails);
        if (parsed.invalid.length) return setError(`Not an e-mail address: ${parsed.invalid.join(", ")}`);
        save.mutate(
          { id: row?.id ?? null, input: { ...v, notificationEmails: parsed.emails } },
          {
            onSuccess: (r) => {
              if (r.change) notifySaved(r.change, `Saved scheduled report ${r.record.name}`);
              done();
            },
            onError: (e) => setError(form.fail(e)),
          },
        );
      }}
    >
      <SelectField
        form={form}
        path="templateKind"
        label="Report Template"
        required
        options={[
          { value: "preset", label: "Ready-made report" },
          { value: "view", label: "Saved Master Report view" },
          { value: "team", label: "Team report" },
        ]}
      />
      {v.templateKind === "team" ? (
        <>
          <SelectField
            form={form}
            path="teamPeriod"
            label="Each run covers"
            required
            options={[
              { value: "yesterday", label: "Yesterday" },
              { value: "last_7_days", label: "Last 7 days" },
              { value: "last_week", label: "Last week (weekly summary)" },
              { value: "last_month", label: "Last month" },
            ]}
          />
          <FormField label="Department" error={form.error("teamDepartmentId")}>
            <ListLookup<{ id: number; name: string }>
              list="departments"
              value={v.teamDepartmentId ?? null}
              onChange={(x) => form.set("teamDepartmentId", x?.id ?? null)}
              labelOf={(x) => x.name}
              placeholder="Everyone"
            />
          </FormField>
        </>
      ) : v.templateKind === "preset" ? (
        <SelectField
          form={form}
          path="presetKey"
          label="Report"
          required
          options={(presets.data?.presets ?? []).map((p) => ({ value: p.key, label: p.name }))}
        />
      ) : (
        <SelectField
          form={form}
          path="viewId"
          label="View"
          required
          options={(views.data ?? []).filter((x) => x.state.report).map((x) => ({ value: x.id, label: x.name }))}
          placeholder="Save a view on the Master Report first"
        />
      )}
      <TextField form={form} path="name" label="Schedule Report Name" required maxLength={120} />
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
      <TextField form={form} path="description" label="Description" maxLength={500} />
      <SelectField
        form={form}
        path="businessCompanyId"
        label="Business Company"
        required
        options={(ref.data?.businessCompanies ?? []).map((b) => ({ value: b.id, label: b.name }))}
      />
      <FormField label="Notification Email" required wide error={form.error("notificationEmails")}>
        <input
          value={emails}
          placeholder="team@example.net, manager@example.net"
          onChange={(e) => setEmails(e.target.value)}
        />
      </FormField>
      <FormField label="CRON Interval" required>
        <select value={v.cronInterval} onChange={(e) => setSchedule(e.target.value, v.cronFrequency)}>
          {["minute", "hourly", "daily", "weekly", "monthly"].map((i) => (
            <option key={i} value={i}>
              {i[0]!.toUpperCase() + i.slice(1)}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="CRON Frequency (every n)" required>
        <input
          type="number"
          min={1}
          max={59}
          value={v.cronFrequency}
          onChange={(e) => setSchedule(v.cronInterval, Math.max(1, Number(e.target.value)))}
        />
      </FormField>
      <TextField
        form={form}
        path="cronExpression"
        label="CRON Scheduler Expression (minute hour day month weekday, UTC)"
        required
        maxLength={100}
      />
      <div className="field wide">
        <CronBox expression={v.cronExpression} />
      </div>
      <SelectField
        form={form}
        path="fileType"
        label="File"
        required
        options={[
          { value: "excel", label: "Excel" },
          { value: "csv", label: "CSV" },
          { value: "pdf", label: "PDF" },
        ]}
      />
      <TextArea form={form} path="emailBody" label="Email Body (HTML; {report} {from} {to} {rows})" required rows={4} />
    </RecordDialog>
  );
}

const openDialog = (row: ScheduledReportRow | null) => ask<void>((d) => <ScheduleDialog row={row} done={() => d()} />);

export function ScheduledReportsPage() {
  const runNow = useRunScheduledReport();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const del = useDeleteRecord();
  const restore = useRestore("scheduled_report");
  const notifySaved = useNotifySaved();
  const run = (r: ScheduledReportRow) =>
    runNow.mutate(r.id, {
      onSuccess: (x) =>
        toast({
          tone: x.lastStatus === "sent" ? "good" : "error",
          message:
            x.lastStatus === "sent"
              ? `${x.name} sent to ${x.notificationEmails.join(", ")} · see Email Logs`
              : `${x.name} failed: ${x.lastError}`,
        }),
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  return (
    <ListScreen<ScheduledReportRow>
      list="scheduled_reports"
      noExport
      bulkDelete={{ noun: "scheduled report", restore: true }}
      page={page}
      noSelection
      historyScope={{ entityTypes: ["scheduled_report"] }}
      rowActions={(r) => [
        { label: "Edit", icon: "file", main: true, disabled: !!r.archivedAt, onSelect: () => void openDialog(r) },
        {
          label: "Run now",
          icon: "send",
          main: true,
          disabled: runNow.isPending || !!r.archivedAt,
          onSelect: () => run(r),
        },
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !admin || restore.isPending,
              ...(admin ? {} : { hint: "Deleted. An administrator can restore it." }),
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored scheduled report ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void del("scheduled_report", r.id, `Scheduled report ${r.name}`),
            },
      ]}
      primary={{ label: "Add", icon: "plus", onClick: () => void openDialog(null) }}
      columns={{
        id: { width: 90 },
        name: { width: 260, render: (r) => <strong>{r.name}</strong> },
        template: { width: 230 },
        status: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "active" ? "good" : "neutral"} />{" "}
              {r.status === "active" ? "Active" : "Inactive"}
            </span>
          ),
        },
        cronExpression: { width: 140, render: (r) => <span className="num">{r.cronExpression}</span> },
        nextRunAt: { width: 170, render: (r) => fmtWhen(r.nextRunAt) },
        lastRunAt: { width: 170, render: (r) => fmtWhen(r.lastRunAt) },
        lastStatus: {
          width: 110,
          render: (r) =>
            r.lastStatus ? (
              <span title={r.lastError ?? ""}>
                <StatusDot tone={r.lastStatus === "sent" ? "good" : "error"} />{" "}
                {r.lastStatus === "sent" ? "Sent" : "Failed"}
              </span>
            ) : (
              muted("—")
            ),
        },
      }}
      rowClass={(r) => (r.archivedAt ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.template} · {r.cronExpression} UTC
            </span>
          </>
        ),
        sections: [
          {
            key: "schedule",
            label: "Schedule",
            actions: (
              <>
                <Button small icon="send" disabled={runNow.isPending || !!r.archivedAt} onClick={() => run(r)}>
                  Run now
                </Button>
                <RecordActions
                  kind="scheduled_report"
                  id={r.id}
                  name={`Scheduled report ${r.name}`}
                  archived={!!r.archivedAt}
                  onEdit={() => void openDialog(r)}
                />
              </>
            ),
            content: (
              <dl className="kv">
                <dt>Report</dt>
                <dd>{r.template}</dd>
                <dt>Sends to</dt>
                <dd>{r.notificationEmails.join(", ")}</dd>
                <dt>From</dt>
                <dd>{r.businessCompany}</dd>
                <dt>Schedule</dt>
                <dd>
                  <span className="num">{r.cronExpression}</span> (UTC) · next {fmtWhen(r.nextRunAt)}
                </dd>
                <dt>File</dt>
                <dd>{r.fileType.toUpperCase()}</dd>
                <dt>Last run</dt>
                <dd>
                  {fmtWhen(r.lastRunAt)} {r.lastStatus && `· ${r.lastStatus}`}{" "}
                  {r.lastError && <span className="tone-error">{r.lastError}</span>}
                </dd>
                {r.description && (
                  <>
                    <dt>Description</dt>
                    <dd>{r.description}</dd>
                  </>
                )}
              </dl>
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["scheduled_report"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
