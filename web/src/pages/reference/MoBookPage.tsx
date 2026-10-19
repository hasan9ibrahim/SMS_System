// MO reference book (§6.1): two-way and MO billing numbers. Each entry is a long number or
// short code (plus an optional keyword) a customer trunk receives MO traffic on, with the
// rate charged to the customer, the vendor rate, the destination, and the setup and fixed
// charges, all in the customer trunk's currency (decided 2026-10-17). Add, edit, delete
// (archive), restore, import with a dry run, export.
import { useState } from "react";
import type { Destination, MoNumber, MoNumberInput, TrunkListRow } from "@sms/contract";
import { useMe } from "../../api/hooks";
import { downloadCsv, useSaveMoNumber } from "../../api/masterData";
import { useRestore } from "../../api/records";
import { FormField, NumberField, ReadOnly, TextField, useForm } from "../../form/form";
import { toListQuery } from "../../grid/filterModel";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen, openImport, RecordActions, RecordDialog } from "./shared";
import { destLabel } from "../rates/DestinationTree";

const page = pageForPath("/rates/mo-book")!;

const rate = (v: number | null, currency: string) => (v === null ? "—" : `${v.toFixed(4)} ${currency}`);
const money = (v: number, currency: string) => (v === 0 ? "—" : `${v.toFixed(2)} ${currency}`);
const label = (r: { number: string; keyword: string | null }) => (r.keyword ? `${r.number} ${r.keyword}` : r.number);

function MoDialog({ row, done }: { row: MoNumber | null; done: () => void }) {
  const [currency, setCurrency] = useState<string | null>(row?.currency ?? null);
  const form = useForm<MoNumberInput>({
    customerTrunkId: row?.customerTrunkId ?? (0 as number),
    number: row?.number ?? "",
    keyword: row?.keyword ?? null,
    rate: row?.rate ?? (null as unknown as number),
    vendorRate: row?.vendorRate ?? null,
    destinationId: row?.destinationId ?? null,
    setupCharge: row?.setupCharge ?? 0,
    fixCharge: row?.fixCharge ?? 0,
  });
  const save = useSaveMoNumber();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  const submit = () => {
    if (!v.customerTrunkId) return setError("Choose the customer trunk.");
    if (v.rate === null || Number.isNaN(v.rate)) return setError("Enter the rate.");
    save.mutate(
      {
        id: row?.id ?? null,
        input: {
          ...v,
          number: v.number.replace(/^\+/, ""),
          setupCharge: v.setupCharge ?? 0,
          fixCharge: v.fixCharge ?? 0,
        },
      },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${row ? "Saved" : "Added"} MO number ${label(r.record)}`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  return (
    <RecordDialog
      title={row ? `Edit MO number ${label(row)}` : "Add MO number"}
      saveLabel={row ? "Save" : "Add MO number"}
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={done}
      width={620}
    >
      <FormField label="Customer Trunk" required wide error={form.error("customerTrunkId")}>
        <ListLookup<TrunkListRow>
          list="customer_trunks"
          value={v.customerTrunkId || null}
          onChange={(t) => {
            form.set("customerTrunkId", t?.id ?? 0);
            setCurrency(t?.currency ?? null);
          }}
          labelOf={(t) => t.name}
          detailOf={(t) => t.enterpriseName}
          placeholder="Search customer trunks…"
          clearable={false}
        />
      </FormField>
      <TextField
        form={form}
        path="number"
        label="Number"
        required
        maxLength={21}
        placeholder="491701234567 or 12345"
        nullable={false}
        hint="Long number (digits) or short code"
      />
      <TextField form={form} path="keyword" label="Keyword" maxLength={40} hint="Empty = any message to the number" />
      <NumberField form={form} path="rate" label="Rate" required min={0} step={0.0001} hint="Charged to the customer" />
      <NumberField form={form} path="vendorRate" label="Vendor Rate" min={0} step={0.0001} hint="Paid to the vendor" />
      <ReadOnly label="Currency" hint="The customer trunk's; every amount is in it">
        {currency ?? <span className="muted">Choose the trunk</span>}
      </ReadOnly>
      <FormField label="MCCMNC" error={form.error("destinationId")}>
        <ListLookup<Destination>
          list="destinations"
          value={v.destinationId}
          onChange={(d) => form.set("destinationId", d?.id ?? null)}
          labelOf={(d) => destLabel(d.country, d.network, d.allNetworks, d.mccmnc)}
          placeholder="None"
        />
      </FormField>
      <NumberField form={form} path="setupCharge" label="Setup Charge" min={0} step={0.01} hint="One-off" />
      <NumberField form={form} path="fixCharge" label="Fix Charge" min={0} step={0.01} hint="Per billing cycle" />
    </RecordDialog>
  );
}

const openDialog = (row: MoNumber | null) => ask<void>((done) => <MoDialog row={row} done={() => done()} />);

const importBook = () =>
  openImport({
    target: { kind: "mo_numbers" },
    title: "MO Reference Book Import",
    help: (
      <p>
        Columns <code>customer_trunk</code> (name), <code>number</code>, <code>keyword</code>, <code>rate</code>,{" "}
        <code>vendor_rate</code>, <code>mccmnc</code>, <code>setup_charge</code>, <code>fix_charge</code>, all in the
        customer trunk&apos;s currency (an optional <code>currency</code> column must match it). Rows are matched by
        number + keyword.
      </p>
    ),
    replaceHint: "Entries missing from the file are archived (billed MO traffic keeps its charges).",
  });

export function MoBookPage() {
  const deleteOne = useDeleteRecord();
  const { data: me } = useMe();
  const restore = useRestore("mo_number");
  const notifySaved = useNotifySaved();
  const isAdmin = isAdminUser(me?.permissions);
  return (
    <ListScreen<MoNumber>
      list="mo_numbers"
      page={page}
      historyScope={{ entityTypes: ["mo_number"] }}
      primary={{ label: "Add MO number", icon: "plus", onClick: () => void openDialog(null) }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted entry" : undefined,
          onSelect: () => void openDialog(r),
        },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !isAdmin || restore.isPending,
              hint: isAdmin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored MO number ${label(r)}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("mo_number", r.id, `MO number ${label(r)}`),
            },
      ]}
      actions={
        <Button icon="upload" onClick={() => void importBook()}>
          Import
        </Button>
      }
      onExport={(s) =>
        void downloadCsv("/mo-numbers/export", toListQuery(s)).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        id: { width: 80 },
        customerTrunk: { width: 180 },
        number: { width: 150, render: (r) => <span className="num strong">{r.number}</span> },
        keyword: { width: 100, render: (r) => r.keyword ?? <span className="muted">any</span> },
        rate: { width: 110, align: "right", render: (r) => <span className="num">{r.rate.toFixed(4)}</span> },
        vendorRate: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{r.vendorRate === null ? "—" : r.vendorRate.toFixed(4)}</span>,
        },
        currency: { width: 80 },
        mccmnc: { width: 90, render: (r) => <span className="num">{r.mccmnc ?? "—"}</span> },
        destination: { width: 220, render: (r) => r.destination ?? <span className="muted">—</span> },
        setupCharge: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{r.setupCharge.toFixed(2)}</span>,
        },
        fixCharge: { width: 100, align: "right", render: (r) => <span className="num">{r.fixCharge.toFixed(2)}</span> },
        createdAt: { width: 150, render: (r) => r.createdAt.slice(0, 16).replace("T", " ") },
        createdBy: { width: 120, render: (r) => r.createdBy ?? <span className="muted">—</span> },
      }}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong className="num">{label(r)}</strong>
            <span className="muted">
              {r.customerTrunk} · {r.enterprise}
            </span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "Entry",
            actions: (
              <RecordActions
                kind="mo_number"
                id={r.id}
                name={`MO number ${label(r)}`}
                archived={!!r.archivedAt}
                onEdit={() => void openDialog(r)}
              />
            ),
            content: (
              <dl className="kv">
                <dt>Rate (customer)</dt>
                <dd>{rate(r.rate, r.currency)}</dd>
                <dt>Vendor rate</dt>
                <dd>{rate(r.vendorRate, r.currency)}</dd>
                <dt>Destination</dt>
                <dd>{r.destination ? `${r.mccmnc} ${r.destination}` : "—"}</dd>
                <dt>Setup / fixed charge</dt>
                <dd>
                  {money(r.setupCharge, r.currency)} / {money(r.fixCharge, r.currency)}
                </dd>
                <dt>Created</dt>
                <dd>
                  {r.createdBy ?? "seed data"} · {fmtWhen(r.createdAt)}
                </dd>
                <dt>Updated</dt>
                <dd>
                  {r.updatedBy ?? "seed data"} · {fmtWhen(r.updatedAt)}
                </dd>
                {r.archivedAt && (
                  <>
                    <dt>State</dt>
                    <dd className="tone-warning">Deleted {fmtWhen(r.archivedAt)}</dd>
                  </>
                )}
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
