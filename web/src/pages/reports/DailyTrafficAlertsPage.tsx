// Daily Traffic Alert (§10): Info ID, Name, Status. Form: Name, Status, Business Company, Enterprise
// Contact Email (contact type), Enterprise, send hour and Email Body - yesterday's traffic summary
// per trunk e-mailed to the partner. Send now shows the e-mail. Saves are undoable (§13.10).
import { useState } from "react";
import type { DailyTrafficAlertInput, DailyTrafficAlertRow, Enterprise } from "@sms/contract";
import { useSaveDailyAlert, useSendDailyAlert } from "../../api/masterReports";
import { useMe } from "../../api/hooks";
import { useReference, useRestore } from "../../api/records";
import { FormField, NumberField, SelectField, TextArea, TextField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen, RecordActions, RecordDialog } from "../reference/shared";

const page = pageForPath("/reports/daily-traffic")!;
const CONTACTS = ["commercial", "technical", "rates", "finance"].map((v) => ({
  value: v,
  label: v[0]!.toUpperCase() + v.slice(1),
}));
const BODY =
  "Dear {enterprise} team,\n\nHere is your traffic summary for {date} (UTC):\n\n{summary}\n\nKind regards,\nAccount management, {company}";

function AlertDialog({ row, done }: { row: DailyTrafficAlertRow | null; done: () => void }) {
  const ref = useReference();
  const form = useForm<DailyTrafficAlertInput>(
    row
      ? {
          name: row.name,
          status: row.status,
          businessCompanyId: row.businessCompanyId,
          contactType: row.contactType,
          enterpriseId: row.enterpriseId,
          sendHour: row.sendHour,
          emailBody: row.emailBody,
        }
      : {
          name: "",
          status: "active",
          businessCompanyId: null,
          contactType: "commercial",
          enterpriseId: 0,
          sendHour: 6,
          emailBody: BODY,
        },
  );
  const save = useSaveDailyAlert();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  return (
    <RecordDialog
      form={form}
      title={row ? `Edit ${row.name}` : "Add daily traffic alert"}
      saveLabel={row ? "Save" : "Add alert"}
      saving={save.isPending}
      error={error}
      width={720}
      onClose={done}
      onSave={() =>
        save.mutate(
          { id: row?.id ?? null, input: v },
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
      <FormField label="Enterprise" required error={form.error("enterpriseId")}>
        <ListLookup<Enterprise>
          list="enterprises"
          value={v.enterpriseId || null}
          onChange={(e) => {
            form.set("enterpriseId", e?.id ?? 0);
            if (e && !v.name) form.set("name", `${e.name} – daily summary`);
          }}
          labelOf={(e) => e.name}
          detailOf={(e) => `${e.alias} · ${e.type}`}
          placeholder={row?.enterprise ?? "Enterprise name…"}
        />
      </FormField>
      <SelectField form={form} path="contactType" label="Enterprise Contact Email" required options={CONTACTS} />
      <SelectField
        form={form}
        path="businessCompanyId"
        label="Business Company"
        options={(ref.data?.businessCompanies ?? []).map((b) => ({ value: b.id, label: b.name }))}
        placeholder="The enterprise's own"
      />
      <NumberField form={form} path="sendHour" label="Send hour (UTC)" required min={0} max={23} step={1} />
      <TextArea
        form={form}
        path="emailBody"
        label="Email Body ({enterprise} {date} {summary} {company})"
        required
        rows={6}
      />
    </RecordDialog>
  );
}

const openDialog = (row: DailyTrafficAlertRow | null) => ask<void>((d) => <AlertDialog row={row} done={() => d()} />);

function SentDialog({
  mail,
  done,
}: {
  mail: { recipients: string[]; subject: string; body: string };
  done: () => void;
}) {
  return (
    <Modal title="Daily traffic alert sent" width={680} onClose={done} footer={<Button onClick={done}>Close</Button>}>
      <div className="mail-preview">
        <div className="small">
          <strong>To:</strong>{" "}
          {mail.recipients.join(", ") || <span className="tone-error">no contact (logged as failed)</span>}
        </div>
        <div className="small">
          <strong>Subject:</strong> {mail.subject}
        </div>
        <pre className="mono-pre">{mail.body}</pre>
      </div>
    </Modal>
  );
}

export function DailyTrafficAlertsPage() {
  const send = useSendDailyAlert();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const del = useDeleteRecord();
  const restore = useRestore("daily_traffic_alert");
  const notifySaved = useNotifySaved();
  return (
    <ListScreen<DailyTrafficAlertRow>
      list="daily_traffic_alerts"
      page={page}
      noSelection
      historyScope={{ entityTypes: ["daily_traffic_alert"] }}
      rowActions={(r) => [
        { label: "Edit", icon: "file", main: true, disabled: !!r.archivedAt, onSelect: () => void openDialog(r) },
        {
          label: "Send now",
          icon: "send",
          main: true,
          disabled: send.isPending || !!r.archivedAt,
          onSelect: () =>
            send.mutate(r.id, {
              onSuccess: (mail) => void ask<void>((d) => <SentDialog mail={mail} done={() => d()} />),
              onError: (e) => toast({ tone: "error", message: problemText(e) }),
            }),
        },
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !admin || restore.isPending,
              ...(admin ? {} : { hint: "Deleted. An administrator can restore it." }),
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
              onSelect: () => void del("daily_traffic_alert", r.id, r.name),
            },
      ]}
      primary={{ label: "Add", icon: "plus", onClick: () => void openDialog(null) }}
      columns={{
        id: { width: 90 },
        name: { width: 300, render: (r) => <strong>{r.name}</strong> },
        enterprise: { width: 230 },
        contactType: { width: 120, render: (r) => r.contactType[0]!.toUpperCase() + r.contactType.slice(1) },
        sendHour: {
          width: 120,
          align: "right",
          render: (r) => <span className="num">{String(r.sendHour).padStart(2, "0")}:00</span>,
        },
        status: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "active" ? "good" : "neutral"} />{" "}
              {r.status === "active" ? "Active" : "Inactive"}
            </span>
          ),
        },
        lastSentAt: { width: 170, render: (r) => fmtWhen(r.lastSentAt) },
      }}
      rowClass={(r) => (r.archivedAt ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.enterprise} · {r.contactType} contact · {String(r.sendHour).padStart(2, "0")}:00 UTC
            </span>
          </>
        ),
        sections: [
          {
            key: "alert",
            label: "Alert",
            actions: (
              <>
                <Button
                  small
                  icon="send"
                  disabled={send.isPending || !!r.archivedAt}
                  onClick={() =>
                    send.mutate(r.id, {
                      onSuccess: (mail) => void ask<void>((d) => <SentDialog mail={mail} done={() => d()} />),
                      onError: (e) => toast({ tone: "error", message: problemText(e) }),
                    })
                  }
                >
                  Send now
                </Button>
                <RecordActions
                  kind="daily_traffic_alert"
                  id={r.id}
                  name={r.name}
                  archived={!!r.archivedAt}
                  onEdit={() => void openDialog(r)}
                />
              </>
            ),
            content: (
              <dl className="kv">
                <dt>Enterprise</dt>
                <dd>{r.enterprise}</dd>
                <dt>Sends to</dt>
                <dd>its {r.contactType} contact</dd>
                <dt>From</dt>
                <dd>{r.businessCompany ?? "—"}</dd>
                <dt>When</dt>
                <dd>every day at {String(r.sendHour).padStart(2, "0")}:00 UTC, for the day before</dd>
                <dt>Last sent</dt>
                <dd>{fmtWhen(r.lastSentAt)}</dd>
              </dl>
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["daily_traffic_alert"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
