// Traffic Alert (§8): Info ID, Name, Customer Trunk, Vendor Trunk, Notification Email, Status, plus
// the last check; Add, Edit, Clone, Delete. Each alert measures its last sample interval in the EDRs
// (every 5 minutes, or Check now) and e-mails when it starts firing. Saves are undoable (§13.10).
import { useState } from "react";
import type { EmailTemplateRow, TrafficAlertInput, TrafficAlertRow, TrunkListRow } from "@sms/contract";
import { useMe } from "../../../api/hooks";
import { useRestore } from "../../../api/records";
import { useCheckTrafficAlert, useCloneTrafficAlert, useSaveTrafficAlert } from "../../../api/switchTools";
import { FormField, NumberField, Section, SelectField, TextField, useForm } from "../../../form/form";
import { HistoryList, useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../../records/parts";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { qualityClass } from "../../../ui/quality";
import { problemText } from "../../routing/dialogs";
import { fmtWhen, RecordActions } from "../../reference/shared";
import { ALERT_STATE, alertInput, blankAlert, parseEmails } from "./toolsModel";

const page = pageForPath("/switch/traffic-alerts")!;
const muted = (v: string) => <span className="muted">{v}</span>;

function AlertEditor({ row, done }: { row: TrafficAlertRow | null; done: (id: number | null) => void }) {
  const form = useForm<TrafficAlertInput>(row ? alertInput(row) : blankAlert());
  const v = form.values;
  const [emails, setEmails] = useState((row?.notificationEmails ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  const save = useSaveTrafficAlert();
  const notifySaved = useNotifySaved();
  const parsed = parseEmails(emails);
  const submit = () => {
    if (!v.customerTrunkId) return setError("Choose the customer trunk.");
    if (parsed.invalid.length) return setError(`Not an e-mail: ${parsed.invalid[0]}`);
    save.mutate(
      { id: row?.id ?? null, input: { ...v, notificationEmails: parsed.emails, mccmnc: v.mccmnc?.trim() || null } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${row ? "Saved" : "Added"} ${r.record.name}`);
          done(r.record.id);
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  return (
    <Modal
      title={row ? `Edit traffic alert ${row.name}` : "Add traffic alert"}
      width={860}
      onClose={() => done(null)}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="save" disabled={save.isPending} onClick={submit}>
            {row ? "Save" : "Add alert"}
          </Button>
        </>
      }
    >
      <Section title="Alert" columns={3}>
        <TextField form={form} path="name" label="Name" required maxLength={80} nullable={false} wide />
        <NumberField
          form={form}
          path="sampleCount"
          label="Sample Count (≥)"
          required
          min={1}
          step={1}
          hint="Messages needed before it judges"
        />
        <NumberField
          form={form}
          path="sampleMinutes"
          label="Sample Interval (minutes)"
          required
          min={1}
          max={1440}
          step={1}
        />
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
      </Section>
      <Section title="Thresholds" columns={4}>
        <NumberField
          form={form}
          path="asrThreshold"
          label="ASR Threshold (≤)"
          required
          min={0}
          max={100}
          step={0.5}
          suffix="%"
        />
        <NumberField
          form={form}
          path="dlrThreshold"
          label="DLR Threshold (≤)"
          required
          min={0}
          max={100}
          step={0.5}
          suffix="%"
        />
        <NumberField
          form={form}
          path="marginThreshold"
          label="MRG Threshold (≤)"
          required
          min={-100}
          max={100}
          step={0.5}
          suffix="%"
        />
        <NumberField
          form={form}
          path="delayThreshold"
          label="Avg Delivery Delay (≥)"
          min={0}
          step={1}
          suffix="s"
          hint="Empty = not checked"
        />
      </Section>
      <Section title="Traffic" columns={2}>
        <FormField label="Customer Trunk" required error={form.error("customerTrunkId")}>
          <ListLookup<TrunkListRow>
            list="customer_trunks"
            value={v.customerTrunkId || null}
            onChange={(t) => form.set("customerTrunkId", t?.id ?? 0)}
            labelOf={(t) => t.name}
            detailOf={(t) => t.enterpriseName}
            clearable={false}
          />
        </FormField>
        <FormField label="Vendor Trunk" error={form.error("vendorTrunkId")}>
          <ListLookup<TrunkListRow>
            list="vendor_trunks"
            value={v.vendorTrunkId}
            onChange={(t) => form.set("vendorTrunkId", t?.id ?? null)}
            labelOf={(t) => t.name}
            detailOf={(t) => t.enterpriseName}
            placeholder="Any vendor"
          />
        </FormField>
        <TextField form={form} path="senderId" label="Sender ID" maxLength={32} placeholder="Any sender" />
        <TextField form={form} path="mccmnc" label="MCCMNC" maxLength={6} placeholder="Any destination" />
      </Section>
      <Section title="Notify" columns={2}>
        <FormField
          label="Notification Email"
          wide
          error={parsed.invalid.length ? `Not an e-mail: ${parsed.invalid[0]}` : undefined}
          hint="Comma, space or new line between addresses"
        >
          <textarea rows={2} value={emails} onChange={(e) => setEmails(e.target.value)} />
        </FormField>
        <SelectField
          form={form}
          path="contactEmail"
          label="Enterprise Contact Email"
          required
          options={[
            { value: "none", label: "None" },
            { value: "technical", label: "Technical" },
            { value: "commercial", label: "Commercial" },
            { value: "rates", label: "Rates" },
            { value: "finance", label: "Finance" },
          ]}
        />
        <FormField label="Email Template" required error={form.error("templateId")}>
          <ListLookup<EmailTemplateRow>
            list="email_templates"
            value={v.templateId}
            onChange={(t) => form.set("templateId", t?.id ?? 5)}
            labelOf={(t) => t.name}
            fixed={[{ field: "emailType", op: "in", values: ["traffic_alert"] }]}
            clearable={false}
          />
        </FormField>
      </Section>
    </Modal>
  );
}

const openEditor = (row: TrafficAlertRow | null) => ask<number>((d) => <AlertEditor row={row} done={d} />);

function Values({ r }: { r: TrafficAlertRow }) {
  const v = r.lastValues;
  if (!v) return muted("not checked yet");
  // ASR and DLR are coloured by value (§13.4); a value past its alert threshold is always red.
  const cell = (label: string, value: number | null, thr: number | null, unit: string, low = true, quality = false) => {
    const bad = value !== null && thr !== null && (low ? value <= thr : value >= thr);
    return (
      <div>
        <span className="muted small">{label}</span>
        <strong className={`num ${bad ? "tone-error" : quality ? qualityClass(value) : ""}`}>
          {value === null ? "—" : `${value}${unit}`}
        </strong>
        <span className="muted small">{thr === null ? "not checked" : `${low ? "≤" : "≥"} ${thr}${unit} alerts`}</span>
      </div>
    );
  };
  return (
    <div className="recon-figures">
      <div>
        <span className="muted small">Messages</span>
        <strong className="num">{v.messages.toLocaleString("en-US")}</strong>
        <span className="muted small">needs ≥ {r.sampleCount}</span>
      </div>
      {cell("ASR", v.asr, r.asrThreshold, " %", true, true)}
      {cell("DLR", v.dlr, r.dlrThreshold, " %", true, true)}
      {cell("Margin", v.marginPct, r.marginThreshold, " %")}
      {cell("Delivery delay", v.delaySeconds, r.delayThreshold, " s", false)}
    </div>
  );
}

function AlertDetail({ r, onSelect }: { r: TrafficAlertRow; onSelect: (id: number) => void }) {
  const check = useCheckTrafficAlert();
  const clone = useCloneTrafficAlert();
  const notifySaved = useNotifySaved();
  return (
    <div className="tr-detail">
      <div className="detail-actions">
        {!r.archivedAt && (
          <>
            <Button
              small
              icon="refresh"
              disabled={check.isPending}
              onClick={() =>
                check.mutate(r.id, {
                  onSuccess: (x) =>
                    toast({
                      tone: x.state === "firing" ? "error" : "info",
                      message: `${ALERT_STATE[x.state].label}${x.breaches.length ? `: ${x.breaches.join("; ")}` : ""}${
                        x.emailed.length ? ` · e-mailed ${x.emailed.join(", ")}` : ""
                      }`,
                    }),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                })
              }
            >
              Check now
            </Button>
            <Button small icon="file" onClick={() => void openEditor(r)}>
              Edit
            </Button>
            <Button
              small
              icon="copy"
              onClick={() =>
                clone.mutate(r.id, {
                  onSuccess: (x) => {
                    if (x.change) notifySaved(x.change, `Cloned as ${x.record.name}`);
                    onSelect(x.record.id);
                  },
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                })
              }
            >
              Clone
            </Button>
          </>
        )}
        <RecordActions kind="traffic_alert" id={r.id} name={`traffic alert ${r.name}`} archived={!!r.archivedAt} />
      </div>
      <Values r={r} />
      <dl className="kv">
        <dt>Last check</dt>
        <dd>
          <StatusDot tone={ALERT_STATE[r.state].tone} /> {ALERT_STATE[r.state].label}
          {r.lastCheckedAt && (
            <span className="muted small">
              {" "}
              · {fmtWhen(r.lastCheckedAt)}, last {r.sampleMinutes} min of EDRs
            </span>
          )}
        </dd>
        <dt>Last fired</dt>
        <dd>{r.lastTriggeredAt ? fmtWhen(r.lastTriggeredAt) : "never"}</dd>
        <dt>Traffic</dt>
        <dd>
          {r.customerTrunk} <span className="muted small">({r.enterprise})</span>
          {r.vendorTrunk ? ` → ${r.vendorTrunk}` : ""}
          {r.senderId ? ` · sender ${r.senderId}` : ""}
          {r.mccmnc ? ` · MCCMNC ${r.mccmnc}` : ""}
        </dd>
        <dt>Notify</dt>
        <dd>
          {[...r.notificationEmails, r.contactEmail !== "none" ? `the enterprise's ${r.contactEmail} contact` : null]
            .filter(Boolean)
            .join(", ") || "—"}{" "}
          <span className="muted small">· {r.template ?? "—"}</span>
        </dd>
      </dl>
    </div>
  );
}

export function TrafficAlertsPage() {
  const [selectId, setSelectId] = useState<number | null>(null);
  const check = useCheckTrafficAlert();
  const clone = useCloneTrafficAlert();
  const notifySaved = useNotifySaved();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("traffic_alert");
  const deleted = (r: TrafficAlertRow) => (r.archivedAt ? "The alert is deleted" : undefined);
  return (
    <ListScreen<TrafficAlertRow>
      list="traffic_alerts"
      page={page}
      selectId={selectId}
      noSelection
      historyScope={{ entityTypes: ["traffic_alert"] }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: deleted(r),
          onSelect: () => void openEditor(r),
        },
        {
          label: "Check now",
          icon: "refresh",
          main: true,
          disabled: !!r.archivedAt || check.isPending,
          hint: deleted(r),
          onSelect: () =>
            check.mutate(r.id, {
              onSuccess: (x) =>
                toast({
                  tone: x.state === "firing" ? "error" : "info",
                  message: `${ALERT_STATE[x.state].label}${x.breaches.length ? `: ${x.breaches.join("; ")}` : ""}${
                    x.emailed.length ? ` · e-mailed ${x.emailed.join(", ")}` : ""
                  }`,
                }),
              onError: (e) => toast({ tone: "error", message: problemText(e) }),
            }),
        },
        {
          label: "Clone",
          icon: "copy",
          disabled: !!r.archivedAt || clone.isPending,
          hint: deleted(r),
          onSelect: () =>
            clone.mutate(r.id, {
              onSuccess: (x) => {
                if (x.change) notifySaved(x.change, `Cloned as ${x.record.name}`);
                setSelectId(x.record.id);
              },
              onError: (e) => toast({ tone: "error", message: problemText(e) }),
            }),
        },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !admin || restore.isPending,
              hint: admin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (x) => x.change && notifySaved(x.change, `Restored traffic alert ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete…",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("traffic_alert", r.id, `traffic alert ${r.name}`),
            },
      ]}
      primary={{ label: "Add", icon: "plus", onClick: () => void openEditor(null).then((id) => id && setSelectId(id)) }}
      columns={{
        id: { width: 80 },
        name: { width: 220, render: (r) => <strong>{r.name}</strong> },
        customerTrunk: { width: 200 },
        vendorTrunk: { width: 180, render: (r) => r.vendorTrunk ?? muted("any") },
        notificationEmails: { width: 240, render: (r) => r.notificationEmails.join(", ") || muted("—") },
        status: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "active" ? "good" : "neutral"} />{" "}
              {r.status === "active" ? "Active" : "Inactive"}
            </span>
          ),
        },
        state: {
          width: 150,
          render: (r) => (
            <span>
              <StatusDot tone={ALERT_STATE[r.state].tone} /> {ALERT_STATE[r.state].label}
            </span>
          ),
        },
        lastTriggeredAt: {
          width: 170,
          render: (r) => (r.lastTriggeredAt ? fmtWhen(r.lastTriggeredAt) : muted("never")),
        },
      }}
      rowClass={(r) => (r.status === "inactive" ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openEditor(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.customerTrunk} · every {r.sampleMinutes} min
            </span>
          </>
        ),
        sections: [
          { key: "alert", label: "Alert", content: <AlertDetail r={r} onSelect={setSelectId} /> },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["traffic_alert"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
