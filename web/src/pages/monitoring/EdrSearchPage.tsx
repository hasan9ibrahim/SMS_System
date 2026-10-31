// EDR Search (§9.1): every message attempt with both legs, from the EDR store. One box for numbers, senders and
// message IDs, the period, destinations and status sit in the filter card; every column filters with the §13.25 grammar; an EDR
// Template sets the columns. Selected EDRs go to a Trouble Ticket or an EDR Repush; Export queues an
// EDR Request (background download, §12.4) with the current filters.
import type { MenuItem } from "../../ui/primitives";
import { useCan } from "../../api/access";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EdrRow, EmailPreview, EmailTemplateRow, FieldDescriptor, ListQuery, TrunkListRow } from "@sms/contract";
import { fetchPickPage, fetchListPage, useListFields, type ListPage } from "../../api/hooks";
import { previewTroubleTicket, useEdrTemplates, useRepush, useSendTroubleTicket } from "../../api/observation";
import { switchOf, withSwitch, type GridState } from "../../grid/filterModel";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ListLookup } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, Popover, StatusDot } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { RangeChip } from "../../ui/DateRange";
import { problemText } from "../routing/dialogs";
import { toBase64 } from "../switch/tools/toolsModel";
import {
  EDR_SECTIONS,
  EDR_SWITCH_FIELDS,
  fieldText,
  fmtSeconds,
  msgStatusTone,
  parseMixedList,
  timeBounds,
  timeCondition,
  toGridRow,
  withheldCells,
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
    return { ...p, rows, masked: withheldCells(rows) };
  });
/** Today 00:00 – 23:59 UTC on Start Time, the page's default period (team trial round 2). */
const todayCondition = () => {
  const d = new Date().toISOString().slice(0, 10);
  return timeCondition("startTime", `${d}T00:00`, `${d}T23:59`)!;
};
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

/**
 * The number / sender / message ID box (team trial round 2): applies while typing (after a short pause), so there
 * is no need to press Enter or leave the box.
 */
function SearchBox({ value, onSearch }: { value: string; onSearch: (text: string) => void }) {
  const [text, setText] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) setText(value);
    last.current = value;
  }, [value]);
  useEffect(() => {
    if (text === last.current) return;
    const t = window.setTimeout(() => {
      last.current = text;
      onSearch(text);
    }, 450);
    return () => window.clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      value={text}
      placeholder="Number, sender, message ID…"
      aria-label="Numbers, senders or Msg IDs"
      title="The start of receiver numbers, sender IDs, Customer Msg IDs or Vendor Msg IDs (any part of a long message); several separated by commas"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          last.current = text;
          onSearch(text);
        }
      }}
    />
  );
}

/** Message statuses and Final in one chip (design refresh, team trial round 2). */
function StatusChip({
  state,
  set,
}: {
  state: GridState;
  set: (field: string, c: GridState["columns"][string] | null) => void;
}) {
  const fields = useListFields("edrs");
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const statuses = fields.data?.fields.find((f) => f.field === "msgStatus")?.enumValues ?? [];
  const c = switchOf(state, "msgStatus");
  const picked = c?.values?.map(String) ?? (c?.value !== undefined ? [String(c.value)] : []);
  const final = switchOf(state, "isFinalAttempt")?.value === true;
  const label =
    picked.length === 0 ? "All" : picked.length === 1 ? picked[0] || "(none yet)" : `${picked.length} statuses`;
  const toggle = (v: string) => {
    const next = picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v];
    set("msgStatus", next.length ? { field: "msgStatus", op: "in", values: next } : null);
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`range-chip plain${picked.length || final ? " set" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Status: {label}
        {final ? " · final" : ""}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="range-pop">
        <div className="range-pop-list">
          <label className="choice-row">
            <input
              type="checkbox"
              checked={final}
              onChange={(e) =>
                set("isFinalAttempt", e.target.checked ? { field: "isFinalAttempt", op: "eq", value: true } : null)
              }
            />
            Final attempt only
          </label>
          <div className="menu-sep" />
          {/* Count and Check all / Uncheck all above the statuses (team trial round 12). None ticked = all. */}
          <div className="checklist-bar chip-checks-bar">
            <span className="muted">
              {picked.length ? `Selected ${picked.length} of ${statuses.length}` : "None ticked: showing all"}
            </span>
            <span className="checklist-actions">
              <button
                type="button"
                className="link"
                disabled={picked.length === statuses.length}
                onClick={() => set("msgStatus", { field: "msgStatus", op: "in", values: statuses.map((o) => o.value) })}
              >
                Check all
              </button>
              <button type="button" className="link" disabled={!picked.length} onClick={() => set("msgStatus", null)}>
                Uncheck all
              </button>
            </span>
          </div>
          {statuses.map((o) => (
            <label key={o.value} className="choice-row">
              <input type="checkbox" checked={picked.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      </Popover>
    </>
  );
}

/**
 * EDR search filters (design refresh, team trial round 2): one box for numbers, senders and message IDs, the
 * period as a chip, Destinations and Status chips, and the column template. Page switches (team trial round 10): the
 * header boxes and pills on the same columns filter on their own.
 */
function EdrToolbar({ state, setState }: { state: GridState; setState: (s: GridState) => void }) {
  const templates = useEdrTemplates();
  const bounds = timeBounds(switchOf(state, "startTime"));
  const set = (field: string, c: GridState["columns"][string] | null) => setState(withSwitch(state, field, c));
  const ids = (field: string) => {
    const c = switchOf(state, field);
    return c?.op === "in" ? (c.values ?? []).join(", ") : c?.op === "eq" ? String(c.value) : "";
  };
  const setIds = (field: string, text: string) => {
    const list = parseMixedList(text);
    set(
      field,
      list.length > 1 ? { field, op: "in", values: list } : list.length ? { field, op: "eq", value: list[0]! } : null,
    );
  };
  const today = new Date().toISOString().slice(0, 10);
  const isToday = bounds.from.startsWith(today) && (bounds.to === "" || bounds.to.startsWith(today));
  const dest = switchOf(state, "customerMccmnc");
  const destCount = dest?.values?.length ?? (dest?.value !== undefined ? 1 : 0);
  return (
    <>
      {/* Numbers, senders and message IDs, mixed and comma separated (team trial round 2, §9.1). */}
      <div className="quick-search edr-search">
        <Icon name="search" size={15} />
        <SearchBox value={ids("numberOrMsgId")} onSearch={(text) => setIds("numberOrMsgId", text)} />
      </div>
      <RangeChip
        withTime
        from={bounds.from}
        to={bounds.to}
        suffix="UTC"
        {...(isToday ? { prefix: "Today ·" } : {})}
        onChange={(from, to) => set("startTime", timeCondition("startTime", from, to))}
      />
      <button
        type="button"
        className={`range-chip plain${destCount ? " set" : ""}`}
        onClick={async () => {
          const current = dest?.values?.map(String) ?? (dest?.value !== undefined ? [String(dest.value)] : []);
          const codes = await ask<string[]>((d) => <DestinationsDialog initial={current} done={d} />);
          if (codes === null) return;
          set("customerMccmnc", codes.length ? { field: "customerMccmnc", op: "in", values: codes } : null);
        }}
      >
        Destinations: {destCount ? `${destCount} network${destCount === 1 ? "" : "s"}` : "All"}
      </button>
      <StatusChip state={state} set={set} />
      <select
        className="range-chip plain chip-select"
        aria-label="EDR Template"
        value={templates.data?.find((t) => state.visible && t.columns?.join() === state.visible.join())?.id ?? ""}
        onChange={(e) => {
          const t = templates.data?.find((x) => x.id === Number(e.target.value));
          setState({ ...state, visible: t?.columns ?? null });
        }}
      >
        <option value="">Template: default columns</option>
        {templates.data?.map((t) => (
          <option key={t.id} value={t.id}>
            Template: {t.name}
          </option>
        ))}
      </select>
    </>
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
      fetchPickPage<EmailTemplateRow>("email_templates", {
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
          <span className="muted small">{missing}</span>
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
          {fields.data && (
            <ColumnChecks
              fields={fields.data.fields.filter((f) => !f.filterOnly)}
              value={columns}
              onChange={setColumns}
            />
          )}
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
        {eligible} of {ids.length} can be re-sent (undelivered final attempts only).
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

/** The days around an attempt its message's other attempts fall in: EDR lists need a period (§9.1). */
const ATTEMPTS_WINDOW_MS = 3 * 86_400_000;

function Attempts({ row }: { row: EdrGridRow }) {
  const at = Date.parse(row.startTime);
  const q = useQuery({
    queryKey: ["list", "edr-attempts", row.customerMsgId, row.customerTrunkId],
    queryFn: () =>
      fetchEdrs({
        filter: {
          logic: "and",
          conditions: [
            {
              field: "startTime",
              op: "between",
              values: [new Date(at - ATTEMPTS_WINDOW_MS).toISOString(), new Date(at + ATTEMPTS_WINDOW_MS).toISOString()],
            },
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
  const canRepush = useCan("repush", "add");
  const navigate = useTabNavigate();
  const names = new Map((fields.data?.fields ?? []).map((f) => [f.field, f.label]));
  return (
    <ListScreen<EdrGridRow>
      list="edrs"
      page={page}
      historyScope={null}
      fetchPage={fetchEdrs}
      toolbar={(state, setState) => <EdrToolbar state={state} setState={setState} />}
      // Opens on today (UTC) when the tab has no filters of its own (team trial round 2).
      initialState={{ switches: { startTime: todayCondition() } }}
      noQuickSearch
      toolbarFields={EDR_SWITCH_FIELDS}
      noRecordBar
      autoFit
      exportPrimary
      onExport={(s) => void openDownload(s)}
      actions={(targets) => (
        <>
          <Button icon="file" onClick={() => navigate("/monitoring/edr-templates")}>
            Templates
          </Button>
          <Button
            icon="mail"
            disabled={targets.length === 0}
            title={targets.length ? "E-mail the selected EDRs to a partner" : "Select EDRs first"}
            onClick={() => void openTicket(targets)}
          >
            Trouble ticket
          </Button>
          {/* Repush sits with the other header actions now that Bulk edit is gone (team trial round 4). */}
          {canRepush && (
            <Button
              icon="send"
              disabled={targets.length === 0}
              title={targets.length ? "Send the selected EDRs again" : "Select EDRs first"}
              onClick={() => void openRepush(targets)}
            >
              Repush
            </Button>
          )}
        </>
      )}
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
          // One ID per part for a long message, comma separated (team trial round 2).
          render: (r) =>
            r.vendorMsgId ? (
              <span className="num small" title={r.vendorMsgId.split(",").join("\n")}>
                {r.vendorMsgId}
              </span>
            ) : (
              muted("—")
            ),
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
      rowActions={(r): MenuItem[] => [
        { label: "Trouble Ticket…", icon: "mail", main: true, onSelect: () => void openTicket([r]) },
        ...(canRepush
          ? [
              {
                label: "Repush…",
                icon: "send" as const,
                main: true,
                disabled: !r.isFinalAttempt || r.msgStatus === "DELIVRD",
                hint:
                  !r.isFinalAttempt || r.msgStatus === "DELIVRD"
                    ? "Only final attempts that were not delivered can be re-sent"
                    : "Re-send this EDR on a vendor trunk",
                onSelect: () => void openRepush([r]),
              },
            ]
          : []),
      ]}
      selection={{
        summary: (_rows, ids) => `${ids.size} EDR${ids.size === 1 ? "" : "s"} selected`,
        bulk: (ids, clear) => [
          { label: "Trouble Ticket…", icon: "mail", onSelect: () => void openTicket(uuidsOf(ids)).then(clear) },
          ...(canRepush
            ? [{ label: "EDR Repush…", icon: "send" as const, onSelect: () => void openRepush(uuidsOf(ids)).then(clear) }]
            : []),
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
                      {canRepush && (
                        <Button small icon="send" onClick={() => void openRepush([r])}>
                          Repush
                        </Button>
                      )}
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
