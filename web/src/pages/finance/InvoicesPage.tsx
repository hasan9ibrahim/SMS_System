// Invoices (§7, §12.3): the invoice grid (Invoice No, PDF, Charge Details, balances with the §7
// sign, e-mail and job status) with Send Invoice, Mark, Generate Request and per-row Regenerate,
// and the Invoice Request list (?view=requests). Requests run in the background; the page polls
// them and refreshes when they finish. Delete archives and is blocked while payments are linked
// (§13.29); edits, sends and marks are undoable (§13.10). Send SOA opens the SOA screen (§7).
import { useState } from "react";
import { useLocation } from "react-router";
import type { Enterprise, InvoiceDetail, InvoiceRequestInput, InvoiceRequestRow, InvoiceRow } from "@sms/contract";
import {
  createInvoiceRequest,
  downloadInvoicePdf,
  useInvoice,
  useInvoiceCharges,
  useMarkInvoices,
  useRegenerateInvoice,
  useSendInvoices,
  useUpdateInvoice,
  waitForRequests,
} from "../../api/invoices";
import { downloadCsv } from "../../api/masterData";
import { useReference, useRefreshRecords } from "../../api/records";
import { FormField, NumberField, Section, SelectField, TextField, useForm } from "../../form/form";
import { toListQuery } from "../../grid/filterModel";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { MultiPick, type Picked } from "../routing/pickers";
import { fmtWhen, RecordActions } from "../reference/shared";
import { problemText } from "../routing/dialogs";
import { balanceWords, money } from "./financeModel";
import { blankRequest, JOB_STATUS, PAYMENT_STATUS, requestInput } from "./invoiceModel";
import { soaLink } from "./soaModel";

const page = pageForPath("/finance/invoices")!;
const muted = (v: string) => <span className="muted">{v}</span>;

type View = "invoices" | "requests";

function useView(): [View, (v: View) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const view: View = new URLSearchParams(location.search).get("view") === "requests" ? "requests" : "invoices";
  return [view, (v) => navigate(`/finance/invoices${v === "requests" ? "?view=requests" : ""}`)];
}

function ViewSwitch() {
  const [view, go] = useView();
  return (
    <div className="rm-trunk">
      <div className="segmented small" role="radiogroup" aria-label="Invoice view">
        {(
          [
            ["invoices", "Invoices"],
            ["requests", "Invoice requests"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={view === k}
            className={view === k ? "on" : ""}
            onClick={() => go(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="muted small">
        Balances: positive = the client&apos;s credit, negative = owed (amber). Due amount = what the closing balance
        owes.
      </span>
    </div>
  );
}

const Status = ({ s }: { s: string }) => (
  <span>
    <StatusDot tone={JOB_STATUS[s]?.tone ?? "neutral"} /> {JOB_STATUS[s]?.label ?? s}
  </span>
);

const balance = (v: number, ccy: string) => (
  <span className={`num ${balanceWords(v, "customer").tone}`} title={balanceWords(v, "customer").text}>
    {money(v, ccy)}
  </span>
);

// ---------------------------------------------------------------- requests

/** Waits for requests in the background and reports how they ended. */
function useFollowRequests() {
  const refresh = useRefreshRecords();
  return (rows: InvoiceRequestRow[]) => {
    void refresh();
    void waitForRequests(rows.map((r) => r.id)).then((done) => {
      void refresh();
      const failed = done.filter((r) => r.status === "failed");
      const ok = done.length - failed.length;
      if (ok)
        toast({
          tone: "good",
          message: `${ok} invoice${ok === 1 ? "" : "s"} ready${
            ok === 1 && done[0]?.invoiceNumber ? `: ${done.find((r) => r.status === "completed")?.invoiceNumber}` : ""
          }`,
        });
      for (const f of failed.slice(0, 3))
        toast({ tone: "error", message: `${f.requestNo} ${f.enterprise}: ${f.error ?? "failed"}` });
    });
  };
}

function GenerateDialog({ done }: { done: (rows: InvoiceRequestRow[] | null) => void }) {
  const form = useForm<InvoiceRequestInput>(blankRequest());
  const v = form.values;
  const ref = useReference().data;
  const [picked, setPicked] = useState<Picked<number>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const proforma = v.kind === "proforma";
  const submit = async () => {
    if (!picked.length) return setError("Choose at least one enterprise.");
    setBusy(true);
    setError(null);
    try {
      const r = await createInvoiceRequest(requestInput({ ...v, enterpriseIds: picked.map((p) => p.key) }));
      done(r.requests);
    } catch (e) {
      setError(form.fail(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Generate Request"
      width={820}
      onClose={() => done(null)}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="play" disabled={busy} onClick={() => void submit()}>
            Submit{picked.length > 1 ? ` (${picked.length} invoices)` : ""}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Section title="Request" columns={3} note="§12.3 · runs in the background">
          <FormField label="Invoice Type" required>
            <div className="segmented small" role="radiogroup" aria-label="Invoice type">
              {(["traffic", "proforma"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={v.kind === k}
                  className={v.kind === k ? "on" : ""}
                  onClick={() => form.set("kind", k)}
                >
                  {k === "traffic" ? "Traffic" : "Proforma"}
                </button>
              ))}
            </div>
          </FormField>
          <FormField label="Enterprise Name" required wide error={form.error("enterpriseIds")}>
            <MultiPick<Enterprise, number>
              list="enterprises"
              value={picked}
              onChange={setPicked}
              toPicked={(e) => ({ key: e.id, label: e.name })}
              detailOf={(e) => `${e.alias} · ${e.type}`}
              fixed={[{ field: "type", op: "in", values: ["customer", "reciprocal"] }]}
              placeholder="Enterprise name or alias…"
            />
          </FormField>
          <SelectField
            form={form}
            path="timezone"
            label="Timezone"
            options={(ref?.timezones ?? ["UTC"]).map((z) => ({ value: z, label: z }))}
            placeholder="Each enterprise's billing time zone"
            hint="Usage days are cut at midnight here (§13.31)"
          />
          <FormField label="Usage Start Date" required error={form.error("usageStart")}>
            <input type="date" value={v.usageStart} onChange={(e) => form.set("usageStart", e.target.value)} />
          </FormField>
          <FormField label="Usage End Date" required error={form.error("usageEnd")}>
            <input type="date" value={v.usageEnd} onChange={(e) => form.set("usageEnd", e.target.value)} />
          </FormField>
          <FormField label="Invoice Date" error={form.error("invoiceDate")}>
            <input
              type="date"
              value={v.invoiceDate ?? ""}
              onChange={(e) => form.set("invoiceDate", e.target.value || null)}
            />
          </FormField>
          <SelectField
            form={form}
            path="dueDateType"
            label="Due Date Type"
            required
            options={[
              { value: "auto", label: "Auto (billing cycle due days)" },
              { value: "manual", label: "Manual" },
            ]}
          />
          {v.dueDateType === "manual" && (
            <FormField label="Due Date" required error={form.error("dueDate")}>
              <input
                type="date"
                value={v.dueDate ?? ""}
                onChange={(e) => form.set("dueDate", e.target.value || null)}
              />
            </FormField>
          )}
          <TextField
            form={form}
            path="invoiceNumber"
            label="Invoice Number"
            maxLength={40}
            disabled={picked.length !== 1}
            hint={picked.length === 1 ? "Empty = the business company's next number" : "One enterprise only"}
          />
          {proforma && (
            <>
              <NumberField form={form} path="amount" label="Amount" required min={0.01} step={0.01} />
              <NumberField form={form} path="volume" label="Volume" min={0} step={1} />
              <SelectField
                form={form}
                path="currency"
                label="Currency"
                options={(ref?.currencies ?? []).map((c) => ({ value: c.iso, label: `${c.iso} · ${c.name}` }))}
                placeholder="Billing currency"
              />
            </>
          )}
          <TextField form={form} path="remarks" label="Remarks" wide maxLength={500} />
        </Section>
        <p className="muted small">
          {proforma
            ? "A proforma invoice asks for the amount in advance; it does not count as usage in balances."
            : "Usage comes from the EDRs for the period. An enterprise already invoiced for an overlapping period fails: use Regenerate on that invoice."}
        </p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function RequestsView({ onGenerate }: { onGenerate: () => void }) {
  return (
    <ListScreen<InvoiceRequestRow>
      list="invoice_requests"
      page={page}
      title="Invoice requests"
      noSelection
      historyScope={null}
      above={<ViewSwitch />}
      primary={{ label: "Generate Request", icon: "play", onClick: onGenerate }}
      columns={{
        requestNo: { width: 110, render: (r) => <strong className="num">{r.requestNo}</strong> },
        startedAt: { width: 170, render: (r) => (r.startedAt ? fmtWhen(r.startedAt) : muted("—")) },
        finishedAt: { width: 170, render: (r) => (r.finishedAt ? fmtWhen(r.finishedAt) : muted("—")) },
        invoiceType: {
          width: 120,
          render: (r) => `${r.invoiceType === "auto" ? "Auto" : "Manual"}${r.regenerate ? " · regenerate" : ""}`,
        },
        kind: { width: 90, render: (r) => (r.kind === "traffic" ? "Traffic" : "Proforma") },
        enterprise: { width: 220, render: (r) => <strong>{r.enterprise}</strong> },
        enterpriseType: {
          width: 110,
          render: (r) => r.enterpriseType.charAt(0).toUpperCase() + r.enterpriseType.slice(1),
        },
        billingType: {
          width: 100,
          render: (r) => (r.billingType ? (r.billingType === "prepaid" ? "Prepaid" : "Postpaid") : muted("—")),
        },
        status: { width: 120, render: (r) => <Status s={r.status} /> },
        error: {
          width: 300,
          render: (r) =>
            r.error ? (
              <span className="tone-error" title={r.error}>
                {r.error}
              </span>
            ) : (
              muted("—")
            ),
        },
        invoiceNumber: { width: 130, render: (r) => r.invoiceNumber ?? muted("—") },
        remarks: { width: 200, render: (r) => r.remarks ?? muted("—") },
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.requestNo}</strong>
            <span className="muted">
              {r.enterprise} · {r.usageStart} → {r.usageEnd}
            </span>
          </>
        ),
        sections: [
          {
            key: "request",
            label: "Request",
            content: (
              <dl className="kv">
                <dt>Status</dt>
                <dd>
                  <Status s={r.status} />
                  {r.error && <div className="tone-error small">{r.error}</div>}
                </dd>
                <dt>Type</dt>
                <dd>
                  {r.kind === "traffic" ? "Traffic" : "Proforma"} ·{" "}
                  {r.invoiceType === "auto" ? "Auto Invoicing" : "Manual"}
                  {r.regenerate ? " · regenerate" : ""}
                </dd>
                <dt>Usage</dt>
                <dd>
                  {r.usageStart} → {r.usageEnd} <span className="muted small">({r.timezone})</span>
                </dd>
                <dt>Invoice</dt>
                <dd>{r.invoiceNumber ?? "—"}</dd>
                <dt>Requested</dt>
                <dd>
                  {fmtWhen(r.createdAt)} {r.createdBy ? `by ${r.createdBy}` : "by Auto Invoicing"}
                </dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move"
    />
  );
}

// ---------------------------------------------------------------- invoices

function EditDialog({ inv, done }: { inv: InvoiceDetail; done: () => void }) {
  const [dueDate, setDueDate] = useState(inv.dueDate);
  const [remarks, setRemarks] = useState(inv.remarks ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useUpdateInvoice();
  const notifySaved = useNotifySaved();
  const submit = () =>
    save.mutate(
      { id: inv.id, input: { dueDate, remarks: remarks.trim() || null } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `Saved ${inv.invoiceNumber}`);
          done();
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  return (
    <Modal
      title={`Edit ${inv.invoiceNumber}`}
      width={520}
      onClose={done}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button variant="primary" icon="save" disabled={save.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Payment Due Date</span>
        <input type="date" value={dueDate} min={inv.invoiceDate} onChange={(e) => setDueDate(e.target.value)} />
      </label>
      <label className="field">
        <span>Remarks</span>
        <input value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} />
      </label>
      <p className="muted small">Amounts come from the usage; use Regenerate to compute them again.</p>
    </Modal>
  );
}

function MarkDialog({
  count,
  done,
}: {
  count: number;
  done: (v: { pay: string | null; mail: string | null } | null) => void;
}) {
  const [pay, setPay] = useState<string>("");
  const [mail, setMail] = useState<string>("");
  return (
    <Modal
      title={`Mark ${count} invoice${count === 1 ? "" : "s"}`}
      width={440}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!pay && !mail}
            onClick={() => done({ pay: pay || null, mail: mail || null })}
          >
            Mark
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Payment status</span>
        <select value={pay} onChange={(e) => setPay(e.target.value)}>
          <option value="">Leave as it is</option>
          <option value="unpaid">Unpaid</option>
          <option value="partial">Partly paid</option>
          <option value="paid">Paid</option>
        </select>
      </label>
      <label className="field">
        <span>Email status</span>
        <select value={mail} onChange={(e) => setMail(e.target.value)}>
          <option value="">Leave as it is</option>
          <option value="unsent">UnSent</option>
          <option value="sent">Sent</option>
        </select>
      </label>
    </Modal>
  );
}

function ChargesTable({ id }: { id: number }) {
  const q = useInvoiceCharges(id);
  const c = q.data;
  if (!c) return <p className="muted">{q.isError ? problemText(q.error) : "Reading the EDRs…"}</p>;
  return (
    <div className="inv-charges">
      <p className="muted small">
        {c.from} → {c.to} in {c.timezone} · {c.totalMessages.toLocaleString("en-US")} messages ·{" "}
        {money(c.totalAmount, c.currency)}
      </p>
      {c.note && <p className="tone-warning small">{c.note}</p>}
      {c.rows.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>MCCMNC</th>
              <th>Country · network</th>
              <th className="num">Rate</th>
              <th className="num">Messages</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.slice(0, 300).map((r) => (
              <tr key={`${r.mccmnc}:${r.rate}`}>
                <td className="num">{r.mccmnc}</td>
                <td>
                  {r.country ?? "—"} <span className="muted small">{r.network ?? ""}</span>
                </td>
                <td className="num">{r.rate ?? "—"}</td>
                <td className="num">{r.messages.toLocaleString("en-US")}</td>
                <td className="num">{money(r.amount, c.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.rows.length > 300 && <p className="muted small">First 300 of {c.rows.length} lines.</p>}
    </div>
  );
}

const openCharges = (row: InvoiceRow) =>
  ask<void>((done) => (
    <Modal title={`Charge Details · ${row.invoiceNumber}`} width={760} onClose={() => done()}>
      <ChargesTable id={row.id} />
    </Modal>
  ));

const pdf = (id: number) => void downloadInvoicePdf(id).catch((e) => toast({ tone: "error", message: problemText(e) }));

function InvoiceDetailView({ row, onRegenerate }: { row: InvoiceRow; onRegenerate: (id: number) => void }) {
  const q = useInvoice(row.id);
  const send = useSendInvoices();
  const notifySaved = useNotifySaved();
  const navigate = useTabNavigate();
  const d = q.data;
  if (!d) return <p className="muted">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  const busy = d.status === "pending" || d.status === "inprogress";
  return (
    <div className="tr-detail">
      <div className="detail-actions">
        {!d.archivedAt && (
          <>
            <Button
              small
              icon="file"
              onClick={() => void ask<void>((done) => <EditDialog inv={d} done={() => done()} />)}
            >
              Edit
            </Button>
            <Button small icon="download" disabled={d.status !== "completed"} onClick={() => pdf(d.id)}>
              PDF
            </Button>
            <Button
              small
              icon="mail"
              disabled={d.status !== "completed" || send.isPending}
              onClick={() =>
                send.mutate([d.id], {
                  onSuccess: (r) =>
                    r.change
                      ? notifySaved(r.change, "Invoice sent")
                      : toast({ tone: "error", message: `Not sent: ${r.skipped[0]?.reason ?? "skipped"}` }),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                })
              }
            >
              {d.emailStatus === "sent" ? "Send again" : "Send Invoice"}
            </Button>
            <Button
              small
              icon="refresh"
              disabled={busy || d.payments.length > 0}
              title={
                d.payments.length ? "Payments are linked: it cannot be regenerated" : "Compute usage and balances again"
              }
              onClick={() => onRegenerate(d.id)}
            >
              Regenerate
            </Button>
          </>
        )}
        <Button
          small
          icon="mail"
          onClick={() => navigate(soaLink([d.enterpriseId]))}
          title="Open the SOA screen for this enterprise"
        >
          Send SOA
        </Button>
        <RecordActions kind="invoice" id={d.id} name={`invoice ${d.invoiceNumber}`} archived={!!d.archivedAt} />
      </div>
      <dl className="kv">
        <dt>Enterprise</dt>
        <dd>
          {d.enterprise}{" "}
          <span className="muted small">
            ({d.enterpriseType} · {d.businessCompany})
          </span>
        </dd>
        <dt>Type</dt>
        <dd>
          {d.kind === "traffic" ? "Traffic" : "Proforma"} · {d.invoiceType === "auto" ? "Auto" : "Manual"} ·{" "}
          {d.billingType === "prepaid" ? "Prepaid" : "Postpaid"}
        </dd>
        <dt>Usage</dt>
        <dd>
          {d.usageStart} → {d.usageEnd} <span className="muted small">({d.timezone})</span> ·{" "}
          {d.messageCount.toLocaleString("en-US")} messages
        </dd>
        <dt>Dates</dt>
        <dd>
          invoiced {d.invoiceDate} · due {d.dueDate}
        </dd>
        <dt>Opening</dt>
        <dd>{balance(d.openingBalance, d.currency)}</dd>
        <dt>Usage charges</dt>
        <dd>
          <span className="num">{money(d.usageCharges, d.currency)}</span>
        </dd>
        <dt>Closing</dt>
        <dd>
          {balance(d.closingBalance, d.currency)}{" "}
          <span className="muted small">{balanceWords(d.closingBalance, "customer").text}</span>
        </dd>
        <dt>Due amount</dt>
        <dd>
          <strong className={`num${d.dueAmount > 0 ? " tone-warning" : ""}`}>{money(d.dueAmount, d.currency)}</strong>
        </dd>
        <dt>Status</dt>
        <dd>
          <Status s={d.status} /> · <StatusDot tone={PAYMENT_STATUS[d.paymentStatus]!.tone} />{" "}
          {PAYMENT_STATUS[d.paymentStatus]!.label}
        </dd>
        <dt>E-mail</dt>
        <dd>
          {d.emailStatus === "sent" ? "Sent" : "UnSent"}
          {d.emailSentAt && (
            <span className="muted small">
              {" "}
              · {fmtWhen(d.emailSentAt)}
              {d.emailRecipients.length ? ` to ${d.emailRecipients.join(", ")}` : ""}
            </span>
          )}
        </dd>
        <dt>Payments</dt>
        <dd>
          {d.payments.length === 0
            ? muted("none linked")
            : d.payments.map((p) => (
                <div key={p.id} className="small">
                  TX-{p.id} · {p.paymentDate} · {p.transactionType} · {p.paymentType === "credit" ? "+" : "−"}
                  {money(p.amount, p.currency)}
                </div>
              ))}
        </dd>
        {d.remarks && (
          <>
            <dt>Remarks</dt>
            <dd>{d.remarks}</dd>
          </>
        )}
        <dt>Created</dt>
        <dd>
          {fmtWhen(d.createdAt)} {d.createdBy ? `by ${d.createdBy}` : ""}
        </dd>
      </dl>
    </div>
  );
}

function InvoicesView({ onGenerate }: { onGenerate: () => void }) {
  const send = useSendInvoices();
  const mark = useMarkInvoices();
  const regenerate = useRegenerateInvoice();
  const follow = useFollowRequests();
  const notifySaved = useNotifySaved();
  const doRegenerate = (id: number) =>
    regenerate.mutate(id, {
      onSuccess: (r) => {
        toast({ tone: "info", message: `${r.requestNo}: regenerating ${r.invoiceNumber ?? ""}…` });
        follow([r]);
      },
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  const sendMany = (ids: number[], clear: () => void) =>
    send.mutate(ids, {
      onSuccess: (r) => {
        const skipped = r.skipped.length ? ` · ${r.skipped.length} skipped (${r.skipped[0]!.reason}…)` : "";
        if (r.change) notifySaved(r.change, `Sent ${r.sent} invoice${r.sent === 1 ? "" : "s"}${skipped}`);
        else toast({ tone: "error", message: `Nothing sent${skipped}` });
        clear();
      },
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  const markMany = async (ids: number[], clear: () => void) => {
    const v = await ask<{ pay: string | null; mail: string | null }>((done) => (
      <MarkDialog count={ids.length} done={done} />
    ));
    if (!v) return;
    mark.mutate(
      {
        ids,
        paymentStatus: v.pay as "unpaid" | "partial" | "paid" | null,
        emailStatus: v.mail as "unsent" | "sent" | null,
      },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, r.change.note ?? "Marked");
          else toast({ tone: "info", message: "Nothing to change" });
          clear();
        },
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
  };
  return (
    <ListScreen<InvoiceRow>
      list="invoices"
      page={page}
      historyScope={{ entityTypes: ["invoice"] }}
      above={<ViewSwitch />}
      primary={{ label: "Generate Request", icon: "play", onClick: onGenerate }}
      onExport={(s) =>
        void downloadCsv("/invoices/export", toListQuery(s)).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        invoiceNumber: { width: 130, render: (r) => <strong className="num">{r.invoiceNumber}</strong> },
        enterprise: { width: 220 },
        enterpriseType: { width: 110, render: (r) => (r.enterpriseType === "reciprocal" ? "Reciprocal" : "Customer") },
        invoiceType: { width: 100, render: (r) => (r.invoiceType === "auto" ? "Auto" : "Manual") },
        billingType: { width: 100, render: (r) => (r.billingType === "prepaid" ? "Prepaid" : "Postpaid") },
        currency: { width: 80 },
        invoiceDate: { width: 110 },
        usageStart: { width: 120 },
        usageEnd: { width: 120 },
        dueDate: { width: 130 },
        dueAmount: {
          width: 130,
          align: "right",
          render: (r) => (
            <strong className={`num${r.dueAmount > 0 ? " tone-warning" : ""}`}>{money(r.dueAmount, r.currency)}</strong>
          ),
        },
        openingBalance: { width: 140, align: "right", render: (r) => balance(r.openingBalance, r.currency) },
        usageCharges: {
          width: 130,
          align: "right",
          render: (r) => <span className="num">{money(r.usageCharges, r.currency)}</span>,
        },
        closingBalance: { width: 140, align: "right", render: (r) => balance(r.closingBalance, r.currency) },
        emailStatus: { width: 100, render: (r) => (r.emailStatus === "sent" ? "Sent" : muted("UnSent")) },
        status: { width: 120, render: (r) => <Status s={r.status} /> },
        paymentStatus: {
          width: 110,
          render: (r) => (
            <span>
              <StatusDot tone={PAYMENT_STATUS[r.paymentStatus]!.tone} /> {PAYMENT_STATUS[r.paymentStatus]!.label}
            </span>
          ),
        },
        remarks: { width: 200, render: (r) => r.remarks ?? muted("—") },
      }}
      trailing={{
        header: "PDF · Charges",
        width: 110,
        render: (r) => (
          <span className="row-icons">
            <button
              type="button"
              className="icon-btn"
              aria-label={`Download ${r.invoiceNumber} PDF`}
              title="Download PDF"
              disabled={r.status !== "completed"}
              onClick={(e) => {
                e.stopPropagation();
                pdf(r.id);
              }}
            >
              <Icon name="download" size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Charge details of ${r.invoiceNumber}`}
              title="Charge Details"
              onClick={(e) => {
                e.stopPropagation();
                void openCharges(r);
              }}
            >
              <Icon name="list" size={13} />
            </button>
          </span>
        ),
      }}
      selection={{
        summary: (rows, ids) => {
          const picked = rows.filter((r) => ids.has(r.id));
          const due = picked.reduce((t, r) => t + r.dueAmount, 0);
          const ccys = new Set(picked.map((r) => r.currency));
          return `${ids.size} selected${picked.length && ccys.size === 1 ? ` · due ${money(due, [...ccys][0])}` : ""}`;
        },
        bulk: (ids, clear) => [
          { label: "Send Invoice", icon: "mail", onSelect: () => sendMany(ids, clear) },
          { label: "Mark…", icon: "check", onSelect: () => void markMany(ids, clear) },
        ],
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.invoiceNumber} · {money(r.dueAmount, r.currency)} due
            </strong>
            <span className="muted">
              {r.enterprise} · {r.usageStart} → {r.usageEnd}
            </span>
          </>
        ),
        sections: [
          { key: "invoice", label: "Invoice", content: <InvoiceDetailView row={r} onRegenerate={doRegenerate} /> },
          { key: "charges", label: "Charge details", content: <ChargesTable id={r.id} /> },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["invoice"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Space selects · Ctrl+Z undo"
    />
  );
}

export function InvoicesPage() {
  const [view, go] = useView();
  const follow = useFollowRequests();
  const generate = () =>
    void ask<InvoiceRequestRow[]>((done) => <GenerateDialog done={done} />).then((rows) => {
      if (!rows?.length) return;
      toast({ tone: "info", message: `${rows.length} request${rows.length === 1 ? "" : "s"} started` });
      go("requests");
      follow(rows);
    });
  return view === "requests" ? <RequestsView onGenerate={generate} /> : <InvoicesView onGenerate={generate} />;
}
