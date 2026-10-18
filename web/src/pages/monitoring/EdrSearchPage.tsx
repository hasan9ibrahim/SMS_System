// EDR Search (§9.1): every message attempt with both legs, from the EDR store. From / To Date, Final
// and message ID lists sit in the filter row; every column filters with the §13.25 grammar; an EDR
// Template sets the columns. Selected EDRs go to a Trouble Ticket or an EDR Repush; Export queues an
// EDR Request (background download, §12.4) with the current filters.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EdrRow, EmailPreview, EmailTemplateRow, FieldDescriptor, ListQuery, TrunkListRow } from "@sms/contract";
import { fetchListPage, useListFields, type ListPage } from "../../api/hooks";
import { previewTroubleTicket, useEdrTemplates, useRepush, useSendTroubleTicket } from "../../api/observation";
import type { GridState } from "../../grid/filterModel";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ListLookup } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { toBase64 } from "../switch/tools/toolsModel";
import {
  EDR_SECTIONS,
  fieldText,
  fmtSeconds,
  msgStatusTone,
  parseIdList,
  timeBounds,
  timeCondition,
  toGridRow,
  type EdrGridRow,
} from "./monitorModel";
import { RequestDialog } from "./parts";
import { DestinationTree } from "../rates/DestinationTree";

const page = pageForPath("/monitoring/edr")!;
const muted = (v: string) => <span className="muted">{v}</span>;
/** Rows seen on this page by grid key, so bulk actions can name the EDRs by UUID. */
const seen = new Map<number, EdrGridRow>();
const TICKET_COLUMNS = ["submitTime", "customerMsgId", "vendorMsgId", "senderId", "dnid", "msgStatus", "deliveryError"];

export const fetchEdrs = (body: ListQuery): Promise<ListPage<EdrGridRow>> =>
  fetchListPage<EdrRow>("edrs", body).then((p) => {
    const rows = p.rows.map(toGridRow);
    for (const r of rows) seen.set(r.id, r);
    return { ...p, rows };
  });
const uuidsOf = (ids: number[]) => ids.map((id) => seen.get(id)).filter((r): r is EdrGridRow => !!r);

// ---------------------------------------------------------------- filter row

/** Destinations of the search, picked in the country / network tree with select all (team trial round 1). */
function DestinationsDialog({ initial, done }: { initial: string[]; done: (codes: string[] | null) => void }) {
  const [picked, setPicked] = useState<string[]>(initial);
  return (
    <Modal
      title="Destinations"
      width={620}
      onClose={() => done(null)}
      footer={
        <>
          <span className="muted small fb-spacer">
            {picked.length ? `${picked.length} network${picked.length === 1 ? "" : "s"}` : "All destinations"}
          </span>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => done(picked)}>
            Apply
          </Button>
        </>
      }
    >
      <DestinationTree selected={picked} onChange={setPicked} height={380} />
    </Modal>
  );
}

function EdrToolbar({ state, setState }: { state: GridState; setState: (s: GridState) => void }) {
  const templates = useEdrTemplates();
  const bounds = timeBounds(state.columns.startTime);
  const set = (field: string, c: GridState["columns"][string] | null) => {
    const columns = { ...state.columns };
    if (c) columns[field] = c;
    else delete columns[field];
    setState({ ...state, columns });
  };
  const setTime = (from: string, to: string) => set("startTime", timeCondition("startTime", from, to));
  const ids = (field: string) => {
    const c = state.columns[field];
    return c?.op === "in" ? (c.values ?? []).join(", ") : c?.op === "eq" ? String(c.value) : "";
  };
  const setIds = (field: string, text: string) => {
    const list = parseIdList(text);
    set(
      field,
      list.length > 1 ? { field, op: "in", values: list } : list.length ? { field, op: "eq", value: list[0]! } : null,
    );
  };
  return (
    <div className="edr-toolbar">
      <label className="small">
        From
        <input
          type="datetime-local"
          value={bounds.from}
          onChange={(e) => setTime(e.target.value, bounds.to)}
          aria-label="From (UTC)"
        />
      </label>
      <label className="small">
        To
        <input
          type="datetime-local"
          value={bounds.to}
          onChange={(e) => setTime(bounds.from, e.target.value)}
          aria-label="To (UTC)"
        />
      </label>
      <span className="muted small">UTC</span>
      <label className="toggle-inline small">
        <input
          type="checkbox"
          checked={state.columns.isFinalAttempt?.value === true}
          onChange={(e) =>
            set("isFinalAttempt", e.target.checked ? { field: "isFinalAttempt", op: "eq", value: true } : null)
          }
        />
        Final
      </label>
      <input
        key={`n${ids("dnid")}`}
        className="edr-ids"
        defaultValue={ids("dnid")}
        placeholder="Numbers, comma separated"
        aria-label="Receiver numbers"
        title="Receiver numbers, exact (the quick search also takes several numbers or a customer name)"
        onBlur={(e) => e.target.value !== ids("dnid") && setIds("dnid", e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && setIds("dnid", e.currentTarget.value)}
      />
      <Button
        small
        icon="globe"
        className={state.columns.customerMccmnc ? "active" : ""}
        onClick={async () => {
          const c = state.columns.customerMccmnc;
          const current = c?.values?.map(String) ?? (c?.value !== undefined ? [String(c.value)] : []);
          const codes = await ask<string[]>((d) => <DestinationsDialog initial={current} done={d} />);
          if (codes === null) return;
          set("customerMccmnc", codes.length ? { field: "customerMccmnc", op: "in", values: codes } : null);
        }}
      >
        {(() => {
          const c = state.columns.customerMccmnc;
          const n = c?.values?.length ?? (c?.value !== undefined ? 1 : 0);
          return n ? `Destinations (${n})` : "Destinations";
        })()}
      </Button>
      <input
        key={`c${ids("customerMsgId")}`}
        className="edr-ids"
        defaultValue={ids("customerMsgId")}
        placeholder="Customer Msg IDs, comma separated"
        aria-label="Customer Msg IDs"
        onBlur={(e) => e.target.value !== ids("customerMsgId") && setIds("customerMsgId", e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && setIds("customerMsgId", e.currentTarget.value)}
      />
      <input
        key={`v${ids("vendorMsgId")}`}
        className="edr-ids"
        defaultValue={ids("vendorMsgId")}
        placeholder="Vendor Msg IDs"
        aria-label="Vendor Msg IDs"
        onBlur={(e) => e.target.value !== ids("vendorMsgId") && setIds("vendorMsgId", e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && setIds("vendorMsgId", e.currentTarget.value)}
      />
      <select
        aria-label="EDR Template"
        value={templates.data?.find((t) => state.visible && t.columns.join() === state.visible.join())?.id ?? ""}
        onChange={(e) => {
          const t = templates.data?.find((x) => x.id === Number(e.target.value));
          setState({ ...state, visible: t ? t.columns : null });
        }}
      >
        <option value="">Template: default columns</option>
        {templates.data?.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

function ColumnChecks({
  fields,
  value,
  onChange,
}: {
  fields: FieldDescriptor[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="column-checks">
      {fields.map((f) => (
        <label key={f.field} className="toggle-inline small">
          <input
            type="checkbox"
            checked={value.includes(f.field)}
            onChange={(e) => onChange(e.target.checked ? [...value, f.field] : value.filter((x) => x !== f.field))}
          />
          {f.label}
        </label>
      ))}
    </div>
  );
}

function TroubleTicketDialog({ rows, done }: { rows: EdrGridRow[]; done: () => void }) {
  const fields = useListFields("edrs");
  const vendorTrunkIds = [...new Set(rows.map((r) => r.vendorTrunkId).filter(Boolean))];
  const [sendTo, setSendTo] = useState<"customer" | "vendor">(vendorTrunkIds.length ? "vendor" : "customer");
  const [vendorTrunkId, setVendorTrunkId] = useState<number | null>(vendorTrunkIds[0] ?? null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [subject, setSubject] = useState("");
  const [columns, setColumns] = useState(TICKET_COLUMNS);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const send = useSendTroubleTicket();
  const templates = useQuery({
    queryKey: ["list", "email-templates", "trouble_ticket"],
    queryFn: () =>
      fetchListPage<EmailTemplateRow>("email_templates", {
        filter: { logic: "and", conditions: [{ field: "emailType", op: "in", values: ["trouble_ticket"] }] },
        limit: 50,
        withTotal: false,
      }),
  });
  const tpl = templateId ?? templates.data?.rows[0]?.id ?? null;
  const body = () => ({
    sendTo,
    vendorTrunkId: sendTo === "vendor" ? vendorTrunkId : null,
    templateId: tpl!,
    subject: subject.trim(),
    columns,
    edrIds: rows.map((r) => r.uuid),
  });
  const missing = !tpl
    ? "Choose a template"
    : sendTo === "vendor" && !vendorTrunkId
      ? "Choose the vendor trunk"
      : !columns.length
        ? "Choose the e-mail columns"
        : null;
  const showPreview = () =>
    void previewTroubleTicket(body())
      .then(setPreview)
      .catch((e) => toast({ tone: "error", message: problemText(e) }));
  const submit = async () => {
    try {
      const attachment = file
        ? { name: file.name, contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())) }
        : null;
      const r = await send.mutateAsync({ ...body(), attachment });
      toast({
        tone: "good",
        message: `Trouble ticket sent to ${r.enterprise} (${r.recipients.join(", ") || "no contact"}) · see Email Logs`,
      });
      done();
    } catch (e) {
      toast({ tone: "error", message: problemText(e) });
    }
  };
  return (
    <Modal
      title={`Trouble Ticket · ${rows.length} EDR${rows.length === 1 ? "" : "s"}`}
      width={780}
      onClose={done}
      footer={
        <>
          <span className="muted small">{missing ?? "The EDRs go in the body and as a CSV attachment."}</span>
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button disabled={!!missing} onClick={showPreview}>
            Preview
          </Button>
          <Button variant="primary" icon="mail" disabled={!!missing || send.isPending} onClick={() => void submit()}>
            Send Mail
          </Button>
        </>
      }
    >
      <div className="tt-form">
        <div className="field">
          <span>Ticket Send To</span>
          <div className="segmented small" role="radiogroup" aria-label="Ticket send to">
            {(["customer", "vendor"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={sendTo === s}
                className={sendTo === s ? "on" : ""}
                onClick={() => setSendTo(s)}
              >
                {s === "customer" ? "Customer" : "Vendor"}
              </button>
            ))}
          </div>
        </div>
        {sendTo === "vendor" && (
          <div className="field">
            <span>Vendor Trunk *</span>
            <ListLookup<TrunkListRow>
              list="vendor_trunks"
              value={vendorTrunkId}
              onChange={(t) => setVendorTrunkId(t?.id ?? null)}
              labelOf={(t) => t.name}
              detailOf={(t) => t.enterpriseName}
              placeholder={rows.find((r) => r.vendorTrunkId === vendorTrunkId)?.vendorTrunk ?? "Search vendor trunks…"}
            />
          </div>
        )}
        <label className="field">
          <span>Trouble Ticket Template *</span>
          <select value={tpl ?? ""} onChange={(e) => setTemplateId(Number(e.target.value))}>
            {templates.data?.rows.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Email Subject</span>
          <input
            value={subject}
            maxLength={200}
            placeholder="The template's subject"
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
        <label className="field tt-wide">
          <span>Attachment</span>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="field tt-wide">
          <span>Email Columns * ({columns.length})</span>
          {fields.data && <ColumnChecks fields={fields.data.fields} value={columns} onChange={setColumns} />}
        </div>
      </div>
      {preview && (
        <div className="mail-preview">
          <div className="small">
            <strong>To:</strong>{" "}
            {preview.recipients.join(", ") || <span className="tone-error">no technical contact</span>}
          </div>
          <div className="small">
            <strong>Subject:</strong> {preview.subject}
          </div>
          <pre className="mono-pre">{preview.body}</pre>
        </div>
      )}
    </Modal>
  );
}

/** Re-send EDRs on a vendor trunk; also used by Failed EDR Search (team trial round 1). */
export function RepushDialog({ ids, eligible, done }: { ids: string[]; eligible: number; done: () => void }) {
  const [vendorTrunkId, setVendorTrunkId] = useState<number | null>(null);
  const repush = useRepush();
  const navigate = useTabNavigate();
  return (
    <Modal
      title={`EDR Repush · ${ids.length} EDR${ids.length === 1 ? "" : "s"}`}
      width={520}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            icon="send"
            disabled={!vendorTrunkId || repush.isPending}
            onClick={() =>
              repush.mutate(
                { edrIds: ids, vendorTrunkId: vendorTrunkId! },
                {
                  onSuccess: (r) => {
                    toast({
                      tone: r.edrCount ? "good" : "warning",
                      message: r.edrCount
                        ? `Repush request ${r.id}: ${r.delivered} delivered, ${r.failed} failed${r.skipped ? ` · ${r.skipped} skipped` : ""}`
                        : `Nothing to repush: all ${r.skipped} were delivered or not final attempts`,
                    });
                    done();
                    if (r.edrCount) navigate("/monitoring/repush");
                  },
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                },
              )
            }
          >
            Proceed
          </Button>
        </>
      }
    >
      <div className="field">
        <span>Vendor Trunk *</span>
        <ListLookup<TrunkListRow>
          list="vendor_trunks"
          value={vendorTrunkId}
          onChange={(t) => setVendorTrunkId(t?.id ?? null)}
          labelOf={(t) => t.name}
          detailOf={(t) => t.enterpriseName}
          fixed={[{ field: "status", op: "in", values: ["active"] }]}
          placeholder="Search active vendor trunks…"
        />
      </div>
      <p className="muted small">
        {eligible} of {ids.length} can be re-sent: only final attempts that were not delivered. Each becomes a new
        attempt on this trunk, marked with the repush request.
      </p>
    </Modal>
  );
}

const openTicket = (rows: EdrGridRow[]) => ask<void>((d) => <TroubleTicketDialog rows={rows} done={() => d()} />);
const openRepush = (rows: EdrGridRow[]) =>
  ask<void>((d) => (
    <RepushDialog
      ids={rows.map((r) => r.uuid)}
      eligible={rows.filter((r) => r.isFinalAttempt && r.msgStatus !== "DELIVRD").length}
      done={() => d()}
    />
  ));
const openDownload = (state: GridState) =>
  ask<void>((d) => <RequestDialog kind="edr" state={state} done={() => d()} />);

// ---------------------------------------------------------------- detail

function Attempts({ row }: { row: EdrGridRow }) {
  const q = useQuery({
    queryKey: ["list", "edr-attempts", row.customerMsgId, row.customerTrunkId],
    queryFn: () =>
      fetchEdrs({
        filter: {
          logic: "and",
          conditions: [
            { field: "customerMsgId", op: "eq", value: row.customerMsgId },
            { field: "customerTrunkId", op: "eq", value: row.customerTrunkId },
          ],
        },
        sort: [{ field: "startTime", dir: "asc" }],
        limit: 20,
        withTotal: false,
      }),
  });
  if (!q.data) return <p className="muted small">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Start</th>
          <th>Vendor Trunk</th>
          <th>Cause</th>
          <th>Status</th>
          <th>Final</th>
        </tr>
      </thead>
      <tbody>
        {q.data.rows.map((a) => (
          <tr key={a.uuid} className={a.uuid === row.uuid ? "row-current" : undefined}>
            <td className="num">{a.attemptNo}</td>
            <td className="small num">{fmtSeconds(a.startTime)}</td>
            <td className="small">{a.vendorTrunk ?? muted("not routed")}</td>
            <td className="small">{a.causeCode ? `${a.causeCode} ${a.causeText}` : "OK"}</td>
            <td className="small">
              {a.msgStatus ? (
                <>
                  <StatusDot tone={msgStatusTone(a.msgStatus)} /> {a.msgStatus}
                </>
              ) : (
                muted("—")
              )}
            </td>
            <td className="small">{a.isFinalAttempt ? "Yes" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FieldList({ row, fields, names }: { row: EdrGridRow; fields: string[]; names: Map<string, string> }) {
  const values = row as unknown as Record<string, unknown>;
  return (
    <dl className="kv kv-dense">
      {fields.map((f) => (
        <div key={f} className="kv-pair">
          <dt>{names.get(f) ?? f}</dt>
          <dd className={f === "messageText" ? "kv-text" : undefined}>
            {f === "id" ? row.uuid : f.endsWith("Time") ? fmtSeconds(values[f] as string | null) : fieldText(values[f])}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function EdrSearchPage() {
  const fields = useListFields("edrs");
  const navigate = useTabNavigate();
  const names = new Map((fields.data?.fields ?? []).map((f) => [f.field, f.label]));
  return (
    <ListScreen<EdrGridRow>
      list="edrs"
      page={page}
      historyScope={null}
      fetchPage={fetchEdrs}
      toolbar={(state, setState) => <EdrToolbar state={state} setState={setState} />}
      onExport={(s) => void openDownload(s)}
      actions={
        <Button small icon="file" onClick={() => navigate("/monitoring/edr-templates")}>
          Templates
        </Button>
      }
      columns={{
        startTime: { width: 170, render: (r) => <span className="num">{fmtSeconds(r.startTime)}</span> },
        submitTime: { width: 170, render: (r) => <span className="num">{fmtSeconds(r.submitTime)}</span> },
        deliveryTime: { width: 170, render: (r) => <span className="num">{fmtSeconds(r.deliveryTime)}</span> },
        id: { width: 290, render: (r) => <span className="num small">{r.uuid}</span> },
        customerEnterprise: { width: 200, render: (r) => r.customerEnterprise ?? muted("—") },
        customerTrunk: { width: 170 },
        customerMsgId: { width: 170, render: (r) => <span className="num small">{r.customerMsgId}</span> },
        senderId: { width: 130 },
        dnid: { width: 140, render: (r) => <span className="num">{r.dnid}</span> },
        customerMccmnc: { width: 120, render: (r) => <span className="num">{r.customerMccmnc}</span> },
        vendorEnterprise: { width: 200, render: (r) => r.vendorEnterprise ?? muted("not routed") },
        vendorTrunk: { width: 170, render: (r) => r.vendorTrunk ?? muted("—") },
        vendorMsgId: {
          width: 150,
          render: (r) => (r.vendorMsgId ? <span className="num small">{r.vendorMsgId}</span> : muted("—")),
        },
        causeCode: {
          width: 200,
          render: (r) =>
            r.causeCode ? (
              <span className="tone-error" title={r.causeText}>{`${r.causeCode} ${r.causeText}`}</span>
            ) : (
              muted("0 OK")
            ),
        },
        msgStatus: {
          width: 130,
          render: (r) =>
            r.msgStatus ? (
              <span>
                <StatusDot tone={msgStatusTone(r.msgStatus)} /> {r.msgStatus}
              </span>
            ) : (
              muted("—")
            ),
        },
        deliveryDelaySeconds: {
          width: 120,
          align: "right",
          render: (r) => (
            <span className="num">{r.deliveryDelaySeconds ? r.deliveryDelaySeconds.toFixed(1) : "—"}</span>
          ),
        },
      }}
      selection={{
        summary: (_rows, ids) => `${ids.size} EDR${ids.size === 1 ? "" : "s"} selected`,
        bulk: (ids, clear) => [
          { label: "Trouble Ticket…", icon: "mail", onSelect: () => void openTicket(uuidsOf(ids)).then(clear) },
          { label: "EDR Repush…", icon: "send", onSelect: () => void openRepush(uuidsOf(ids)).then(clear) },
        ],
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.senderId} → {r.dnid}
            </strong>
            <span className="muted">
              {fmtSeconds(r.startTime)} · attempt {r.attemptNo}
              {r.isFinalAttempt ? " (final)" : ""} · {r.msgStatus || (r.causeCode ? r.causeText : "no receipt yet")}
            </span>
          </>
        ),
        sections: [
          ...EDR_SECTIONS.map((s) => ({
            key: s.key,
            label: s.label,
            content: <FieldList row={r} fields={s.fields} names={names} />,
            ...(s.key === "outcome"
              ? {
                  actions: (
                    <>
                      <Button small icon="mail" onClick={() => void openTicket([r])}>
                        Trouble Ticket
                      </Button>
                      <Button small icon="send" onClick={() => void openRepush([r])}>
                        Repush
                      </Button>
                    </>
                  ),
                }
              : {}),
          })),
          { key: "attempts", label: "Attempts", content: <Attempts row={r} /> },
        ],
      })}
      shortcuts="↑↓ move · Space selects · Bulk edit: Trouble Ticket, EDR Repush · Export: EDR Request"
    />
  );
}
