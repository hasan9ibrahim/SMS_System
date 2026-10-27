// SOA (§7, §13.31, §13.33): Enterprise (multi), Invoice Type, From / To Date and the Send SOA
// e-mail template; Search lists one row per enterprise (Check All / Uncheck All, Send Email, Queue
// SOA Export). The preview shows each side's lines with source (Auto / Manual), status and running
// balance (positive = the partner's credit), the disputed block, payments left off the SOA (include
// with one click), lines removed by hand, manual entries, and how the closing balance differs from
// the system balance. Manual changes are logged and undoable (§13.10).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import type {
  Change,
  EmailPreview,
  EmailTemplateRow,
  Enterprise,
  SoaInvoiceType,
  SoaLine,
  SoaQuery,
  SoaSide,
  SoaStatement,
} from "@sms/contract";
import { useBulkTransactions } from "../../api/finance";
import {
  exportSoa,
  previewSoaEmail,
  sendSoa,
  useSoaAdjustment,
  useSoaSearch,
  useSoaStatement,
  useTakeBackAdjustment,
  waitForReports,
} from "../../api/soa";
import { useRefreshRecords } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { ListLookup } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { MultiPick, type Picked } from "../routing/pickers";
import { fmtWhen } from "../reference/shared";
import { balanceWords, money } from "./financeModel";
import { RECON_STATUS } from "./invoiceModel";
import {
  defaultPeriod,
  enterprisesParam,
  entryEffect,
  INVOICE_TYPES,
  LINE_KIND,
  lineAction,
  SIDE_TITLE,
  signedAmount,
} from "./soaModel";
import { MailBody } from "../../ui/MailPreview";

const page = pageForPath("/finance/soa")!;
const muted = (v: string) => <span className="muted">{v}</span>;
type Params = { invoiceType: SoaInvoiceType; from: string; to: string };

const Bal = ({ v, side, ccy }: { v: number; side: "customer" | "vendor"; ccy: string }) => (
  <span className={`num ${balanceWords(v, side).tone}`} title={balanceWords(v, side).text}>
    {money(v, ccy)}
  </span>
);

// ---------------------------------------------------------------- dialogs

function ReasonDialog({
  title,
  required,
  done,
}: {
  title: string;
  required: boolean;
  done: (v: string | null) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Modal
      title={title}
      width={480}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" disabled={required && !note.trim()} onClick={() => done(note.trim())}>
            Save
          </Button>
        </>
      }
    >
      <label className="field">
        <span>
          {required ? "Reason" : "Note"}
          {required && <span className="req">*</span>}
        </span>
        <input autoFocus value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
    </Modal>
  );
}

function EntryDialog({ st, done }: { st: SoaStatement; done: () => void }) {
  const save = useSoaAdjustment();
  const notifySaved = useNotifySaved();
  const [side, setSide] = useState(st.sides[0]!.side);
  const [kind, setKind] = useState<"payment" | "credit_note" | "adjustment" | "opening_balance">("payment");
  const [effect, setEffect] = useState<"raises" | "lowers">("raises");
  const [date, setDate] = useState(st.to);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  // Both options (decided 2026-10-17): SOA only, or also a real transaction that changes the balance.
  const [affectsBalance, setAffectsBalance] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ccy = st.sides.find((s) => s.side === side)!.currency;
  const submit = () =>
    save.mutate(
      {
        enterpriseId: st.enterpriseId,
        action: "entry",
        entry: {
          side,
          kind,
          date,
          amount: signedAmount(Number(amount), effect),
          currency: null,
          description: description.trim(),
          affectsBalance,
        },
        note: note.trim() || null,
      },
      {
        onSuccess: (r) => {
          if (r.change)
            notifySaved(
              r.change,
              r.record.transactionId
                ? `Manual SOA entry added and recorded as TX-${r.record.transactionId}`
                : "Manual SOA entry added (SOA only)",
            );
          done();
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  return (
    <Modal
      title={`Manual SOA entry · ${st.enterprise}`}
      width={620}
      onClose={done}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            icon="plus"
            disabled={save.isPending || !(Number(amount) > 0) || !description.trim()}
            onClick={submit}
          >
            Add entry
          </Button>
        </>
      }
    >
      <div className="form-grid cols-2">
        {st.sides.length > 1 && (
          <label className="field">
            <span>Side</span>
            <select value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
              <option value="customer">Customer</option>
              <option value="vendor">Vendor</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>Type</span>
          <select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as typeof kind;
              setKind(k);
              setEffect(entryEffect(k));
            }}
          >
            <option value="payment">Payment</option>
            <option value="credit_note">Credit note</option>
            <option value="adjustment">Adjustment</option>
            <option value="opening_balance">Opening balance</option>
          </select>
        </label>
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} min={st.from} max={st.to} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Amount ({ccy})</span>
          <input type="number" min={0.0001} step={0.0001} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <div className="field">
          <span>Effect on the balance</span>
          <div className="segmented small" role="radiogroup" aria-label="Effect">
            {(["raises", "lowers"] as const).map((x) => (
              <button
                key={x}
                type="button"
                role="radio"
                aria-checked={effect === x}
                className={effect === x ? "on" : ""}
                onClick={() => setEffect(x)}
              >
                {x === "raises" ? "Raises (credit)" : "Lowers (charge)"}
              </button>
            ))}
          </div>
        </div>
        <label className="field wide">
          <span>Description</span>
          <input value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field wide">
          <span>Note</span>
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="segmented small soa-entry-mode" role="radiogroup" aria-label="Balance">
        {([false, true] as const).map((v) => (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={affectsBalance === v}
            className={affectsBalance === v ? "on" : ""}
            onClick={() => setAffectsBalance(v)}
          >
            {v ? "Changes the balance" : "SOA only"}
          </button>
        ))}
      </div>
      <p className="muted small">
        {affectsBalance
          ? `Also records a real ${kind === "payment" ? (side === "customer" ? "Receipt" : "Bill Payment") : kind === "credit_note" ? "Credit Note" : "Adjustment"} transaction; the ${side} balance changes.`
          : "SOA only; balances do not change."}
      </p>
    </Modal>
  );
}

function SendDialog({
  ids,
  names,
  params,
  templateId,
  done,
}: {
  ids: number[];
  names: Map<number, string>;
  params: Params;
  templateId: number;
  done: (ok: boolean) => void;
}) {
  const [shown, setShown] = useState(ids[0]!);
  const [busy, setBusy] = useState(false);
  const preview = useQuery<EmailPreview>({
    queryKey: ["soa-email", shown, params, templateId],
    queryFn: () => previewSoaEmail({ enterpriseId: shown, ...params, templateId }),
  });
  const follow = useFollowReports();
  const submit = async () => {
    setBusy(true);
    try {
      const r = await sendSoa({ enterpriseIds: ids, ...params, templateId });
      follow(
        r.reports.map((x) => x.id),
        "sent",
      );
      done(true);
    } catch (e) {
      toast({ tone: "error", message: problemText(e) });
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Send SOA to ${ids.length} enterprise${ids.length === 1 ? "" : "s"}`}
      width={680}
      onClose={() => done(false)}
      footer={
        <>
          <span className="fb-spacer" />
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant="primary" icon="mail" disabled={busy} onClick={() => void submit()}>
            Send {ids.length} e-mail{ids.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      {ids.length > 1 && (
        <label className="field">
          <span>Preview for</span>
          <select value={shown} onChange={(e) => setShown(Number(e.target.value))}>
            {ids.map((id) => (
              <option key={id} value={id}>
                {names.get(id) ?? id}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="mail-preview">
        {preview.data ? (
          <>
            <div className="small">
              <strong>To:</strong>{" "}
              {preview.data.recipients.length ? (
                preview.data.recipients.join(", ")
              ) : (
                <span className="tone-error">no billing contact: this one will fail</span>
              )}
            </div>
            <div className="small">
              <strong>Subject:</strong> {preview.data.subject}
            </div>
            <MailBody body={preview.data.body} />
          </>
        ) : (
          <span className="muted small">{preview.isError ? problemText(preview.error) : "Preparing the e-mail…"}</span>
        )}
      </div>
    </Modal>
  );
}

/** Follows reports in the background and says how they ended. */
function useFollowReports() {
  const refresh = useRefreshRecords();
  return (ids: number[], verb: "sent" | "exported") => {
    toast({
      tone: "info",
      message: `${ids.length} SOA ${verb === "sent" ? "e-mail" : "export"}${ids.length === 1 ? "" : "s"} queued`,
    });
    void waitForReports(ids).then((done) => {
      void refresh();
      const failed = done.filter((r) => r.status === "failed");
      const okCount = done.length - failed.length;
      if (okCount)
        toast({ tone: "good", message: `${okCount} SOA${okCount === 1 ? "" : "s"} ${verb} · see SOA Report` });
      for (const f of failed.slice(0, 3)) toast({ tone: "error", message: `${f.enterprise}: ${f.error ?? "failed"}` });
    });
  };
}

// ---------------------------------------------------------------- statement

function LineRow({
  l,
  ccy,
  onAction,
  actionLabel,
}: {
  l: SoaLine;
  ccy: string;
  onAction?: () => void;
  actionLabel?: string;
}) {
  const status = l.status && l.status in RECON_STATUS ? RECON_STATUS[l.status as keyof typeof RECON_STATUS] : null;
  return (
    <tr className={l.source === "manual" ? "soa-manual" : undefined}>
      <td className="num">{l.date}</td>
      <td>{LINE_KIND[l.kind] ?? l.kind}</td>
      <td>
        {l.reference && <strong className="small">{l.reference} </strong>}
        <span className="small">{l.description}</span>
        {l.note && <div className="muted small">{l.note}</div>}
      </td>
      <td>
        <span className={`chip-tag ${l.source}`}>{l.source === "auto" ? "Auto" : "Manual"}</span>
      </td>
      <td className="small">
        {status ? (
          <>
            <StatusDot tone={status.tone} /> {status.label}
          </>
        ) : (
          (l.status ?? "")
        )}
      </td>
      <td className="num">{money(l.amount, ccy)}</td>
      <td className="num">{l.balance === null ? "" : money(l.balance, ccy)}</td>
      <td>
        {onAction && (
          <button type="button" className="link small" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </td>
    </tr>
  );
}

const HEAD = (
  <thead>
    <tr>
      <th>Date</th>
      <th>Type</th>
      <th>Reference · description</th>
      <th>Source</th>
      <th>Status</th>
      <th className="num">Amount</th>
      <th className="num">Balance</th>
      <th />
    </tr>
  </thead>
);

function SideView({ st, s }: { st: SoaStatement; s: SoaSide }) {
  const adjust = useSoaAdjustment();
  const takeBack = useTakeBackAdjustment();
  const bulk = useBulkTransactions();
  const notifySaved = useNotifySaved();
  const onSaved = (r: { change: Change | null }, msg: string) =>
    r.change ? notifySaved(r.change, msg) : toast({ tone: "info", message: "Nothing changed" });
  const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
  const act = async (l: SoaLine) => {
    const a = lineAction(l);
    if (a === "take_back")
      return takeBack.mutate(l.adjustmentId!, {
        onSuccess: (r) => onSaved(r, "Manual change taken back"),
        onError: fail,
      });
    const note = await ask<string>((d) => (
      <ReasonDialog title={`Remove ${l.reference ?? "line"} from the SOA`} required done={d} />
    ));
    if (!note) return;
    adjust.mutate(
      {
        enterpriseId: st.enterpriseId,
        action: a === "remove_invoice" ? "exclude_invoice" : "exclude_vendor_invoice",
        invoiceId: a === "remove_invoice" ? l.refId : null,
        vendorInvoiceId: a === "remove_vendor_invoice" ? l.refId : null,
        note,
      },
      { onSuccess: (r) => onSaved(r, `${l.reference} removed from the SOA`), onError: fail },
    );
  };
  const addVendorInvoice = async (l: SoaLine) => {
    const note = await ask<string>((d) => (
      <ReasonDialog title={`Add ${l.reference} to the SOA`} required={false} done={d} />
    ));
    if (note === null) return;
    adjust.mutate(
      { enterpriseId: st.enterpriseId, action: "include_vendor_invoice", vendorInvoiceId: l.refId, note: note || null },
      { onSuccess: (r) => onSaved(r, `${l.reference} added to the SOA`), onError: fail },
    );
  };
  const include = (l: SoaLine) =>
    bulk.mutate(
      { ids: [l.refId!], action: "include_in_soa", reason: null },
      { onSuccess: (r) => onSaved(r, `${l.reference} included in the SOA`), onError: fail },
    );
  return (
    <section className="soa-side">
      <header>
        <h3>{SIDE_TITLE[s.side]}</h3>
        <span className="muted small">{s.currency}</span>
      </header>
      <table className="mini-table soa-lines">
        {HEAD}
        <tbody>
          <tr className="soa-total">
            <td className="num">{st.from}</td>
            <td colSpan={5}>Opening balance</td>
            <td className="num">
              <Bal v={s.openingBalance} side={s.side} ccy={s.currency} />
            </td>
            <td />
          </tr>
          {s.lines.map((l) => {
            const a = lineAction(l);
            return (
              <LineRow
                key={l.key}
                l={l}
                ccy={s.currency}
                onAction={a ? () => void act(l) : undefined}
                actionLabel={a === "take_back" ? "Take back" : "Remove"}
              />
            );
          })}
          <tr className="soa-total">
            <td className="num">{st.to}</td>
            <td colSpan={5}>
              Closing balance <span className="muted small">· {balanceWords(s.closingBalance, s.side).text}</span>
            </td>
            <td className="num">
              <Bal v={s.closingBalance} side={s.side} ccy={s.currency} />
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className={`small ${Math.abs(s.difference) > 0.005 ? "tone-warning" : "muted"}`}>
        System balance at {st.to}: {money(s.systemBalance, s.currency)}
        {Math.abs(s.difference) > 0.005
          ? ` · the SOA differs by ${money(s.difference, s.currency)} (payments left off, lines removed or added by hand)`
          : " · the SOA agrees"}
      </p>
      {s.side === "vendor" && s.disputed.length > 0 && (
        <details className="soa-section" open>
          <summary>
            Disputed and pending vendor invoices ({s.disputed.length}) ·{" "}
            {s.disputedBlock ? "printed as a separate block, not in the balance" : "left off the SOA (partner's rule)"}
          </summary>
          <table className="mini-table soa-lines">
            {HEAD}
            <tbody>
              {s.disputed.map((l) => (
                <LineRow
                  key={l.key}
                  l={l}
                  ccy={s.currency}
                  onAction={() => void addVendorInvoice(l)}
                  actionLabel="Add to SOA"
                />
              ))}
            </tbody>
          </table>
        </details>
      )}
      {s.excludedPayments.length > 0 && (
        <details className="soa-section">
          <summary>Payments left off the SOA ({s.excludedPayments.length}) · still in balances (§13.33)</summary>
          <table className="mini-table soa-lines">
            {HEAD}
            <tbody>
              {s.excludedPayments.map((l) => (
                <LineRow key={l.key} l={l} ccy={s.currency} onAction={() => include(l)} actionLabel="Include" />
              ))}
            </tbody>
          </table>
        </details>
      )}
      {s.removed.length > 0 && (
        <details className="soa-section">
          <summary>Removed by hand ({s.removed.length})</summary>
          <table className="mini-table soa-lines">
            {HEAD}
            <tbody>
              {s.removed.map((l) => (
                <LineRow
                  key={l.key}
                  l={l}
                  ccy={s.currency}
                  onAction={() =>
                    takeBack.mutate(l.adjustmentId!, {
                      onSuccess: (r) => onSaved(r, "Put back on the SOA"),
                      onError: fail,
                    })
                  }
                  actionLabel="Put back"
                />
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

function StatementView({ enterpriseId, params }: { enterpriseId: number; params: Params }) {
  const q = useSoaStatement({ enterpriseId, ...params });
  const st = q.data;
  if (!st) return <p className="muted">{q.isError ? problemText(q.error) : "Building the statement…"}</p>;
  return (
    <div className="soa-statement">
      <div className="soa-statement-head">
        <div>
          <h2>{st.enterprise}</h2>
          <span className="muted small">
            {st.businessCompany} · {st.from} → {st.to} · {st.timezone} · invoice type {st.invoiceType}
          </span>
          <div className="small">
            To:{" "}
            {st.recipients.length ? st.recipients.join(", ") : <span className="tone-error">no billing contact</span>}
          </div>
        </div>
        <span className="fb-spacer" />
        {st.sides.length > 0 && (
          <Button small icon="plus" onClick={() => void ask<void>((d) => <EntryDialog st={st} done={() => d()} />)}>
            Manual entry
          </Button>
        )}
      </div>
      {st.sides.length === 0 && <p className="muted">No billing settings: nothing to state.</p>}
      {st.sides.map((s) => (
        <SideView key={s.side} st={st} s={s} />
      ))}
      {st.net && (
        <p className="soa-net">
          Net balance (customer − vendor): <strong className="num">{money(st.net.amount, st.net.currency)}</strong>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page

export function SoaPage() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const initialIds = enterprisesParam(location.search);
  const period = defaultPeriod();
  const [picked, setPicked] = useState<Picked<number>[]>(() => initialIds.map((id) => ({ key: id, label: `#${id}` })));
  const [invoiceType, setInvoiceType] = useState<SoaInvoiceType>("all");
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [templateId, setTemplateId] = useState<number | null>(1);
  const [query, setQuery] = useState<SoaQuery | null>(() =>
    initialIds.length ? { enterpriseIds: initialIds, invoiceType: "all", ...period } : null,
  );
  const [checked, setChecked] = useState<Set<number>>(() => new Set(initialIds));
  const [open, setOpen] = useState<number | null>(initialIds.length === 1 ? initialIds[0]! : null);
  const result = useSoaSearch(query);
  const follow = useFollowReports();
  const rows = result.data?.rows ?? [];
  // Chips opened from a link show "#id" until the search names them.
  if (rows.length && picked.some((p) => p.label.startsWith("#"))) {
    const names = new Map(rows.map((r) => [r.enterpriseId, r.enterprise]));
    if (picked.some((p) => names.has(p.key) && p.label !== names.get(p.key)))
      setPicked(picked.map((p) => ({ ...p, label: names.get(p.key) ?? p.label })));
  }
  const params: Params = query
    ? { invoiceType: query.invoiceType, from: query.from, to: query.to }
    : { invoiceType, from, to };
  const search = () => {
    if (!picked.length) return toast({ tone: "error", message: "Choose at least one enterprise." });
    setQuery({ enterpriseIds: picked.map((p) => p.key), invoiceType, from, to });
    setChecked(new Set(picked.map((p) => p.key)));
    setOpen(picked.length === 1 ? picked[0]!.key : null);
  };
  const names = new Map(rows.map((r) => [r.enterpriseId, r.enterprise]));
  const checkedIds = rows.filter((r) => checked.has(r.enterpriseId)).map((r) => r.enterpriseId);
  const send = () => {
    if (!templateId) return toast({ tone: "error", message: "Choose the Send SOA e-mail template." });
    void ask<boolean>((d) => (
      <SendDialog ids={checkedIds} names={names} params={params} templateId={templateId} done={d} />
    ));
  };
  const queueExport = (fileType: "excel" | "pdf") =>
    void exportSoa({ enterpriseIds: checkedIds, ...params, fileType })
      .then((r) =>
        follow(
          r.reports.map((x) => x.id),
          "exported",
        ),
      )
      .catch((e) => toast({ tone: "error", message: problemText(e) }));
  return (
    <div className="page soa-page">
      <PageHeader
        page={page}
        actions={
          <Button icon="file" onClick={() => navigate("/finance/soa-report")}>
            SOA Report
          </Button>
        }
      />
      <form
        className="soa-form"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <div className="field soa-enterprises">
          <span>
            Enterprise<span className="req">*</span>
          </span>
          <MultiPick<Enterprise, number>
            list="enterprises"
            value={picked}
            onChange={setPicked}
            toPicked={(e) => ({ key: e.id, label: e.name })}
            detailOf={(e) => `${e.alias} · ${e.type}`}
            placeholder="Enterprise name or alias…"
          />
        </div>
        <div className="field">
          <span>Invoice Type</span>
          <div className="segmented small" role="radiogroup" aria-label="Invoice type">
            {INVOICE_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={invoiceType === t.value}
                className={invoiceType === t.value ? "on" : ""}
                onClick={() => setInvoiceType(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>From Date</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>To Date</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="field">
          <span>Send SOA Email Template</span>
          <ListLookup<EmailTemplateRow>
            list="email_templates"
            value={templateId}
            onChange={(t) => setTemplateId(t?.id ?? null)}
            labelOf={(t) => t.name}
            detailOf={(t) => t.subject}
            fixed={[{ field: "emailType", op: "in", values: ["soa_statement", "send_soa"] }]}
          />
        </div>
        <div className="field">
          <span>&nbsp;</span>
          <Button type="submit" variant="primary" icon="search" disabled={result.isFetching}>
            {result.isFetching ? "Searching…" : "Search"}
          </Button>
        </div>
      </form>
      {result.isError && <p className="error-text">{problemText(result.error)}</p>}
      {rows.length > 0 && (
        <>
          <div className="soa-toolbar">
            <Button small onClick={() => setChecked(new Set(rows.map((r) => r.enterpriseId)))}>
              Check All
            </Button>
            <Button small onClick={() => setChecked(new Set())}>
              Uncheck All
            </Button>
            <span className="muted small">
              {checkedIds.length} of {rows.length} checked
            </span>
            <span className="fb-spacer" />
            <Button small icon="mail" disabled={!checkedIds.length} onClick={send}>
              Send Email
            </Button>
            <Button small icon="download" disabled={!checkedIds.length} onClick={() => queueExport("excel")}>
              Queue SOA Export · Excel
            </Button>
            <Button small icon="download" disabled={!checkedIds.length} onClick={() => queueExport("pdf")}>
              PDF
            </Button>
          </div>
          <div className="charges-table soa-results">
            <table className="mini-table">
              <thead>
                <tr>
                  <th />
                  <th>Enterprise</th>
                  <th className="num">Customer opening</th>
                  <th className="num">Customer closing</th>
                  <th className="num">Vendor opening</th>
                  <th className="num">Vendor closing</th>
                  <th className="num">Lines</th>
                  <th className="num">Left off</th>
                  <th className="num">Disputed</th>
                  <th>Billing contact</th>
                  <th>Last SOA sent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const c = r.sides.find((s) => s.side === "customer");
                  const v = r.sides.find((s) => s.side === "vendor");
                  return (
                    <tr
                      key={r.enterpriseId}
                      className={open === r.enterpriseId ? "selected" : undefined}
                      onClick={() => setOpen(r.enterpriseId)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Check ${r.enterprise}`}
                          checked={checked.has(r.enterpriseId)}
                          onChange={(e) => {
                            const next = new Set(checked);
                            if (e.target.checked) next.add(r.enterpriseId);
                            else next.delete(r.enterpriseId);
                            setChecked(next);
                          }}
                        />
                      </td>
                      <td>
                        <strong>{r.enterprise}</strong> <span className="muted small">{r.enterpriseType}</span>
                      </td>
                      <td className="num">
                        {c ? <Bal v={c.openingBalance} side="customer" ccy={c.currency} /> : muted("—")}
                      </td>
                      <td className="num">
                        {c ? <Bal v={c.closingBalance} side="customer" ccy={c.currency} /> : muted("—")}
                      </td>
                      <td className="num">
                        {v ? <Bal v={v.openingBalance} side="vendor" ccy={v.currency} /> : muted("—")}
                      </td>
                      <td className="num">
                        {v ? <Bal v={v.closingBalance} side="vendor" ccy={v.currency} /> : muted("—")}
                      </td>
                      <td className="num">{r.sides.reduce((t, s) => t + s.lines, 0)}</td>
                      <td className="num">{r.sides.reduce((t, s) => t + s.excludedPayments, 0) || muted("0")}</td>
                      <td className="num">{r.sides.reduce((t, s) => t + s.disputed, 0) || muted("0")}</td>
                      <td className="small">
                        {r.recipients.length ? r.recipients[0] : <span className="tone-error">none</span>}
                      </td>
                      <td className="small">{r.lastSentAt ? fmtWhen(r.lastSentAt) : muted("never")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {query && result.data && rows.length === 0 && <p className="muted">No enterprise found.</p>}
      {open !== null && query && (
        <StatementView key={`${open}:${JSON.stringify(params)}`} enterpriseId={open} params={params} />
      )}
      {!query && (
        <p className="muted soa-hint">Choose enterprises and a period, then Search.</p>
      )}
    </div>
  );
}
