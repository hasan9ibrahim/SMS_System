// Billing cycles (§7): named cycles such as "Monthly – Net 7" with type, week day, usage days
// and due days. Delete is blocked while enterprises are billed on a cycle (§13.29); every save
// is one undoable change (§13.10).
import { useState } from "react";
import { useMe } from "../../api/hooks";
import { useRestore } from "../../api/records";
import type { BillingCycleInput, BillingCycleRow } from "@sms/contract";
import { useSaveBillingCycle } from "../../api/finance";
import { NumberField, SelectField, TextField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { problemText } from "../routing/dialogs";
import { fmtWhen, RecordActions, RecordDialog } from "../reference/shared";

const page = pageForPath("/finance/billing-cycles")!;
const TYPES = [
  { value: "monthly", label: "Monthly" },
  { value: "fortnightly", label: "Fortnightly" },
  { value: "weekly", label: "Weekly" },
  { value: "daily", label: "Daily" },
  { value: "custom", label: "Custom" },
];
const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => ({ value: d, label: d }));
/** Usage days a fixed cycle type always has. */
const FIXED_DAYS: Record<string, number> = { daily: 1, weekly: 7, fortnightly: 14 };
const typeLabel = (t: string) => TYPES.find((x) => x.value === t)?.label ?? t;

function CycleDialog({ row, done }: { row: BillingCycleRow | null; done: () => void }) {
  const form = useForm<BillingCycleInput>({
    name: row?.name ?? "",
    billingType: row?.billingType ?? "monthly",
    weekDay: row?.weekDay ?? null,
    usageDays: row?.usageDays ?? 30,
    dueDays: row?.dueDays ?? 7,
  });
  const save = useSaveBillingCycle();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  const weekly = v.billingType === "weekly" || v.billingType === "fortnightly";
  const setType = (t: BillingCycleInput["billingType"]) => {
    form.set("billingType", t);
    if (FIXED_DAYS[t]) form.set("usageDays", FIXED_DAYS[t]);
    if (t === "weekly" || t === "fortnightly") form.set("weekDay", v.weekDay ?? "MON");
    else form.set("weekDay", null);
  };
  const submit = () =>
    save.mutate(
      { id: row?.id ?? null, input: { ...v, name: v.name.trim() } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${row ? "Saved" : "Added"} ${r.record.name}`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  return (
    <RecordDialog
      title={row ? `Edit ${row.name}` : "Add billing cycle"}
      saveLabel={row ? "Save" : "Add cycle"}
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={done}
    >
      <TextField
        form={form}
        path="name"
        label="Name"
        required
        wide
        maxLength={60}
        nullable={false}
        placeholder="Monthly – Net 7"
      />
      <div className="ff">
        <label className="ff-label">
          Billing Type<span className="req">*</span>
        </label>
        <select value={v.billingType} onChange={(e) => setType(e.target.value as BillingCycleInput["billingType"])}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <SelectField
        form={form}
        path="weekDay"
        label="Week Day"
        required={weekly}
        disabled={!weekly}
        options={DAYS}
        hint={weekly ? "The cycle starts on this day" : "Weekly and fortnightly cycles only"}
      />
      <NumberField
        form={form}
        path="usageDays"
        label="Usage Days"
        required
        min={1}
        max={366}
        step={1}
        disabled={!!FIXED_DAYS[v.billingType]}
      />
      <NumberField
        form={form}
        path="dueDays"
        label="Due Days"
        required
        min={0}
        max={180}
        step={1}
        hint="Days after the invoice date the payment is due"
      />
      {row && row.enterprises > 0 && (
        <p className="muted small wide">
          {row.enterprises} enterprises are billed on this cycle; the change applies to their next invoices.
        </p>
      )}
    </RecordDialog>
  );
}

export function BillingCyclesPage() {
  const open = (row: BillingCycleRow | null) => ask<void>((d) => <CycleDialog row={row} done={() => d()} />);
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const del = useDeleteRecord();
  const restore = useRestore("billing_cycle");
  const notifySaved = useNotifySaved();
  return (
    <ListScreen<BillingCycleRow>
      list="billing_cycles"
      page={page}
      historyScope={{ entityTypes: ["billing_cycle"] }}
      rowActions={(r) => [
        { label: "Edit", icon: "file", main: true, disabled: !!r.archivedAt, onSelect: () => void open(r) },
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !admin || restore.isPending,
              ...(admin ? {} : { hint: "Deleted. An administrator can restore it." }),
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored billing cycle ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void del("billing_cycle", r.id, `billing cycle ${r.name}`),
            },
      ]}
      primary={{ label: "Add cycle", icon: "plus", onClick: () => void open(null) }}
      columns={{
        id: { width: 90 },
        name: { width: 220, render: (r) => <strong>{r.name}</strong> },
        usageDays: { width: 110, align: "right" },
        dueDays: { width: 100, align: "right" },
        billingType: { width: 130, render: (r) => typeLabel(r.billingType) },
        weekDay: { width: 100, render: (r) => r.weekDay ?? <span className="muted">—</span> },
        enterprises: { width: 110, align: "right" },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? <span className="muted">seed data</span> },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
      }}
      onOpen={(r) => !r.archivedAt && void open(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {typeLabel(r.billingType)} · {r.usageDays} days · due after {r.dueDays}
            </span>
          </>
        ),
        sections: [
          {
            key: "cycle",
            label: "Cycle",
            actions: (
              <RecordActions
                kind="billing_cycle"
                id={r.id}
                name={`billing cycle ${r.name}`}
                archived={!!r.archivedAt}
                onEdit={() => void open(r)}
              />
            ),
            content: (
              <dl className="kv">
                <dt>Usage period</dt>
                <dd>
                  {r.usageDays} day{r.usageDays === 1 ? "" : "s"}
                  {r.weekDay ? `, starting ${r.weekDay}` : ""}
                </dd>
                <dt>Payment due</dt>
                <dd>{r.dueDays} days after the invoice date</dd>
                <dt>Used by</dt>
                <dd>{r.enterprises ? `${r.enterprises} enterprises (delete is blocked)` : "No enterprise"}</dd>
              </dl>
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["billing_cycle"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
