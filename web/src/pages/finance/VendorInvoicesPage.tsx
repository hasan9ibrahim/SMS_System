// Vendor invoices and reconciliation (§7, §13.31): one page with three views in the tab URL
// (?view=): Invoices (grid with their and our figures, dispute amount, check and status; Add,
// Import, Export; the result screen per invoice with Accept / Reject / Keep pending, e-mails, notes
// and history), Rules (default plus per partner tolerance) and Summary (monthly, for billing).
// Every save is one undoable change (§13.10); delete archives and is blocked while accepted (§13.29).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import type {
  EmailPreview,
  Enterprise,
  ReconRuleInput,
  ReconRuleRow,
  UserSummary,
  VendorInvoiceDetail,
  VendorInvoiceInput,
  VendorInvoiceRow,
} from "@sms/contract";
import {
  previewVendorEmail,
  summariseVendorInvoices,
  useDecideVendorInvoice,
  useNoteVendorInvoice,
  useRecheckVendorInvoice,
  useSaveReconRule,
  useSaveVendorInvoice,
  useVendorComparison,
  useVendorInvoice,
} from "../../api/invoices";
import { downloadCsv } from "../../api/masterData";
import { usePlatformCurrency, useReference } from "../../api/records";
import { FormField, NumberField, Section, SelectField, TextField, useForm } from "../../form/form";
import { toListQuery } from "../../grid/filterModel";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { PageHeader } from "../../page/PageHeader";
import { ListLookup } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { fmtWhen, openImport, RecordActions } from "../reference/shared";
import { problemText } from "../routing/dialogs";
import { money } from "./financeModel";
import {
  blankVendorInvoice,
  comparisonInfo,
  DEFAULT_RULE,
  diffTone,
  EMAIL_STATUS,
  lastMonths,
  parseLines,
  RECON_STATUS,
  SOA_LABEL,
  toleranceWords,
  utcTime,
  vendorInvoiceInput,
  zonedTime,
} from "./invoiceModel";

const page = pageForPath("/finance/vendor-invoices")!;
const muted = (v: string) => <span className="muted">{v}</span>;

type View = "invoices" | "rules" | "summary";
const VIEWS: { key: View; label: string }[] = [
  { key: "invoices", label: "Invoices" },
  { key: "rules", label: "Reconciliation rules" },
  { key: "summary", label: "Monthly summary" },
];

function useView(): [View, (v: View) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const raw = new URLSearchParams(location.search).get("view");
  const view: View = raw === "rules" || raw === "summary" ? raw : "invoices";
  return [view, (v) => navigate(`/finance/vendor-invoices${v === "invoices" ? "" : `?view=${v}`}`)];
}

function ViewSwitch({ note }: { note?: string }) {
  const [view, go] = useView();
  return (
    <div className="rm-trunk">
      <div className="segmented small" role="radiogroup" aria-label="Vendor invoice view">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="radio"
            aria-checked={view === v.key}
            className={view === v.key ? "on" : ""}
            onClick={() => go(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

const StatusCell = ({ s }: { s: VendorInvoiceRow["status"] }) => (
  <span>
    <StatusDot tone={RECON_STATUS[s].tone} /> {RECON_STATUS[s].label}
  </span>
);
const CheckCell = ({ c }: { c: VendorInvoiceRow["comparison"] }) => (
  <span>
    <StatusDot tone={comparisonInfo(c).tone} hollow={c === null || c === "no_data"} /> {comparisonInfo(c).label}
  </span>
);

// ---------------------------------------------------------------- add / edit

function VendorInvoiceEditor({
  detail,
  done,
}: {
  detail: VendorInvoiceDetail | null;
  done: (id: number | null) => void;
}) {
  const form = useForm<VendorInvoiceInput>(detail ? vendorInvoiceInput(detail) : blankVendorInvoice());
  const v = form.values;
  const ref = useReference().data;
  const save = useSaveVendorInvoice();
  const notifySaved = useNotifySaved();
  const [linesText, setLinesText] = useState("");
  const [editLines, setEditLines] = useState(!detail);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseLines(linesText);
  const submit = () => {
    if (!v.enterpriseId) return setError("Choose the enterprise.");
    if (parsed.error) return setError(parsed.error);
    const input: VendorInvoiceInput = {
      ...v,
      invoiceNumber: v.invoiceNumber.trim(),
      remarks: v.remarks?.trim() || null,
      ...(editLines ? { lines: parsed.lines } : {}),
    };
    save.mutate(
      { id: detail?.id ?? null, input },
      {
        onSuccess: (r) => {
          const res = comparisonInfo(r.record.comparison).label;
          if (r.change)
            notifySaved(
              r.change,
              `${detail ? "Saved" : "Added"} ${r.record.invoiceNumber} · ${res} · ${RECON_STATUS[r.record.status].label}`,
            );
          else toast({ tone: "info", message: "Nothing changed" });
          done(r.record.id);
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  return (
    <Modal
      title={detail ? `Edit vendor invoice ${detail.invoiceNumber}` : "Add vendor invoice"}
      width={860}
      onClose={() => done(null)}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="save" disabled={save.isPending} onClick={submit}>
            {detail ? "Save and check" : "Add and check"}
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
        <Section title="Vendor Invoice" columns={3}>
          <FormField label="Enterprise" required error={form.error("enterpriseId")}>
            <ListLookup<Enterprise>
              list="enterprises"
              value={v.enterpriseId || null}
              onChange={(e) => form.set("enterpriseId", e?.id ?? 0)}
              labelOf={(e) => e.name}
              detailOf={(e) => `${e.alias} · ${e.type}`}
              fixed={[{ field: "type", op: "in", values: ["vendor", "reciprocal"] }]}
              placeholder="Enterprise name or alias…"
              clearable={false}
            />
          </FormField>
          <TextField form={form} path="invoiceNumber" label="Invoice Number" required maxLength={60} nullable={false} />
          <SelectField
            form={form}
            path="currency"
            label="Currency"
            options={(ref?.currencies ?? []).map((c) => ({ value: c.iso, label: `${c.iso} · ${c.name}` }))}
            placeholder="Vendor billing currency"
          />
          <NumberField
            form={form}
            path="chargeVolume"
            label="Charge Volume"
            min={0}
            step={1}
            hint="Messages on the invoice"
          />
          <NumberField form={form} path="chargeAmount" label="Charge Amount" required min={0} step={0.01} />
          <SelectField
            form={form}
            path="timezone"
            label="Timezone"
            options={(ref?.timezones ?? ["UTC"]).map((z) => ({ value: z, label: z }))}
            placeholder="Partner's billing time zone"
            hint="Our figures are cut at midnight here (§13.31)"
          />
          <FormField label="Invoice Date" required error={form.error("invoiceDate")}>
            <input type="date" value={v.invoiceDate} onChange={(e) => form.set("invoiceDate", e.target.value)} />
          </FormField>
          <FormField label="Invoice Due Date" error={form.error("dueDate")}>
            <input type="date" value={v.dueDate ?? ""} onChange={(e) => form.set("dueDate", e.target.value || null)} />
          </FormField>
          <span />
          <FormField label="Invoice From Date" required error={form.error("periodFrom")}>
            <input type="date" value={v.periodFrom} onChange={(e) => form.set("periodFrom", e.target.value)} />
          </FormField>
          <FormField label="Invoice To Date" required error={form.error("periodTo")}>
            <input type="date" value={v.periodTo} onChange={(e) => form.set("periodTo", e.target.value)} />
          </FormField>
          <span />
          <TextField form={form} path="remarks" label="Remarks" wide maxLength={500} />
        </Section>
        <Section
          title="Per-destination lines (optional)"
          columns={1}
          note={
            detail && !editLines ? (
              <button type="button" className="link small" onClick={() => setEditLines(true)}>
                Replace the {detail.lineCount} line{detail.lineCount === 1 ? "" : "s"} on file
              </button>
            ) : (
              "One line per destination: mccmnc, volume, amount"
            )
          }
        >
          {editLines ? (
            <>
              <textarea
                className="mono"
                rows={5}
                value={linesText}
                placeholder={"23410,125000,2450.00\n26201,,310.50"}
                onChange={(e) => setLinesText(e.target.value)}
              />
              <span className={`small ${parsed.error ? "error-text" : "muted"}`}>
                {parsed.error ??
                  (parsed.lines.length
                    ? `${parsed.lines.length} line${parsed.lines.length === 1 ? "" : "s"} · ${money(
                        parsed.lines.reduce((t, l) => t + l.amount, 0),
                      )}`
                    : "No lines: only the totals are compared")}
              </span>
            </>
          ) : (
            <span className="muted small">Kept as they are.</span>
          )}
        </Section>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function EditLoader({ id, done }: { id: number; done: (id: number | null) => void }) {
  const q = useVendorInvoice(id);
  if (q.data) return <VendorInvoiceEditor detail={q.data} done={done} />;
  return (
    <Modal title="Loading vendor invoice…" onClose={() => done(null)} width={360}>
      <p className={q.isError ? "error-text" : "muted"}>{q.isError ? problemText(q.error) : "Loading…"}</p>
    </Modal>
  );
}

const openEditor = (id: number | null) =>
  ask<number>((done) =>
    id === null ? <VendorInvoiceEditor detail={null} done={done} /> : <EditLoader id={id} done={done} />,
  );

// ---------------------------------------------------------------- decisions

type Action = "accept" | "reject" | "keep_pending" | "send_acceptance";
const ACTION_LABEL: Record<Action, string> = {
  accept: "Accept",
  reject: "Reject",
  keep_pending: "Keep pending",
  send_acceptance: "Send acceptance",
};

function DecisionDialog({ inv, action, done }: { inv: VendorInvoiceDetail; action: Action; done: () => void }) {
  const decide = useDecideVendorInvoice();
  const notifySaved = useNotifySaved();
  const [note, setNote] = useState("");
  const [sendEmail, setSendEmail] = useState(action !== "keep_pending");
  const [error, setError] = useState<string | null>(null);
  const kind = action === "reject" ? "rejection" : "acceptance";
  const mails = action !== "keep_pending";
  const needsNote =
    action === "reject" || action === "keep_pending" || (action === "accept" && inv.comparison !== "match");
  const preview = useQuery<EmailPreview>({
    queryKey: ["vendor-email", inv.id, kind, note],
    queryFn: () => previewVendorEmail(inv.id, { kind, note: note.trim() || null }),
    enabled: mails && sendEmail,
  });
  const submit = () =>
    decide.mutate(
      { id: inv.id, body: { action, note: note.trim() || null, sendEmail: mails && sendEmail } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, r.change.note ?? "Saved");
          done();
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  return (
    <Modal
      title={`${ACTION_LABEL[action]} · ${inv.invoiceNumber}`}
      width={640}
      onClose={done}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button variant="primary" disabled={decide.isPending || (needsNote && !note.trim())} onClick={submit}>
            {ACTION_LABEL[action]}
            {mails && sendEmail && action !== "send_acceptance" ? " and e-mail" : ""}
          </Button>
        </>
      }
    >
      {action !== "send_acceptance" && (
        <label className="field">
          <span>
            {action === "reject" ? "Reason" : "Note"}
            {needsNote && <span className="req">*</span>}
          </span>
          <textarea
            rows={3}
            autoFocus
            value={note}
            maxLength={1000}
            placeholder={
              action === "accept"
                ? "e.g. agreed after discussion, credit note received"
                : "Why, for the partner and the team"
            }
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      )}
      {mails && action !== "send_acceptance" && (
        <label className="toggle-inline">
          <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
          Send the {kind} e-mail to the partner
        </label>
      )}
      {mails && sendEmail && (
        <div className="mail-preview">
          {preview.data ? (
            <>
              <div className="small">
                <strong>To:</strong>{" "}
                {preview.data.recipients.length ? (
                  preview.data.recipients.join(", ")
                ) : (
                  <span className="tone-error">no billing contact</span>
                )}
              </div>
              <div className="small">
                <strong>Subject:</strong> {preview.data.subject}
              </div>
              <pre>{preview.data.body}</pre>
            </>
          ) : (
            <span className="muted small">
              {preview.isError ? problemText(preview.error) : "Preparing the e-mail…"}
            </span>
          )}
        </div>
      )}
      {action === "keep_pending" && (
        <p className="muted small">The invoice stays Disputed and waits; the note is kept for reference (§13.31).</p>
      )}
    </Modal>
  );
}

function NoteDialog({ id, done }: { id: number; done: () => void }) {
  const add = useNoteVendorInvoice();
  const [note, setNote] = useState("");
  return (
    <Modal
      title="Add note"
      width={480}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!note.trim() || add.isPending}
            onClick={() =>
              add.mutate(
                { id, note: note.trim() },
                { onSuccess: done, onError: (e) => toast({ tone: "error", message: problemText(e) }) },
              )
            }
          >
            Add note
          </Button>
        </>
      }
    >
      <textarea rows={4} autoFocus value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
    </Modal>
  );
}

// ---------------------------------------------------------------- result screen

const EVENT_LABEL: Record<string, string> = {
  created: "Received",
  edited: "Edited",
  checked: "Checked",
  status: "Status",
  note: "Note",
  email: "E-mail",
};

function ResultView({ row }: { row: VendorInvoiceRow }) {
  const q = useVendorInvoice(row.id);
  const recheck = useRecheckVendorInvoice();
  const notifySaved = useNotifySaved();
  const d = q.data;
  if (!d) return <p className="muted">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  const decide = (action: Action) =>
    void ask<void>((done) => <DecisionDialog inv={d} action={action} done={() => done()} />);
  const live = !d.archivedAt;
  return (
    <div className="tr-detail">
      <div className="detail-actions">
        {live && (
          <>
            {d.status !== "accepted" && (
              <Button small icon="check" onClick={() => decide("accept")}>
                Accept
              </Button>
            )}
            {d.status !== "rejected" && (
              <Button small icon="x" onClick={() => decide("reject")}>
                Reject
              </Button>
            )}
            {d.status !== "disputed" && d.status !== "rejected" && (
              <Button small icon="clock" onClick={() => decide("keep_pending")}>
                Keep pending
              </Button>
            )}
            {d.status === "accepted" && d.emailStatus !== "sent" && (
              <Button small icon="mail" onClick={() => decide("send_acceptance")}>
                Send acceptance
              </Button>
            )}
            <Button
              small
              icon="refresh"
              disabled={recheck.isPending}
              onClick={() =>
                recheck.mutate(d.id, {
                  onSuccess: (r) =>
                    r.change
                      ? notifySaved(r.change, `Checked: ${comparisonInfo(r.record.comparison).label}`)
                      : toast({
                          tone: "info",
                          message: `Checked again: ${comparisonInfo(r.record.comparison).label}, nothing changed`,
                        }),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                })
              }
            >
              Check again
            </Button>
            <Button small icon="file" onClick={() => void openEditor(d.id)}>
              Edit
            </Button>
            <Button
              small
              icon="plus"
              onClick={() => void ask<void>((done) => <NoteDialog id={d.id} done={() => done()} />)}
            >
              Note
            </Button>
          </>
        )}
        <RecordActions
          kind="vendor_invoice"
          id={d.id}
          name={`vendor invoice ${d.invoiceNumber}`}
          archived={!!d.archivedAt}
        />
      </div>
      <div className="recon-figures">
        <div>
          <span className="muted small">Their amount</span>
          <strong className="num">{money(d.chargeAmount, d.currency)}</strong>
          <span className="muted small num">
            {d.chargeVolume === null ? "no count" : `${d.chargeVolume.toLocaleString("en-US")} msgs`}
          </span>
        </div>
        <div>
          <span className="muted small">Our amount</span>
          <strong className="num">{d.ourAmount === null ? "—" : money(d.ourAmount, d.currency)}</strong>
          <span className="muted small num">
            {d.ourVolume === null ? "not checked" : `${d.ourVolume.toLocaleString("en-US")} msgs`}
          </span>
        </div>
        <div>
          <span className="muted small">Difference</span>
          <strong className={`num ${diffTone(d.differencePct)}`}>
            {d.disputeAmount === null ? "—" : money(d.disputeAmount, d.currency)}
          </strong>
          <span className={`small num ${diffTone(d.differencePct)}`}>
            {d.differencePct === null ? "" : `${d.differencePct > 0 ? "+" : ""}${d.differencePct.toFixed(2)} %`}
            {d.volumeDifference !== null
              ? ` · ${d.volumeDifference > 0 ? "+" : ""}${d.volumeDifference.toLocaleString("en-US")} msgs`
              : ""}
          </span>
        </div>
        <div>
          <span className="muted small">Result</span>
          <strong>
            <CheckCell c={d.comparison} />
          </strong>
          <span className="small">
            <StatusCell s={d.status} />
          </span>
        </div>
      </div>
      <dl className="kv">
        <dt>Partner</dt>
        <dd>
          {d.enterprise} {d.accountManager && <span className="muted small">· AM {d.accountManager}</span>}
        </dd>
        <dt>Period</dt>
        <dd>
          {d.periodFrom} → {d.periodTo} <span className="muted small">({d.timezone}, printed on every result)</span>
        </dd>
        <dt>Input period</dt>
        <dd>
          {d.inputFrom && d.inputTo ? (
            <>
              <span className="num">
                {utcTime(d.inputFrom)} → {utcTime(d.inputTo)} UTC
              </span>{" "}
              <span className="muted small">
                = {zonedTime(d.inputFrom, d.timezone)} → {zonedTime(d.inputTo, d.timezone)} in {d.timezone}: the window
                our figures were counted for
              </span>
            </>
          ) : (
            muted("not counted: see the check below")
          )}
        </dd>
        <dt>Dates</dt>
        <dd>
          invoiced {d.invoiceDate}
          {d.dueDate ? ` · due ${d.dueDate}` : ""} ·{" "}
          {d.source === "email" ? "from the billing mailbox" : d.source === "import" ? "imported" : "added by hand"}
        </dd>
        <dt>Check</dt>
        <dd>
          {d.reasons.length
            ? d.reasons.map((r, i) => (
                <div key={i} className="small">
                  {r}
                </div>
              ))
            : muted("not checked yet")}
          {d.checkedAt && <div className="muted small">checked {fmtWhen(d.checkedAt)}</div>}
        </dd>
        <dt>Rule used</dt>
        <dd className="small">
          {d.rule
            ? `amount ${toleranceWords(d.rule.amountPct, d.rule.amountFixed, d.rule.amountCombine, d.currency)} · count ${toleranceWords(
                d.rule.countPct,
                d.rule.countFixed,
                d.rule.countCombine,
                "messages",
              )}${d.rule.destinationPct !== null ? ` · destinations ${d.rule.destinationPct} %` : ""}`
            : muted("—")}
        </dd>
        <dt>E-mail</dt>
        <dd>{EMAIL_STATUS[d.emailStatus]}</dd>
        <dt>SOA</dt>
        <dd>{SOA_LABEL[d.inSoa]}</dd>
        {d.remarks && (
          <>
            <dt>Remarks</dt>
            <dd>{d.remarks}</dd>
          </>
        )}
      </dl>
      <h4 className="section-label">Notes and history</h4>
      <ul className="recon-events">
        {d.events.map((e) => (
          <li key={e.id}>
            <span className="muted small num">{fmtWhen(e.at)}</span>{" "}
            <strong className="small">{EVENT_LABEL[e.kind]}</strong>{" "}
            {e.statusTo && (
              <span className="small">
                {e.statusFrom
                  ? `${RECON_STATUS[e.statusFrom as keyof typeof RECON_STATUS]?.label ?? e.statusFrom} → `
                  : "→ "}
                {RECON_STATUS[e.statusTo as keyof typeof RECON_STATUS]?.label ?? e.statusTo}
              </span>
            )}{" "}
            <span className="muted small">{e.user ?? "platform"}</span>
            {e.note && <div className="small pre-line">{e.note}</div>}
            {e.emailTo.length > 0 && <div className="muted small">to {e.emailTo.join(", ")}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DestinationsView({ row }: { row: VendorInvoiceRow }) {
  const q = useVendorComparison(row.id, row.checkedAt);
  const c = q.data;
  if (!c) return <p className="muted">{q.isError ? problemText(q.error) : "Reading our EDRs…"}</p>;
  const withLines = c.rows.some((r) => r.theirAmount !== null);
  return (
    <div className="inv-charges">
      <p className="muted small">
        Our vendor cost per destination for {c.from} → {c.to} in {c.timezone}
        {withLines ? ", against the invoice lines, largest difference first" : "; the invoice has no destination lines"}
        .
      </p>
      {c.coverage !== "full" && (
        <p className="tone-warning small">
          EDRs in this environment cover {c.edrFrom?.slice(0, 10) ?? "—"} to {c.edrTo?.slice(0, 10) ?? "—"}: the period
          is {c.coverage === "none" ? "not covered" : "only partly covered"}.
        </p>
      )}
      {c.rows.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>MCCMNC</th>
              <th>Country · network</th>
              {withLines && <th className="num">Their msgs</th>}
              {withLines && <th className="num">Their amount</th>}
              <th className="num">Our msgs</th>
              <th className="num">Our amount</th>
              {withLines && <th className="num">Difference</th>}
            </tr>
          </thead>
          <tbody>
            {c.rows.slice(0, 300).map((r) => (
              <tr key={r.mccmnc} className={r.flagged ? "flagged" : undefined}>
                <td className="num">{r.mccmnc}</td>
                <td>
                  {r.country ?? "—"} <span className="muted small">{r.network ?? ""}</span>
                </td>
                {withLines && <td className="num">{r.theirVolume?.toLocaleString("en-US") ?? "—"}</td>}
                {withLines && <td className="num">{r.theirAmount === null ? "—" : money(r.theirAmount)}</td>}
                <td className="num">{r.ourVolume.toLocaleString("en-US")}</td>
                <td className="num">{money(r.ourAmount)}</td>
                {withLines && (
                  <td className={`num ${r.flagged ? "tone-error" : diffTone(r.differencePct)}`}>
                    {r.difference === null ? "—" : money(r.difference)}
                    {r.differencePct !== null && <span className="small"> ({r.differencePct.toFixed(1)} %)</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- invoices view

function InvoicesView() {
  const [selectId, setSelectId] = useState<number | null>(null);
  const importFile = () =>
    void openImport({
      target: { kind: "vendor_invoices" },
      title: "Vendor Invoice import",
      addOnly: true,
      replaceHint: "",
      help: (
        <>
          Columns: <code>enterprise</code> (name or alias), <code>invoice_number</code>, <code>charge_volume</code>,{" "}
          <code>charge_amount</code>, <code>currency</code>, <code>invoice_date</code>, <code>due_date</code>,{" "}
          <code>period_from</code>, <code>period_to</code>, <code>timezone</code>, <code>remarks</code>. Dates as
          YYYY-MM-DD; empty currency and time zone take the partner&apos;s billing settings. Each invoice is checked
          against our EDRs as it is added; invoices already on file are left as they are.
        </>
      ),
    });
  return (
    <ListScreen<VendorInvoiceRow>
      list="vendor_invoices"
      page={page}
      selectId={selectId}
      historyScope={{ entityTypes: ["vendor_invoice"] }}
      above={
        <ViewSwitch note="Dispute amount = their amount − ours, from our EDRs for the same period and time zone." />
      }
      primary={{
        label: "Add",
        icon: "plus",
        onClick: () => void openEditor(null).then((id) => id && setSelectId(id)),
      }}
      actions={
        <Button small icon="upload" onClick={importFile}>
          Import
        </Button>
      }
      onExport={(s) =>
        void downloadCsv("/vendor-invoices/export", toListQuery(s)).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        id: { width: 80 },
        enterprise: { width: 210, render: (r) => <strong>{r.enterprise}</strong> },
        invoiceNumber: { width: 150 },
        status: { width: 110, render: (r) => <StatusCell s={r.status} /> },
        comparison: { width: 120, render: (r) => <CheckCell c={r.comparison} /> },
        chargeVolume: {
          width: 120,
          align: "right",
          render: (r) =>
            r.chargeVolume === null ? (
              muted("—")
            ) : (
              <span className="num">{r.chargeVolume.toLocaleString("en-US")}</span>
            ),
        },
        chargeAmount: {
          width: 130,
          align: "right",
          render: (r) => <span className="num">{money(r.chargeAmount, r.currency)}</span>,
        },
        ourAmount: {
          width: 130,
          align: "right",
          render: (r) =>
            r.ourAmount === null ? muted("—") : <span className="num">{money(r.ourAmount, r.currency)}</span>,
        },
        disputeAmount: {
          width: 130,
          align: "right",
          render: (r) =>
            r.disputeAmount === null ? (
              muted("—")
            ) : (
              <span className={`num ${diffTone(r.differencePct)}`}>{money(r.disputeAmount, r.currency)}</span>
            ),
        },
        differencePct: {
          width: 100,
          align: "right",
          render: (r) =>
            r.differencePct === null ? (
              muted("—")
            ) : (
              <span className={`num ${diffTone(r.differencePct)}`}>{r.differencePct.toFixed(2)} %</span>
            ),
        },
        invoiceDate: { width: 110 },
        dueDate: { width: 120, render: (r) => r.dueDate ?? muted("—") },
        periodFrom: { width: 120 },
        periodTo: { width: 120 },
        inputFrom: {
          width: 150,
          render: (r) =>
            r.inputFrom ? (
              <span className="num" title={`${zonedTime(r.inputFrom, r.timezone)} in ${r.timezone}`}>
                {utcTime(r.inputFrom)}
              </span>
            ) : (
              muted("not counted")
            ),
        },
        inputTo: {
          width: 150,
          render: (r) =>
            r.inputTo ? (
              <span className="num" title={`${zonedTime(r.inputTo, r.timezone)} in ${r.timezone}`}>
                {utcTime(r.inputTo)}
              </span>
            ) : (
              muted("—")
            ),
        },
        emailStatus: { width: 130, render: (r) => EMAIL_STATUS[r.emailStatus] },
        remarks: { width: 200, render: (r) => r.remarks ?? muted("—") },
      }}
      onOpen={(r) => !r.archivedAt && void openEditor(r.id)}
      selection={{
        summary: (rows, ids) => {
          const picked = rows.filter((r) => ids.has(r.id));
          const ccys = new Set(picked.map((r) => r.currency));
          const diff = picked.reduce((t, r) => t + (r.disputeAmount ?? 0), 0);
          return `${ids.size} selected${picked.length && ccys.size === 1 ? ` · difference ${money(diff, [...ccys][0])}` : ""}`;
        },
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.invoiceNumber} · {money(r.chargeAmount, r.currency)}
            </strong>
            <span className="muted">
              {r.enterprise} · {r.periodFrom} → {r.periodTo}
            </span>
          </>
        ),
        sections: [
          { key: "result", label: "Reconciliation", content: <ResultView row={r} /> },
          { key: "destinations", label: "Destinations", content: <DestinationsView row={r} /> },
          {
            key: "history",
            label: "Changes",
            content: <HistoryList scope={{ entityTypes: ["vendor_invoice"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}

// ---------------------------------------------------------------- rules view

function RuleDialog({ row, done }: { row: ReconRuleRow | null; done: () => void }) {
  const form = useForm<ReconRuleInput>(row ? { ...row } : { ...DEFAULT_RULE, enterpriseId: null });
  const v = form.values;
  const save = useSaveReconRule();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const isDefault = row !== null && row.enterpriseId === null;
  const unit = row?.currency ?? "in the invoice currency";
  const submit = () => {
    if (!row && !v.enterpriseId) return setError("Choose the partner.");
    const input: ReconRuleInput = {
      enterpriseId: v.enterpriseId,
      amountPct: v.amountPct,
      amountFixed: v.amountFixed,
      amountCombine: v.amountCombine,
      countPct: v.countPct,
      countFixed: v.countFixed,
      countCombine: v.countCombine,
      destinationPct: v.destinationPct,
      autoSend: v.autoSend,
      disputedInSoa: v.disputedInSoa,
    };
    save.mutate(
      { id: row?.id ?? null, input },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${row ? "Saved" : "Added"} rule: ${r.record.enterprise ?? "default"}`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  const combine = [
    { value: "stricter", label: "Both must hold (stricter)" },
    { value: "looser", label: "Either is enough (looser)" },
  ];
  return (
    <Modal
      title={
        isDefault ? "Default reconciliation rule" : row ? `Rule for ${row.enterprise}` : "Partner reconciliation rule"
      }
      width={760}
      onClose={done}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button variant="primary" icon="save" disabled={save.isPending} onClick={submit}>
            {row ? "Save" : "Add rule"}
          </Button>
        </>
      }
    >
      <Section title="Partner" columns={1} note="Enterprise › Billing › Reconciliation rules (§13.31)">
        {isDefault ? (
          <p className="muted small">Applies to every partner without its own rule.</p>
        ) : (
          <FormField label="Enterprise" required error={form.error("enterpriseId")}>
            <ListLookup<Enterprise>
              list="enterprises"
              value={v.enterpriseId}
              onChange={(e) => form.set("enterpriseId", e?.id ?? null)}
              labelOf={(e) => e.name}
              detailOf={(e) => `${e.alias} · ${e.type}`}
              fixed={[{ field: "type", op: "in", values: ["vendor", "reciprocal"] }]}
              disabled={!!row}
              clearable={false}
            />
          </FormField>
        )}
      </Section>
      <Section title="Amount" columns={3}>
        <NumberField form={form} path="amountPct" label="Within %" min={0} max={100} step={0.1} suffix="%" />
        <NumberField form={form} path="amountFixed" label="Within amount" min={0} step={0.01} hint={unit} />
        <SelectField form={form} path="amountCombine" label="With both" required options={combine} />
      </Section>
      <Section title="Message count" columns={3}>
        <NumberField form={form} path="countPct" label="Within %" min={0} max={100} step={0.1} suffix="%" />
        <NumberField form={form} path="countFixed" label="Within messages" min={0} step={1} />
        <SelectField form={form} path="countCombine" label="With both" required options={combine} />
      </Section>
      <Section title="Per destination and outcome" columns={3}>
        <NumberField
          form={form}
          path="destinationPct"
          label="Flag a destination off by more than"
          min={0}
          max={100}
          step={0.5}
          suffix="%"
          hint="Empty = no per-destination check"
        />
        <SelectField
          form={form}
          path="autoSend"
          label="Acceptance e-mail on a match"
          required
          options={[
            { value: "auto", label: "Send at once" },
            { value: "confirm", label: "Confirm before sending" },
          ]}
        />
        <SelectField
          form={form}
          path="disputedInSoa"
          label="Rejected and pending in the SOA"
          required
          options={[
            { value: "separate_block", label: "Separate “disputed” block" },
            { value: "exclude", label: "Left off" },
          ]}
        />
      </Section>
    </Modal>
  );
}

function RulesView() {
  const open = (row: ReconRuleRow | null) => ask<void>((d) => <RuleDialog row={row} done={() => d()} />);
  return (
    <ListScreen<ReconRuleRow>
      list="recon_rules"
      page={page}
      title="Reconciliation rules"
      noSelection
      historyScope={{ entityTypes: ["recon_rule"] }}
      above={
        <ViewSwitch note="A partner matches when amount and count are within tolerance. Later rule changes do not alter past results." />
      }
      primary={{ label: "Add partner rule", icon: "plus", onClick: () => void open(null) }}
      columns={{
        enterprise: {
          width: 230,
          render: (r) => (r.enterpriseId === null ? <strong>Default rule</strong> : <strong>{r.enterprise}</strong>),
        },
        amountPct: {
          width: 100,
          align: "right",
          render: (r) => (r.amountPct === null ? muted("—") : `${r.amountPct} %`),
        },
        amountFixed: {
          width: 130,
          align: "right",
          render: (r) =>
            r.amountFixed === null ? muted("—") : <span className="num">{money(r.amountFixed, r.currency)}</span>,
        },
        amountCombine: { width: 140, render: (r) => (r.amountCombine === "stricter" ? "Both" : "Either") },
        countPct: { width: 100, align: "right", render: (r) => (r.countPct === null ? muted("—") : `${r.countPct} %`) },
        countFixed: {
          width: 120,
          align: "right",
          render: (r) => (r.countFixed === null ? muted("—") : r.countFixed.toLocaleString("en-US")),
        },
        countCombine: { width: 120, render: (r) => (r.countCombine === "stricter" ? "Both" : "Either") },
        destinationPct: {
          width: 120,
          align: "right",
          render: (r) => (r.destinationPct === null ? muted("off") : `${r.destinationPct} %`),
        },
        autoSend: { width: 170, render: (r) => (r.autoSend === "auto" ? "Send at once" : "Confirm before sending") },
        disputedInSoa: { width: 150, render: (r) => (r.disputedInSoa === "exclude" ? "Left off" : "Separate block") },
        invoices: { width: 100, align: "right" },
      }}
      onOpen={(r) => !r.archivedAt && void open(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.enterprise ?? "Default rule"}</strong>
            <span className="muted">{r.invoices.toLocaleString("en-US")} vendor invoices</span>
          </>
        ),
        sections: [
          {
            key: "rule",
            label: "Rule",
            actions:
              r.enterpriseId === null ? (
                <Button small icon="file" onClick={() => void open(r)}>
                  Edit
                </Button>
              ) : (
                <RecordActions
                  kind="recon_rule"
                  id={r.id}
                  name={`${r.enterprise}'s rule`}
                  archived={!!r.archivedAt}
                  onEdit={() => void open(r)}
                />
              ),
            content: (
              <dl className="kv">
                <dt>Amount</dt>
                <dd>
                  within{" "}
                  {toleranceWords(r.amountPct, r.amountFixed, r.amountCombine, r.currency ?? "in the invoice currency")}
                </dd>
                <dt>Count</dt>
                <dd>within {toleranceWords(r.countPct, r.countFixed, r.countCombine, "messages")}</dd>
                <dt>Destinations</dt>
                <dd>{r.destinationPct === null ? "not checked" : `flag any off by more than ${r.destinationPct} %`}</dd>
                <dt>On a match</dt>
                <dd>Accepted; acceptance e-mail {r.autoSend === "auto" ? "sent at once" : "waits for confirmation"}</dd>
                <dt>SOA</dt>
                <dd>
                  Rejected and pending invoices{" "}
                  {r.disputedInSoa === "exclude" ? "left off" : "in a separate disputed block"}
                </dd>
                <dt>Updated</dt>
                <dd>
                  {fmtWhen(r.updatedAt)} {r.updatedBy ? `by ${r.updatedBy}` : ""}
                </dd>
              </dl>
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["recon_rule"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}

// ---------------------------------------------------------------- summary view

function SummaryView() {
  const platform = usePlatformCurrency();
  const init = lastMonths(12);
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [enterpriseId, setEnterpriseId] = useState<number | null>(null);
  const [amId, setAmId] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["vendor-summary", from, to, enterpriseId, amId],
    queryFn: () => summariseVendorInvoices({ fromMonth: from, toMonth: to, enterpriseId, accountManagerId: amId }),
  });
  const rows = q.data?.rows ?? [];
  const total = (k: "invoices" | "match" | "mismatch" | "disputed" | "theirAmount" | "ourAmount" | "difference") =>
    rows.reduce((t, r) => t + r[k], 0);
  return (
    <div className="page charges-page">
      <PageHeader page={page} />
      <ViewSwitch note="For the billing team: how many partner invoices matched, and the money in dispute." />
      <div className="charges-form recon-summary-form">
        <label className="field">
          <span>From month</span>
          <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>To month</span>
          <input type="month" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="field">
          <span>Partner</span>
          <ListLookup<Enterprise>
            list="enterprises"
            value={enterpriseId}
            onChange={(e) => setEnterpriseId(e?.id ?? null)}
            labelOf={(e) => e.name}
            fixed={[{ field: "type", op: "in", values: ["vendor", "reciprocal"] }]}
            placeholder="All partners"
          />
        </div>
        <div className="field">
          <span>Account manager</span>
          <ListLookup<UserSummary>
            list="users"
            value={amId}
            onChange={(u) => setAmId(u?.id ?? null)}
            labelOf={(u) => u.displayName}
            detailOf={(u) => u.username}
            fixed={[{ field: "isAccountManager", op: "eq", value: true }]}
            placeholder="All"
          />
        </div>
      </div>
      {q.isError && <p className="error-text">{problemText(q.error)}</p>}
      {q.data && (
        <div className="charges-table">
          <table className="mini-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Invoices</th>
                <th className="num">Match</th>
                <th className="num">Mismatch</th>
                <th className="num">No EDR data</th>
                <th className="num">Pending</th>
                <th className="num">Accepted</th>
                <th className="num">Disputed</th>
                <th className="num">Rejected</th>
                <th className="num">Their amount ({platform})</th>
                <th className="num">Our amount ({platform})</th>
                <th className="num">Difference ({platform})</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month}>
                  <td className="num">{r.month}</td>
                  <td className="num">{r.invoices.toLocaleString("en-US")}</td>
                  <td className="num">{r.match}</td>
                  <td className={`num${r.mismatch ? " tone-warning" : ""}`}>{r.mismatch}</td>
                  <td className="num muted">{r.noData + r.unchecked}</td>
                  <td className="num">{r.pending}</td>
                  <td className="num">{r.accepted}</td>
                  <td className={`num${r.disputed ? " tone-warning" : ""}`}>{r.disputed}</td>
                  <td className="num">{r.rejected}</td>
                  <td className="num">{money(r.theirAmount)}</td>
                  <td className="num">{money(r.ourAmount)}</td>
                  <td className={`num${Math.abs(r.difference) > 0.005 ? " tone-warning" : ""}`}>
                    {money(r.difference)}
                  </td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr className="total-row">
                  <td>Total</td>
                  <td className="num">{total("invoices").toLocaleString("en-US")}</td>
                  <td className="num">{total("match").toLocaleString("en-US")}</td>
                  <td className="num">{total("mismatch").toLocaleString("en-US")}</td>
                  <td colSpan={3} />
                  <td className="num">{total("disputed").toLocaleString("en-US")}</td>
                  <td />
                  <td className="num">{money(total("theirAmount"))}</td>
                  <td className="num">{money(total("ourAmount"))}</td>
                  <td className="num">{money(total("difference"))}</td>
                </tr>
              )}
            </tbody>
          </table>
          {rows.length === 0 && <p className="muted">No vendor invoices in these months.</p>}
        </div>
      )}
    </div>
  );
}

export function VendorInvoicesPage() {
  const [view] = useView();
  if (view === "rules") return <RulesView />;
  if (view === "summary") return <SummaryView />;
  return <InvoicesView />;
}
