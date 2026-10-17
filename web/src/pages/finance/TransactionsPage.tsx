// Transactions (§7, §13.33): payments, credit notes and adjustments with the Transaction
// Information and Conversion form, the payment confirmation (preview, send, re-send) and
// Include in SOA (a reason when unticked). Confirmation and In SOA are grid columns with filters
// and can be changed in bulk. Delete archives (§13.29); every save is one undoable change.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ConfirmationPreview,
  Enterprise,
  InvoiceRow,
  TransactionDetail,
  TransactionInput,
  TransactionRow,
} from "@sms/contract";
import {
  convertAmount,
  previewConfirmation,
  useBulkTransactions,
  useEnterpriseBillingOf,
  useSaveTransaction,
  useSendConfirmation,
  useTransaction,
} from "../../api/finance";
import { downloadCsv } from "../../api/masterData";
import { useReference } from "../../api/records";
import { FormField, NumberField, Section, SelectField, TextField, useForm } from "../../form/form";
import { toListQuery } from "../../grid/filterModel";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ListLookup } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { fmtWhen, RecordActions } from "../reference/shared";
import { problemText } from "../routing/dialogs";
import {
  balanceEffect,
  blankTransaction,
  modeLabel,
  money,
  PAYMENT_MODES,
  transactionInput,
  TRANSACTION_TYPES,
  typeLabel,
} from "./financeModel";

const page = pageForPath("/finance/transactions")!;
const muted = (v: string) => <span className="muted">{v}</span>;
const CONFIRMATION = {
  sent: { label: "Sent", tone: "good" },
  not_sent: { label: "Not sent", tone: "neutral" },
  failed: { label: "Failed", tone: "error" },
} as const;

// ---------------------------------------------------------------- form

function PreviewBox({ input }: { input: TransactionInput }) {
  const q = useQuery<ConfirmationPreview>({
    queryKey: ["confirmation-preview", input],
    queryFn: () => previewConfirmation(input),
    enabled: input.enterpriseId > 0 && input.amount > 0,
  });
  if (!q.data) return <p className="muted small">{q.isError ? problemText(q.error) : "Preparing the preview…"}</p>;
  return (
    <div className="mail-preview">
      <div className="small">
        <strong>To:</strong>{" "}
        {q.data.recipients.length ? (
          q.data.recipients.join(", ")
        ) : (
          <span className="tone-error">no billing contact: the confirmation will fail</span>
        )}
      </div>
      <div className="small">
        <strong>Subject:</strong> {q.data.subject}
      </div>
      <pre>{q.data.body}</pre>
    </div>
  );
}

function TransactionEditor({ detail, done }: { detail: TransactionDetail | null; done: (id: number | null) => void }) {
  const form = useForm<TransactionInput>(detail ? transactionInput(detail) : blankTransaction());
  const v = form.values;
  const save = useSaveTransaction();
  const notifySaved = useNotifySaved();
  const currencies = useReference().data?.currencies ?? [];
  const billing = useEnterpriseBillingOf(v.enterpriseId || null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const conversion = useQuery({
    queryKey: ["convert", v.enterpriseId, v.amount, v.currency, v.paymentDate],
    queryFn: () =>
      convertAmount({ enterpriseId: v.enterpriseId, amount: v.amount, currency: v.currency, date: v.paymentDate }),
    enabled: v.enterpriseId > 0 && v.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(v.paymentDate),
  });
  const sideBilling = billing.data?.[v.side] ?? null;
  const pickEnterprise = (e: Enterprise | null) => {
    form.set("enterpriseId", e?.id ?? 0);
    form.set("invoiceId", null);
  };
  // A new payment takes the side's billing currency and confirmation default once they load.
  const [seeded, setSeeded] = useState<string | null>(null);
  const seedKey = `${v.enterpriseId}:${v.side}`;
  if (!detail && sideBilling && seeded !== seedKey) {
    setSeeded(seedKey);
    form.set("currency", sideBilling.currency);
    form.set("sendConfirmation", sideBilling.sendPaymentConfirmation ?? false);
  }
  const setSide = (side: "customer" | "vendor") => {
    const b = blankTransaction(side);
    form.set("side", side);
    form.set("paymentType", b.paymentType);
    form.set("transactionType", b.transactionType);
    form.set("invoiceId", null);
  };
  const submit = () => {
    if (!v.enterpriseId) return setError("Choose the enterprise.");
    save.mutate(
      {
        id: detail?.id ?? null,
        input: {
          ...v,
          description: v.description?.trim() || null,
          excludeReason: v.includeInSoa ? null : v.excludeReason,
        },
      },
      {
        onSuccess: (r) => {
          if (r.change)
            notifySaved(
              r.change,
              `${detail ? "Saved" : "Added"} TX-${r.record.id}${
                !detail && r.record.sendConfirmation
                  ? r.record.confirmationStatus === "sent"
                    ? " · confirmation sent"
                    : " · confirmation failed"
                  : ""
              }`,
            );
          else toast({ tone: "info", message: "Nothing changed" });
          done(r.record.id);
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  const effect = v.amount > 0 ? balanceEffect(v) : 0;
  return (
    <Modal
      title={detail ? `Edit transaction TX-${detail.id}` : "Add transaction"}
      width={900}
      onClose={() => done(null)}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="save" disabled={save.isPending} onClick={submit}>
            {detail ? "Save" : v.sendConfirmation ? "Add and send confirmation" : "Add transaction"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Section title="Transaction Information" columns={3}>
          <FormField label="Enterprise Type" required>
            <div className="segmented small" role="radiogroup" aria-label="Enterprise type">
              {(["customer", "vendor"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={v.side === s}
                  className={v.side === s ? "on" : ""}
                  disabled={!!detail}
                  onClick={() => setSide(s)}
                >
                  {s === "customer" ? "Customer" : "Vendor"}
                </button>
              ))}
            </div>
          </FormField>
          <FormField label="Enterprise Name" required error={form.error("enterpriseId")}>
            <ListLookup<Enterprise>
              list="enterprises"
              value={v.enterpriseId || null}
              onChange={pickEnterprise}
              labelOf={(e) => e.name}
              detailOf={(e) => `${e.alias} · ${e.type}`}
              fixed={[{ field: "type", op: "in", values: [v.side, "reciprocal"] }]}
              placeholder="Enterprise name or alias…"
              clearable={false}
            />
          </FormField>
          <FormField
            label="Invoice Number"
            error={form.error("invoiceId")}
            hint={v.side === "vendor" ? "Customer invoices only" : undefined}
          >
            <ListLookup<InvoiceRow>
              list="invoices"
              value={v.invoiceId}
              onChange={(i) => form.set("invoiceId", i?.id ?? null)}
              labelOf={(i) => i.invoiceNumber}
              detailOf={(i) => `${i.invoiceDate} · due ${money(i.dueAmount, i.currency)} · ${i.paymentStatus}`}
              fixed={[{ field: "enterpriseId", op: "eq", value: v.enterpriseId || -1 }]}
              placeholder={v.enterpriseId ? "Optional: the invoice it settles" : "Choose the enterprise first"}
              disabled={!v.enterpriseId || v.side === "vendor"}
            />
          </FormField>
          <SelectField
            form={form}
            path="transactionType"
            label="Transaction Type"
            required
            options={TRANSACTION_TYPES.filter(
              (t) => t.value !== "reprocess" || detail?.transactionType === "reprocess",
            )}
          />
          <SelectField
            form={form}
            path="paymentMode"
            label="Mode of Payment"
            required={v.transactionType !== "reprocess"}
            options={PAYMENT_MODES}
          />
          <SelectField
            form={form}
            path="paymentType"
            label="Payment Type"
            required
            options={[
              { value: "credit", label: "Credit" },
              { value: "debit", label: "Debit" },
            ]}
            hint={
              v.amount > 0
                ? `${effect > 0 ? "Raises" : "Lowers"} the ${v.side}'s balance by ${money(v.amount, v.currency)}`
                : undefined
            }
          />
          <FormField label="Payment Date" required error={form.error("paymentDate")}>
            <input type="date" value={v.paymentDate} onChange={(e) => form.set("paymentDate", e.target.value)} />
          </FormField>
          <NumberField form={form} path="amount" label="Amount" required min={0.01} step={0.01} />
          <SelectField
            form={form}
            path="currency"
            label="Source Currency"
            required
            options={currencies.map((c) => ({ value: c.iso, label: `${c.iso} · ${c.name}` }))}
            hint={sideBilling ? `Billing currency ${sideBilling.currency}` : undefined}
          />
          <TextField form={form} path="description" label="Transaction Description" wide maxLength={500} />
        </Section>
        <Section
          title="Transaction Conversion"
          columns={3}
          note="Base currency of the enterprise's business company, at the payment date"
        >
          <FormField label="Source">
            <span className="num">{money(v.amount || 0, v.currency)}</span>
          </FormField>
          <FormField label="Rate">
            <span className="num">{conversion.data ? conversion.data.exRate : "—"}</span>
          </FormField>
          <FormField label="Final Amount">
            <strong className="num">
              {conversion.data ? money(conversion.data.amountBase, conversion.data.baseCurrency) : "—"}
            </strong>
          </FormField>
        </Section>
        <Section title="Confirmation and SOA" columns={2} note="§13.33">
          <div className="ff check">
            <label className="toggle-inline strong-label">
              <input
                type="checkbox"
                checked={v.sendConfirmation}
                onChange={(e) => form.set("sendConfirmation", e.target.checked)}
              />
              Send payment confirmation
            </label>
            <span className="ff-hint">
              {detail
                ? "Use “Send confirmation” on the transaction to send or re-send it."
                : "Emails the partner's billing contacts on save."}{" "}
              <button
                type="button"
                className="link small"
                disabled={!v.enterpriseId || !v.amount}
                onClick={() => setPreview((p) => !p)}
              >
                {preview ? "Hide preview" : "Preview"}
              </button>
            </span>
          </div>
          <div className="ff check">
            <label className="toggle-inline strong-label">
              <input
                type="checkbox"
                checked={v.includeInSoa}
                onChange={(e) => form.set("includeInSoa", e.target.checked)}
              />
              Include in SOA
            </label>
            <span className="ff-hint">Unticked: still in balances and reports, left off the partner&apos;s SOA.</span>
          </div>
          {preview && (
            <div className="wide">
              <PreviewBox input={v} />
            </div>
          )}
          {!v.includeInSoa && (
            <TextField
              form={form}
              path="excludeReason"
              label="Reason for leaving it off the SOA"
              required
              wide
              maxLength={300}
            />
          )}
        </Section>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function EditLoader({ id, done }: { id: number; done: (id: number | null) => void }) {
  const q = useTransaction(id);
  if (q.data) return <TransactionEditor detail={q.data} done={done} />;
  return (
    <Modal title="Loading transaction…" onClose={() => done(null)} width={360}>
      <p className={q.isError ? "error-text" : "muted"}>{q.isError ? problemText(q.error) : "Loading…"}</p>
    </Modal>
  );
}

const openEditor = (id: number | null) =>
  ask<number>((done) =>
    id === null ? <TransactionEditor detail={null} done={done} /> : <EditLoader id={id} done={done} />,
  );

function ReasonDialog({ count, done }: { count: number; done: (reason: string | null) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      title={`Leave ${count} transaction${count === 1 ? "" : "s"} off the SOA`}
      width={480}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" disabled={!reason.trim()} onClick={() => done(reason.trim())}>
            Exclude from SOA
          </Button>
        </>
      }
    >
      <label className="field">
        <span>
          Reason<span className="req">*</span>
        </span>
        <input autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </label>
      <p className="muted small">They stay in balances and finance reports (§13.33).</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- detail

function TransactionDetailView({ row }: { row: TransactionRow }) {
  const q = useTransaction(row.id);
  const send = useSendConfirmation();
  const notifySaved = useNotifySaved();
  const d = q.data;
  if (!d) return <p className="muted">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  const c = CONFIRMATION[d.confirmationStatus];
  return (
    <div className="tr-detail">
      <div className="detail-actions">
        {!d.archivedAt && (
          <>
            <Button small icon="file" onClick={() => void openEditor(d.id)}>
              Edit
            </Button>
            <Button
              small
              icon="mail"
              disabled={send.isPending}
              onClick={() =>
                send.mutate(d.id, {
                  onSuccess: (r) =>
                    r.change &&
                    notifySaved(
                      r.change,
                      r.record.confirmationStatus === "sent"
                        ? "Confirmation sent"
                        : "Confirmation failed: no billing contact",
                    ),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                })
              }
            >
              {d.confirmationStatus === "sent" ? "Re-send confirmation" : "Send confirmation"}
            </Button>
          </>
        )}
        <RecordActions kind="transaction" id={d.id} name={`TX-${d.id}`} archived={!!d.archivedAt} />
      </div>
      <dl className="kv">
        <dt>Enterprise</dt>
        <dd>
          {d.enterprise} <span className="muted small">({d.side})</span>
        </dd>
        <dt>Amount</dt>
        <dd>
          <strong className="num">{money(d.amount, d.currency)}</strong> {d.paymentType}{" "}
          <span className="muted small">
            · final {money(d.amountBase, d.baseCurrency)} at {d.exRate}
          </span>
        </dd>
        <dt>Type · mode</dt>
        <dd>
          {typeLabel(d.transactionType)} · {modeLabel(d.paymentMode)}
        </dd>
        <dt>Dates</dt>
        <dd>
          paid {d.paymentDate} · entered {fmtWhen(d.transactionTime)}
          {d.createdBy ? ` by ${d.createdBy}` : ""}
        </dd>
        <dt>Invoice</dt>
        <dd>{d.invoiceNumber ?? muted("none")}</dd>
        <dt>Confirmation</dt>
        <dd>
          <StatusDot tone={c.tone} /> {c.label}
          {d.confirmationSentAt && (
            <span className="muted small">
              {" "}
              · {fmtWhen(d.confirmationSentAt)} to {d.confirmationRecipients.join(", ")}
            </span>
          )}
        </dd>
        <dt>SOA</dt>
        <dd>{d.includeInSoa ? "Included" : <span className="tone-warning">Left off: {d.excludeReason}</span>}</dd>
        {d.description && (
          <>
            <dt>Description</dt>
            <dd>{d.description}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------- page

export function TransactionsPage() {
  const [selectId, setSelectId] = useState<number | null>(null);
  const bulk = useBulkTransactions();
  const notifySaved = useNotifySaved();
  const runBulk = async (
    ids: number[],
    action: "include_in_soa" | "exclude_from_soa" | "send_confirmation",
    clear: () => void,
  ) => {
    let reason: string | null = null;
    if (action === "exclude_from_soa") {
      reason = await ask<string>((done) => <ReasonDialog count={ids.length} done={done} />);
      if (!reason) return;
    }
    bulk.mutate(
      { ids, action, reason },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, r.change.note ?? "Saved");
          else toast({ tone: "info", message: "Nothing to change" });
          clear();
        },
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
  };
  return (
    <ListScreen<TransactionRow>
      list="transactions"
      page={page}
      selectId={selectId}
      historyScope={{ entityTypes: ["transaction"] }}
      primary={{
        label: "Add transaction",
        icon: "plus",
        onClick: () => void openEditor(null).then((id) => id && setSelectId(id)),
      }}
      onExport={(s) =>
        void downloadCsv("/transactions/export", toListQuery(s)).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        enterprise: { width: 220, render: (r) => <strong>{r.enterprise}</strong> },
        side: { width: 100, render: (r) => (r.side === "customer" ? "Customer" : "Vendor") },
        paymentDate: { width: 110 },
        transactionTime: { width: 150, render: (r) => fmtWhen(r.transactionTime) },
        paymentMode: { width: 130, render: (r) => modeLabel(r.paymentMode) },
        paymentType: { width: 100, render: (r) => (r.paymentType === "credit" ? "Credit" : "Debit") },
        transactionType: { width: 130, render: (r) => typeLabel(r.transactionType) },
        amount: {
          width: 140,
          align: "right",
          render: (r) => <span className="num">{money(r.amount, r.currency)}</span>,
        },
        currency: { width: 80 },
        invoiceNumber: { width: 130, render: (r) => r.invoiceNumber ?? muted("—") },
        description: { width: 240, render: (r) => r.description ?? muted("—") },
        confirmationStatus: {
          width: 120,
          render: (r) => (
            <span>
              <StatusDot tone={CONFIRMATION[r.confirmationStatus].tone} /> {CONFIRMATION[r.confirmationStatus].label}
            </span>
          ),
        },
        includeInSoa: {
          width: 80,
          render: (r) =>
            r.includeInSoa ? (
              "Yes"
            ) : (
              <span className="tone-warning" title={r.excludeReason ?? ""}>
                No
              </span>
            ),
        },
        updatedBy: { width: 130, render: (r) => r.updatedBy ?? muted("—") },
      }}
      onOpen={(r) => !r.archivedAt && void openEditor(r.id)}
      selection={{
        summary: (rows, ids) => {
          const picked = rows.filter((r) => ids.has(r.id));
          return `${ids.size} selected${picked.length ? ` · ${picked.filter((r) => !r.includeInSoa).length} off the SOA` : ""}`;
        },
        bulk: (ids, clear) => [
          { label: "Include in SOA", icon: "check", onSelect: () => void runBulk(ids, "include_in_soa", clear) },
          { label: "Exclude from SOA…", icon: "x", onSelect: () => void runBulk(ids, "exclude_from_soa", clear) },
          { label: "Send confirmations", icon: "mail", onSelect: () => void runBulk(ids, "send_confirmation", clear) },
        ],
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>
              TX-{r.id} · {money(r.amount, r.currency)}
            </strong>
            <span className="muted">
              {r.enterprise} · {typeLabel(r.transactionType)} · {r.paymentDate}
            </span>
          </>
        ),
        sections: [
          { key: "transaction", label: "Transaction", content: <TransactionDetailView row={r} /> },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["transaction"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Space selects · Ctrl+Z undo"
    />
  );
}
