// Re-rating (§6.3, §12.2): requests to recompute charges on past EDRs after a rate
// correction. One user requests (with a preview of the EDRs and amounts in scope), another
// approves or declines (maker-checker). An approved request is processed in the background
// (In Queue, In Process, Completed) and posts a Reprocess credit or debit note per enterprise
// unless "Don't add credit/debit note" is ticked. EDRs keep their billed amounts (§13.29).
import { useEffect, useState } from "react";
import type {
  Enterprise,
  RateTableRow,
  ReratingDetail,
  ReratingInput,
  ReratingPreview,
  ReratingRequest,
  ReratingSummaryRow,
} from "@sms/contract";
import { previewRerating, useDecideRerating, useRerating, useSaveRerating } from "../../api/routingExtras";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ListLookup } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal } from "../../ui/primitives";
import { problemText } from "./dialogs";
import { DestinationPick, MultiPick, type Picked } from "./pickers";

const page = pageForPath("/rates/re-rating")!;

const REQUEST: Record<ReratingRequest["requestStatus"], [string, string]> = {
  pending_approval: ["Pending Approval", "warning"],
  approved: ["Approved", "good"],
  declined: ["Declined", "muted"],
};
const PROCESS: Record<ReratingRequest["reprocessStatus"], [string, string]> = {
  not_started: ["—", "muted"],
  in_queue: ["In Queue", "warning"],
  in_process: ["In Process", "warning"],
  completed: ["Completed", "good"],
  failed: ["Failed", "error"],
};
const TX: Record<ReratingSummaryRow["transactionStatus"], string> = {
  pending: "To post",
  posted: "Posted",
  not_posted: "Not posted (no note)",
  no_difference: "No difference",
};
const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

function Badge({ map, value }: { map: Record<string, [string, string]>; value: string }) {
  const [label, tone] = map[value]!;
  if (value === "not_started") return <span className="muted">—</span>;
  return <span className={`rr-badge tone-${tone}`}>{label}</span>;
}

function SummaryTable({ rows }: { rows: ReratingSummaryRow[] }) {
  if (!rows.length) return <p className="muted">No summary yet: it is filled when the request is processed.</p>;
  return (
    <table className="rr-summary">
      <thead>
        <tr>
          <th>Enterprise</th>
          <th className="r">Total EDR</th>
          <th className="r">Billed</th>
          <th className="r">Re-rated</th>
          <th className="r">Amount</th>
          <th>Payment Type</th>
          <th>Transaction</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.enterpriseId}>
            <td>{r.enterpriseName}</td>
            <td className="r num">{r.totalEdrs.toLocaleString("en-US")}</td>
            <td className="r num">{money(r.oldAmount)}</td>
            <td className="r num">{money(r.newAmount)}</td>
            <td className={`r num${r.amount < 0 ? " tone-good" : r.amount > 0 ? " tone-warning" : ""}`}>
              {r.amount > 0 ? "+" : ""}
              {money(r.amount)} {r.currency}
            </td>
            <td>{r.paymentType ? (r.paymentType === "credit" ? "Credit note" : "Debit note") : "—"}</td>
            <td>
              {TX[r.transactionStatus]}
              {r.transactionId ? <span className="muted"> #{r.transactionId}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- request dialog (§12.2)

const emptyInput = (): ReratingInput => ({
  description: null,
  startDate: today(),
  endDate: today(),
  side: "customer",
  enterpriseIds: [],
  rateTableId: 0,
  reason: "rate_correction",
  mccmncs: [],
  senderId: null,
  noNote: false,
  priority: "P2",
});

function RequestDialog({ row, done }: { row: ReratingDetail | null; done: () => void }) {
  const [v, setV] = useState<ReratingInput>(
    row
      ? {
          description: row.description,
          startDate: row.startDate,
          endDate: row.endDate,
          side: row.side,
          enterpriseIds: row.enterprises.map((e) => e.id),
          rateTableId: row.rateTableId,
          reason: row.reason,
          mccmncs: row.mccmncs,
          senderId: row.senderId,
          noNote: row.noNote,
          priority: row.priority,
        }
      : emptyInput(),
  );
  const [ents, setEnts] = useState<Picked<number>[]>(
    row ? row.enterprises.map((e) => ({ key: e.id, label: e.name })) : [],
  );
  const [preview, setPreview] = useState<ReratingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveRerating();
  const set = <K extends keyof ReratingInput>(k: K, value: ReratingInput[K]) => {
    setV((x) => ({ ...x, [k]: value }));
    setPreview(null);
  };
  const missing = !v.enterpriseIds.length
    ? "Choose the enterprises."
    : !v.rateTableId
      ? "Choose the rate table."
      : null;
  const runPreview = async () => {
    if (missing) return setError(missing);
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewRerating(v));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (missing) return setError(missing);
    save.mutate(
      { id: row?.id ?? null, input: v },
      {
        onSuccess: (r) => {
          toast({
            tone: "good",
            message: row
              ? `Re-rating #${r.record.id} saved`
              : `Re-rating #${r.record.id} requested: another user approves or declines it`,
          });
          done();
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  };
  return (
    <Modal
      title={row ? `Edit re-rating #${row.id}` : "Re-Rating Request"}
      width={720}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button icon="search" disabled={busy} onClick={() => void runPreview()}>
            Preview
          </Button>
          <Button variant="primary" disabled={save.isPending} onClick={submit}>
            {row ? "Save" : "Request"}
          </Button>
        </>
      }
    >
      <div className="fgrid cols-2">
        <label className="field wide">
          <span>Description</span>
          <input
            value={v.description ?? ""}
            maxLength={500}
            onChange={(e) => set("description", e.target.value || null)}
          />
        </label>
        <label className="field">
          <span>
            Start Date<span className="req">*</span>
          </span>
          <input type="date" value={v.startDate} max={today()} onChange={(e) => set("startDate", e.target.value)} />
        </label>
        <label className="field">
          <span>
            End Date<span className="req">*</span>
          </span>
          <input type="date" value={v.endDate} max={today()} onChange={(e) => set("endDate", e.target.value)} />
        </label>
        <div className="field">
          <span>Enterprise Type</span>
          <div className="segmented small" role="radiogroup" aria-label="Enterprise type">
            {(["customer", "vendor"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={v.side === s}
                className={v.side === s ? "on" : ""}
                onClick={() => {
                  setV((x) => ({ ...x, side: s, enterpriseIds: [], rateTableId: 0 }));
                  setEnts([]);
                  setPreview(null);
                }}
              >
                {s === "customer" ? "Customer" : "Vendor"}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>
            Priority<span className="req">*</span>
          </span>
          <select value={v.priority} onChange={(e) => set("priority", e.target.value as ReratingInput["priority"])}>
            {["P1", "P2", "P3"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <div className="field wide">
          <span>
            {v.side === "customer" ? "Customer" : "Vendor"}
            <span className="req">*</span>
          </span>
          <MultiPick<Enterprise, number>
            list="enterprises"
            value={ents}
            onChange={(next) => {
              setEnts(next);
              set(
                "enterpriseIds",
                next.map((p) => p.key),
              );
            }}
            toPicked={(e) => ({ key: e.id, label: e.name })}
            detailOf={(e) => e.type}
            fixed={[{ field: "type", op: "in", values: [v.side, "reciprocal"] }]}
            placeholder="Search enterprises…"
          />
        </div>
        <div className="field wide">
          <span>
            Rate Table<span className="req">*</span>
          </span>
          <ListLookup<RateTableRow>
            list="rate_tables"
            value={v.rateTableId || null}
            onChange={(t) => set("rateTableId", t?.id ?? 0)}
            labelOf={(t) => `${t.name} (${t.currency})`}
            detailOf={(t) => t.category}
            fixed={[{ field: "kind", op: "eq", value: v.side }]}
            placeholder={`Search ${v.side} rate tables…`}
          />
        </div>
        <label className="field">
          <span>Reprocess Reason</span>
          <select value="rate_correction" disabled>
            <option value="rate_correction">Rate Correction</option>
          </select>
        </label>
        <label className="field">
          <span>Sender ID</span>
          <input value={v.senderId ?? ""} maxLength={20} onChange={(e) => set("senderId", e.target.value || null)} />
        </label>
        <div className="field wide">
          <span>MCCMNC (empty = all)</span>
          <DestinationPick value={v.mccmncs} onChange={(codes) => set("mccmncs", codes)} />
        </div>
        <label className="toggle-inline wide">
          <input type="checkbox" checked={v.noNote} onChange={(e) => set("noNote", e.target.checked)} />
          Don&apos;t add credit/debit note to transaction
        </label>
      </div>
      {busy && <p className="muted">Computing the preview…</p>}
      {preview && (
        <div className="rr-preview">
          <p>
            <strong className="num">{preview.totalEdrs.toLocaleString("en-US")}</strong> EDRs in scope.
          </p>
          <SummaryTable rows={preview.rows} />
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

const openRequest = (row: ReratingDetail | null) =>
  ask<void>((done) => <RequestDialog row={row} done={() => done()} />);

/** Edit from the row menu: loads the request (the detail panel's query) first. */
function EditById({ id, done }: { id: number; done: () => void }) {
  const q = useRerating(id);
  useEffect(() => {
    if (!q.isError) return;
    toast({ tone: "error", message: problemText(q.error) });
    done();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.isError]);
  return q.data ? <RequestDialog row={q.data} done={done} /> : null;
}

function DeclineDialog({ id, done }: { id: number; done: () => void }) {
  const decide = useDecideRerating();
  const [reason, setReason] = useState("");
  return (
    <Modal
      title={`Decline re-rating #${id}`}
      width={460}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!reason.trim() || decide.isPending}
            onClick={() =>
              decide.mutate(
                { id, approve: false, reason: reason.trim() },
                {
                  onSuccess: () => {
                    toast({ tone: "good", message: `Re-rating #${id} declined` });
                    done();
                  },
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                },
              )
            }
          >
            Decline
          </Button>
        </>
      }
    >
      <label className="field">
        <span>
          Reason<span className="req">*</span>
        </span>
        <textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------- detail

function RequestDetail({ id }: { id: number }) {
  const q = useRerating(id);
  const decide = useDecideRerating();
  const r = q.data;
  if (!r) return <p className="muted">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  return (
    <div className="rr-detail">
      <div className="rr-actions">
        {r.canEdit && (
          <Button small icon="file" onClick={() => void openRequest(r)}>
            Edit
          </Button>
        )}
        {r.canDecide && (
          <>
            <Button
              small
              variant="primary"
              icon="check"
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate(
                  { id: r.id, approve: true },
                  {
                    onSuccess: () => toast({ tone: "good", message: `Re-rating #${r.id} approved and queued` }),
                    onError: (e) => toast({ tone: "error", message: problemText(e) }),
                  },
                )
              }
            >
              Approve
            </Button>
            <Button
              small
              icon="x"
              onClick={() => void ask<void>((done) => <DeclineDialog id={r.id} done={() => done()} />)}
            >
              Decline
            </Button>
          </>
        )}
        {r.requestStatus === "pending_approval" && !r.canDecide && (
          <span className="muted small">Waiting for another user to approve or decline (maker-checker).</span>
        )}
      </div>
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <Badge map={REQUEST} value={r.requestStatus} /> <Badge map={PROCESS} value={r.reprocessStatus} />
          {r.declineReason && <span className="muted"> · {r.declineReason}</span>}
          {r.error && <span className="tone-error"> · {r.error}</span>}
        </dd>
        <dt>Scope</dt>
        <dd>
          {r.side === "customer" ? "Customers" : "Vendors"}: {r.enterprises.map((e) => e.name).join(", ")} ·{" "}
          {r.rateTableName} · {r.startDate} to {r.endDate}
          {r.mccmncs.length ? ` · ${r.mccmncs.join(", ")}` : ""}
          {r.senderId ? ` · sender ${r.senderId}` : ""}
        </dd>
        <dt>Requested</dt>
        <dd>
          {r.requestedBy} · {r.requestedAt.slice(0, 16).replace("T", " ")} UTC · {r.priority}
          {r.noNote && " · no credit/debit note"}
        </dd>
        {r.decidedBy && (
          <>
            <dt>{r.requestStatus === "declined" ? "Declined" : "Approved"}</dt>
            <dd>
              {r.decidedBy} · {r.decidedAt?.slice(0, 16).replace("T", " ")} UTC
            </dd>
          </>
        )}
        {r.finishedAt && (
          <>
            <dt>Processed</dt>
            <dd>
              {r.startedAt?.slice(11, 19)} to {r.finishedAt.slice(11, 19)} UTC
              {r.totalEdrs !== null && ` · ${r.totalEdrs.toLocaleString("en-US")} EDRs`}
            </dd>
          </>
        )}
      </dl>
      <h3 className="rr-h">Re-Rating Summary</h3>
      <SummaryTable rows={r.summary} />
    </div>
  );
}

export function ReratingPage() {
  const decide = useDecideRerating();
  const notMine = "Another user approves or declines (maker-checker)";
  return (
    <ListScreen<ReratingRequest>
      list="rerating_requests"
      listExport
      page={page}
      noSelection
      // The detail panel's Edit, Approve and Decline, per row (§6.3).
      rowActions={(r) => [
        {
          label: "Approve",
          icon: "check",
          main: true,
          disabled: !r.canDecide || decide.isPending,
          hint: r.canDecide ? undefined : r.requestStatus === "pending_approval" ? notMine : "Already decided",
          onSelect: () =>
            decide.mutate(
              { id: r.id, approve: true },
              {
                onSuccess: () => toast({ tone: "good", message: `Re-rating #${r.id} approved and queued` }),
                onError: (e) => toast({ tone: "error", message: problemText(e) }),
              },
            ),
        },
        {
          label: "Decline…",
          icon: "x",
          disabled: !r.canDecide,
          hint: r.canDecide ? undefined : r.requestStatus === "pending_approval" ? notMine : "Already decided",
          onSelect: () => void ask<void>((done) => <DeclineDialog id={r.id} done={() => done()} />),
        },
        {
          label: "Edit",
          icon: "file",
          disabled: !r.canEdit,
          hint: r.canEdit ? undefined : "Only the requester can edit a pending request",
          onSelect: () => void ask<void>((done) => <EditById id={r.id} done={() => done()} />),
        },
      ]}
      // Requests are a maker-checker workflow, not undone: their history is on the Change history page.
      primary={{ label: "Request re-rating", icon: "plus", onClick: () => void openRequest(null) }}
      columns={{
        id: { width: 90 },
        side: { width: 110, render: (r) => (r.side === "customer" ? "Customer" : "Vendor") },
        reprocessType: { width: 100, render: (r) => (r.reprocessType === "manual" ? "Manual" : "Auto") },
        enterprises: { width: 220, render: (r) => r.enterprises.map((e) => e.name).join(", ") },
        rateTableName: { width: 180 },
        description: { width: 220, render: (r) => r.description ?? <span className="muted">—</span> },
        startDate: { width: 110 },
        endDate: { width: 110 },
        priority: { width: 80 },
        requestStatus: { width: 150, render: (r) => <Badge map={REQUEST} value={r.requestStatus} /> },
        reprocessStatus: { width: 130, render: (r) => <Badge map={PROCESS} value={r.reprocessStatus} /> },
        totalEdrs: {
          width: 100,
          align: "right",
          render: (r) => (
            <span className="num">{r.totalEdrs === null ? "—" : r.totalEdrs.toLocaleString("en-US")}</span>
          ),
        },
        requestedBy: { width: 130 },
        updatedBy: { width: 130, render: (r) => r.updatedBy ?? "—" },
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>Re-rating #{r.id}</strong>
            <span className="muted">
              {r.rateTableName} · {r.startDate} to {r.endDate}
            </span>
          </>
        ),
        sections: [{ key: "request", label: "Request", content: <RequestDetail id={r.id} /> }],
      })}
      shortcuts="↑↓ move · the detail shows the summary, Approve and Decline · requests are approved by another user"
    />
  );
}
