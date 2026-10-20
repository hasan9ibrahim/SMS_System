// Incoming RNs (§13.13 A, §13.32): vendor rate notifications from the rates mailbox or uploads. The
// queue lists every RN with its flags and status; opening one (?rn=ID, same tab) shows the review
// screen: header with the match and notice details, counts, the lines with flagged ones on top and
// column filters, Accept / Reject for the whole RN or the selected lines, Accept and reroute (Route
// Rules on the trunk), Accept and update customers (Bulk rating), and the replies and log.
import { useMemo, useState } from "react";
import { useLocation } from "react-router";
import type { RnDetail, RnLineRow, RnRow, RnSettings, VendorRnSettings } from "@sms/contract";
import { useListFields } from "../../../api/hooks";
import {
  rnFileUrl,
  useAssignRn,
  useDecideRn,
  useIntakeRn,
  useRecheckRn,
  useRn,
  useRnSettings,
  useSaveRnSettings,
  useSaveVendorRnSettings,
  useSendRnReply,
  useVendorRnSettings,
} from "../../../api/rn";
import { DataGrid, type ColumnOverride } from "../../../grid/DataGrid";
import { emptyState, type GridState } from "../../../grid/filterModel";
import { useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { ListLookup } from "../../../records/parts";
import { usePageStatus, useTabNavigate, useTabTitle } from "../../../shell/tabContext";
import { ask, confirmDialog, toast } from "../../../ui/feedback";
import { Icon } from "../../../ui/Icon";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen } from "../../reference/shared";
import { Kv } from "../../admin/parts";
import { formatPct, formatRate, shortDate } from "../format";
import { CHANGE, changeSummary, decidable, lineFlags, rerouteUrl, STATUS, updateCustomersUrl } from "./rnModel";

const page = pageForPath("/rates/incoming")!;
const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
const statusCell = (s: RnRow["status"]) => (
  <span>
    <StatusDot tone={STATUS[s].tone} /> {STATUS[s].label}
  </span>
);
const count = (n: number, tone: "error" | "warning") =>
  n > 0 ? (
    <span className={`tone-${tone} strong num`}>{n.toLocaleString("en-US")}</span>
  ) : (
    <span className="muted num">0</span>
  );

// ---------------------------------------------------------------- dialogs

/** How a sheet column was read, in words (team trial round 2). */
const FIELD_LABEL: Record<string, string> = {
  mccmnc: "MCCMNC",
  mcc: "MCC",
  mnc: "MNC",
  dialCode: "Dial code",
  country: "Country",
  network: "Network",
  rate: "Rate",
  currency: "Currency",
  effective: "Effective date",
  changeType: "Change type",
  username: "Username (trunk)",
  senderId: "Sender ID",
};

function UploadDialog({ done }: { done: (rnId: number | null) => void }) {
  const intake = useIntakeRn();
  const [mode, setMode] = useState<"upload" | "email">("upload");
  const [trunkId, setTrunkId] = useState<number | null>(null);
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");
  // Excel files go as base64; protected sheets are read (team trial round 2).
  const [excel, setExcel] = useState<string | null>(null);
  const [headerRow, setHeaderRow] = useState("");
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const submit = () =>
    intake.mutate(
      {
        source: mode,
        ...(mode === "upload" && trunkId ? { vendorTrunkId: trunkId } : {}),
        ...(mode === "email"
          ? { fromAddress: from || null, subject: subject || null, body: body || null, mailbox: "rates" }
          : {}),
        attachments: [
          {
            fileName: fileName || "pasted.csv",
            content: excel ?? content,
            encoding: excel ? "base64" : "text",
            headerRow: Number(headerRow) >= 1 ? Math.floor(Number(headerRow)) : null,
          },
        ],
      },
      {
        onSuccess: (r) => {
          const parts = [
            `${r.created.length} RN${r.created.length === 1 ? "" : "s"} created`,
            r.autoAccepted ? `${r.autoAccepted} auto-accepted` : "",
            r.unmatched ? `${r.unmatched} without a trunk` : "",
            r.failed ? `${r.failed} failed` : "",
          ].filter(Boolean);
          toast({ tone: r.failed || r.unmatched ? "warning" : "good", message: parts.join(" · ") });
          done(r.created[0]?.id ?? null);
        },
        onError: fail,
      },
    );
  return (
    <Modal
      title="Add a vendor rate notification"
      width={640}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" disabled={(!excel && !content.trim()) || intake.isPending} onClick={submit}>
            {intake.isPending ? "Reading…" : "Read and check"}
          </Button>
        </>
      }
    >
      <div className="segmented small-seg" role="group" aria-label="Source">
        <button type="button" className={mode === "upload" ? "on" : ""} onClick={() => setMode("upload")}>
          Upload a file
        </button>
        <button type="button" className={mode === "email" ? "on" : ""} onClick={() => setMode("email")}>
          Simulate an e-mail
        </button>
      </div>
      {mode === "upload" ? (
        <div className="field">
          <span>Vendor trunk (empty = find it from the file's username column or name)</span>
          <ListLookup<{ id: number; name: string; enterprise?: string }>
            list="vendor_trunks"
            value={trunkId}
            onChange={(r) => setTrunkId(r?.id ?? null)}
            labelOf={(r) => r.name}
            placeholder="Find the trunk automatically"
          />
        </div>
      ) : (
        <div className="rn-form-grid">
          <label className="field">
            <span>From</span>
            <input value={from} placeholder="rates@vendor.example" onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>Subject (the trunk's username or name is found here)</span>
            <input value={subject} placeholder="Rate update – account …" onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="field rn-span">
            <span>Body</span>
            <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
        </div>
      )}
      <label className="field">
        <span>
          Rate sheet: Excel (.xlsx, first sheet; protected sheets are read) or CSV, semicolon or tab separated (paste
          from Excel). Columns are found by their headers.
        </span>
        <input
          type="file"
          accept=".xlsx,.csv,.txt,.tsv"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFileName(f.name);
            if (/\.xlsx$/i.test(f.name)) {
              const bytes = new Uint8Array(await f.arrayBuffer());
              let bin = "";
              for (let i = 0; i < bytes.length; i += 0x8000)
                bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
              setExcel(btoa(bin));
              setContent("");
            } else {
              setExcel(null);
              setContent(await f.text());
            }
          }}
        />
      </label>
      <label className="field rn-header-row">
        <span>Header row (empty = find it: the first row with a rate and a destination column)</span>
        <input
          type="number"
          min={1}
          max={1000}
          step={1}
          value={headerRow}
          placeholder="Auto"
          onChange={(e) => setHeaderRow(e.target.value)}
        />
      </label>
      {excel ? (
        <p className="muted small">
          <Icon name="file" size={13} /> {fileName} will be read as an Excel workbook.{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setExcel(null);
              setFileName("");
            }}
          >
            Remove
          </button>
        </p>
      ) : (
        <textarea
          className="rn-paste"
          rows={8}
          aria-label="Sheet content"
          placeholder={"MCCMNC;Network;Rate;Effective Date\n26201;Telekom;0.0412;01/11/2026"}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      )}
    </Modal>
  );
}

function ReasonDialog({ count: n, done }: { count: number; done: (reason: string | null) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      title={`Reject ${n.toLocaleString("en-US")} rate${n === 1 ? "" : "s"}`}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="danger" disabled={!reason.trim()} onClick={() => done(reason.trim())}>
            Reject
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Reason (required; it goes in the Rejected reply to the vendor)</span>
        <textarea autoFocus rows={3} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </label>
      <p className="muted small">Rejected rates are not loaded.</p>
    </Modal>
  );
}

const MODES = ["auto", "confirm", "off"] as const;
const MODE_LABEL = { auto: "Send automatically", confirm: "Draft, confirm first", off: "Don't send" };

function SettingsDialog({ done }: { done: (v: null) => void }) {
  const q = useRnSettings();
  const save = useSaveRnSettings();
  const [draft, setDraft] = useState<RnSettings | null>(null);
  const s = draft ?? q.data ?? null;
  const [vendor, setVendor] = useState<number | null>(null);
  return (
    <Modal
      title="Incoming RN settings"
      width={720}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Close</Button>
          <Button
            variant="primary"
            disabled={!draft || save.isPending}
            onClick={() =>
              draft &&
              save.mutate(draft, {
                onSuccess: () => {
                  toast({ tone: "good", message: "Settings saved" });
                  setDraft(null);
                },
                onError: fail,
              })
            }
          >
            Save defaults
          </Button>
        </>
      }
    >
      {s && (
        <>
          <h3 className="part-title">Defaults (§13.32)</h3>
          <div className="rn-form-grid">
            <label className="field">
              <span>Live traffic window</span>
              <select
                value={s.liveWindow}
                onChange={(e) => setDraft({ ...s, liveWindow: e.target.value as RnSettings["liveWindow"] })}
              >
                <option value="1h">Last hour</option>
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
              </select>
            </label>
            <label className="field">
              <span>Messages to count as live</span>
              <input
                type="number"
                min={1}
                value={s.minMessages}
                onChange={(e) => setDraft({ ...s, minMessages: Math.max(1, Number(e.target.value)) })}
              />
            </label>
            <label
              className="field"
              title="Back-dated rates with at least this many messages sent since their stated date need review: re-rating is offered on accept and the RN is not auto-accepted"
            >
              <span>Back-dated: messages sent to need review</span>
              <input
                type="number"
                min={1}
                value={s.rerateMinMessages}
                onChange={(e) => setDraft({ ...s, rerateMinMessages: Math.max(1, Number(e.target.value)) })}
              />
            </label>
            <label className="field">
              <span>Due soon: days before the date</span>
              <input
                type="number"
                min={0}
                max={30}
                value={s.reminderDays}
                onChange={(e) => setDraft({ ...s, reminderDays: Number(e.target.value) })}
              />
            </label>
            <label className="toggle-inline rn-span">
              <input
                type="checkbox"
                checked={s.autoAccept}
                onChange={(e) => setDraft({ ...s, autoAccept: e.target.checked })}
              />
              Auto-accept RNs with no flagged rate (no live increase or close, no notice breach, no errors)
            </label>
            {(["successful", "failed", "rejected"] as const).map((k) => (
              <label key={k} className="field">
                <span>{k[0]!.toUpperCase() + k.slice(1)} reply</span>
                <select
                  value={s.replyModes[k]}
                  onChange={(e) => setDraft({ ...s, replyModes: { ...s.replyModes, [k]: e.target.value } })}
                >
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABEL[m]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <h3 className="part-title">Per vendor</h3>
          <ListLookup<{ id: number; name: string; type?: string }>
            list="enterprises"
            value={vendor}
            fixed={[{ field: "type", op: "in", values: ["vendor", "both"] }]}
            onChange={(r) => setVendor(r?.id ?? null)}
            labelOf={(r) => r.name}
            placeholder="Choose a vendor…"
          />
          {vendor !== null && <VendorSettings key={vendor} id={vendor} />}
        </>
      )}
    </Modal>
  );
}

function VendorSettings({ id }: { id: number }) {
  const q = useVendorRnSettings(id);
  const save = useSaveVendorRnSettings();
  const [d, setD] = useState<VendorRnSettings | null>(null);
  const v = d ?? q.data ?? null;
  if (!v) return <p className="muted small">Loading…</p>;
  const modes = v.replyModes;
  return (
    <div className="rn-form-grid rn-vendor">
      <label className="field">
        <span>Auto-accept</span>
        <select
          value={v.autoAccept === null ? "" : v.autoAccept ? "on" : "off"}
          onChange={(e) => setD({ ...v, autoAccept: e.target.value === "" ? null : e.target.value === "on" })}
        >
          <option value="">Default</option>
          <option value="on">On</option>
          <option value="off">Off (always review)</option>
        </select>
      </label>
      <label className="field">
        <span>Agreed notice for increases (days)</span>
        <input
          type="number"
          min={0}
          max={365}
          value={v.noticeDays}
          onChange={(e) => setD({ ...v, noticeDays: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        <span>Replies</span>
        <select
          value={modes ? "own" : ""}
          onChange={(e) =>
            setD({
              ...v,
              replyModes: e.target.value ? { successful: "auto", failed: "auto", rejected: "confirm" } : null,
            })
          }
        >
          <option value="">Default</option>
          <option value="own">This vendor's own</option>
        </select>
      </label>
      {modes &&
        (["successful", "failed", "rejected"] as const).map((k) => (
          <label key={k} className="field">
            <span>{k[0]!.toUpperCase() + k.slice(1)}</span>
            <select value={modes[k]} onChange={(e) => setD({ ...v, replyModes: { ...modes, [k]: e.target.value } })}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        ))}
      <label className="field rn-span">
        <span>Also reply to (comma separated; the RN's sender always gets the reply)</span>
        <input
          value={v.replyTo.join(", ")}
          onChange={(e) =>
            setD({
              ...v,
              replyTo: e.target.value
                .split(/[,\s]+/)
                .map((x) => x.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <div className="field rn-span">
        <span>Remembered columns</span>
        <div className="bulk-row">
          <span className="muted small">
            {v.mapping && Object.keys(v.mapping).length
              ? Object.entries(v.mapping)
                  .map(([h, f]) => `${h} → ${f}`)
                  .join(" · ")
              : "None yet: learnt from the vendor's first file"}
          </span>
          {v.mapping && (
            <Button small variant="ghost" onClick={() => setD({ ...v, mapping: null })}>
              Forget
            </Button>
          )}
        </div>
      </div>
      <div className="rn-span">
        <Button
          small
          disabled={!d || save.isPending}
          onClick={() =>
            d &&
            save.mutate(
              { id, body: d },
              {
                onSuccess: () => {
                  toast({ tone: "good", message: "Vendor settings saved" });
                  setD(null);
                },
                onError: fail,
              },
            )
          }
        >
          Save vendor settings
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- queue

function useOpenRn() {
  const navigate = useTabNavigate();
  return (id: number | null, newTab = false) =>
    navigate(
      id === null ? "/rates/incoming" : `/rates/incoming?rn=${id}`,
      newTab ? { forceNew: true, title: `RN ${id}` } : {},
    );
}

function RnSummary({ r }: { r: RnRow }) {
  const open = useOpenRn();
  return (
    <div className="rn-summary">
      <div className="bulk-row">
        <Button small variant="primary" icon="chevronRight" onClick={() => open(r.id)}>
          Open review
        </Button>
        {r.fileName && (
          <a className="btn btn-sm btn-default" href={rnFileUrl(r.id)}>
            <Icon name="download" size={13} /> File
          </a>
        )}
      </div>
      <Kv
        items={[
          ["Vendor", r.vendor ? `${r.vendor} · ${r.vendorTrunk}` : "no trunk found"],
          [
            "Received",
            `${fmtWhen(r.receivedAt)} · ${r.source === "email" ? `e-mail from ${r.fromAddress ?? "?"}` : "upload"}`,
          ],
          ["Subject", r.subject],
          ["File", r.fileName],
          ["Effective", r.effectiveFrom ? shortDate(r.effectiveFrom) : null],
          ["Rates", `${r.lines.toLocaleString("en-US")}${changeSummary(r) ? ` · ${changeSummary(r)}` : ""}`],
          [
            "Flags",
            `${r.flagged} live · ${r.noticeBreaches} notice · ${r.backdated} back-dated · ${r.turnsNegative} turn negative`,
          ],
          [
            "Decided",
            r.decidedAt ? `${r.autoAccepted ? "auto-accepted" : (r.decidedBy ?? "—")}, ${fmtWhen(r.decidedAt)}` : null,
          ],
        ]}
      />
    </div>
  );
}

function RnQueue() {
  const open = useOpenRn();
  const decide = useDecideRn();
  const recheck = useRecheckRn();
  const notifySaved = useNotifySaved();
  useTabTitle(page.label);
  // Accept all / Reject all pending lines, as in the review header (§13.32).
  const decideAll = async (r: RnRow, kind: "accept" | "reject") => {
    let reason: string | null = null;
    if (kind === "reject") {
      reason = await ask<string>((done) => <ReasonDialog count={r.lines} done={done} />);
      if (!reason) return;
    }
    decide.mutate(
      { id: r.id, kind, body: { ...(reason ? { reason } : {}), rerate: false } },
      {
        onSuccess: (res) => {
          if (res.change) notifySaved(res.change, `Accepted ${res.applied} rate${res.applied === 1 ? "" : "s"}`);
          else
            toast({
              tone: "good",
              message: `${kind === "accept" ? "Accepted" : "Rejected"} ${res.applied} rate${res.applied === 1 ? "" : "s"}`,
            });
        },
        onError: fail,
      },
    );
  };
  const notPending = (r: RnRow) => (decidable(r.status) ? undefined : `${STATUS[r.status].label}: nothing to decide`);
  // Accept several pending RNs at once (team trial round 2): each RN is still its own change.
  const acceptMany = async (rows: RnRow[], clear: () => void) => {
    const pending = rows.filter((r) => decidable(r.status));
    if (!pending.length) return;
    const flagged = pending.filter((r) => r.flagged > 0 || r.noticeBreaches > 0).length;
    const rates = pending.reduce((n, r) => n + r.lines, 0);
    const ok = await confirmDialog({
      title: `Accept ${pending.length} RN${pending.length === 1 ? "" : "s"}?`,
      message: (
        <>
          Every pending rate of {pending.map((r) => r.reference).join(", ")} ({rates.toLocaleString("en-US")} rates) is
          loaded into its vendor trunk's table. Each RN is saved as its own change you can undo.
          {flagged > 0 && (
            <p className="tone-warning">
              {flagged} of them {flagged === 1 ? "has" : "have"} live traffic flags or notice breaches: review them
              first if unsure.
            </p>
          )}
        </>
      ),
      ok: `Accept ${pending.length}`,
    });
    if (!ok) return;
    let done = 0;
    let applied = 0;
    const failed: string[] = [];
    for (const r of pending) {
      try {
        const res = await decide.mutateAsync({ id: r.id, kind: "accept", body: { rerate: false } });
        done++;
        applied += res.applied;
      } catch {
        failed.push(r.reference);
      }
    }
    clear();
    toast({
      tone: failed.length ? "warning" : "good",
      message: `Accepted ${done} RN${done === 1 ? "" : "s"} (${applied.toLocaleString("en-US")} rates)${failed.length ? ` · not accepted: ${failed.join(", ")}` : ""}`,
    });
  };
  return (
    <ListScreen<RnRow>
      list="rate_notifications"
      page={page}
      selection={{
        summary: (rows, ids) => {
          const n = rows.filter((r) => ids.has(r.id) && decidable(r.status)).length;
          return `${ids.size} selected · ${n} pending`;
        },
        bulk: (_ids, clear, rows) => {
          const n = rows.filter((r) => decidable(r.status)).length;
          return [
            {
              label: n ? `Accept ${n} pending RN${n === 1 ? "" : "s"}` : "Accept pending RNs",
              icon: "check",
              disabled: !n || decide.isPending,
              hint: n ? undefined : "None of the selected RNs is pending",
              onSelect: () => void acceptMany(rows, clear),
            },
          ];
        },
      }}
      rowActions={(r) => [
        {
          label: "Accept all",
          icon: "check",
          main: true,
          disabled: !decidable(r.status) || decide.isPending,
          hint: notPending(r) ?? "Accept all pending rates",
          onSelect: () => void decideAll(r, "accept"),
        },
        {
          label: "Reject…",
          icon: "x",
          disabled: !decidable(r.status) || decide.isPending,
          hint: notPending(r) ?? "Reject all pending rates",
          onSelect: () => void decideAll(r, "reject"),
        },
        {
          label: "Re-check",
          icon: "refresh",
          disabled: !r.rateTableId || recheck.isPending,
          hint: r.rateTableId ? undefined : "No vendor trunk matched yet",
          onSelect: () => recheck.mutate(r.id, { onError: fail }),
        },
        {
          label: "Download file",
          icon: "download",
          disabled: !r.fileName,
          hint: r.fileName ?? "No file (e-mail body only)",
          onSelect: () => window.location.assign(rnFileUrl(r.id)),
        },
      ]}
      historyScope={{ entityTypes: ["rate_table"] }}
      primary={{
        label: "Add RN",
        icon: "upload",
        onClick: async () => {
          const id = await ask<number>((done) => <UploadDialog done={done} />);
          if (id) open(id);
        },
      }}
      actions={
        <Button icon="gauge" onClick={() => void ask<null>((done) => <SettingsDialog done={done} />)}>
          Settings
        </Button>
      }
      columns={{
        reference: {
          width: 150,
          render: (r) => (
            <button
              type="button"
              className="link strong"
              onClick={(e) => {
                e.stopPropagation();
                open(r.id, e.ctrlKey || e.metaKey);
              }}
            >
              {r.reference}
            </button>
          ),
        },
        vendor: { width: 200, render: (r) => r.vendor ?? <span className="tone-warning">not matched</span> },
        vendorTrunk: { width: 170, render: (r) => r.vendorTrunk ?? <span className="muted">—</span> },
        receivedAt: { width: 160, render: (r) => fmtWhen(r.receivedAt) },
        effectiveFrom: {
          width: 120,
          render: (r) =>
            r.effectiveFrom ? (
              <span
                className={r.dueSoon ? "tone-warning strong" : undefined}
                title={r.dueSoon ? "Flagged and due soon" : undefined}
              >
                {shortDate(r.effectiveFrom)}
              </span>
            ) : (
              <span className="muted">—</span>
            ),
        },
        lines: {
          width: 80,
          align: "right",
          render: (r) => <span className="num">{r.lines.toLocaleString("en-US")}</span>,
        },
        flagged: { width: 96, align: "right", render: (r) => count(r.flagged, "error") },
        noticeBreaches: { width: 80, align: "right", render: (r) => count(r.noticeBreaches, "warning") },
        backdated: { width: 96, align: "right", render: (r) => count(r.backdated, "warning") },
        status: { width: 150, render: (r) => statusCell(r.status) },
        decidedBy: {
          width: 140,
          render: (r) =>
            r.autoAccepted ? <span className="muted">auto</span> : (r.decidedBy ?? <span className="muted">—</span>),
        },
      }}
      rowClass={(r) => (r.dueSoon ? "row-alert" : undefined)}
      onOpen={(r, e) => open(r.id, e.ctrlKey || e.metaKey)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.reference}</strong>
            <span className="muted">
              {r.vendorTrunk ?? "unmatched"} · {STATUS[r.status].label}
            </span>
          </>
        ),
        sections: [{ key: "rn", label: "RN", content: <RnSummary r={r} /> }],
      })}
      shortcuts="↑↓ move · Enter open the review · Ctrl-click a reference: new tab"
    />
  );
}

// ---------------------------------------------------------------- review

const LINE_COLS: Partial<Record<keyof RnLineRow, ColumnOverride<RnLineRow>>> = {
  country: { width: 130 },
  network: { width: 160 },
  mccmnc: { width: 80, align: "right" },
  change: {
    width: 100,
    render: (r) => (
      <span
        className={
          r.change === "increase" || r.change === "closed"
            ? "tone-warning"
            : r.change === "unchanged"
              ? "muted"
              : undefined
        }
      >
        {CHANGE[r.change]}
      </span>
    ),
  },
  currentRate: { width: 90, align: "right", render: (r) => <span className="num">{formatRate(r.currentRate)}</span> },
  newRate: {
    width: 90,
    align: "right",
    render: (r) => <span className="num">{r.newRate === null ? "closed" : formatRate(r.newRate)}</span>,
  },
  changePct: { width: 84, align: "right", render: (r) => <span className="num">{formatPct(r.changePct, true)}</span> },
  statedFrom: { width: 104, render: (r) => shortDate(r.statedFrom) },
  appliedFrom: {
    width: 104,
    render: (r) => <span className={r.backdated ? "tone-warning" : undefined}>{shortDate(r.appliedFrom)}</span>,
  },
  noticeDaysGiven: { width: 92, align: "right" },
  traffic24h: {
    width: 84,
    align: "right",
    render: (r) => <span className="num">{r.traffic24h.toLocaleString("en-US")}</span>,
  },
  traffic7d: {
    width: 84,
    align: "right",
    render: (r) => <span className="num">{r.traffic7d.toLocaleString("en-US")}</span>,
  },
  affectedCustomers: {
    width: 200,
    render: (r) => <span title={r.affectedCustomers ?? ""}>{r.affectedCustomers ?? "—"}</span>,
  },
  marginNowPct: { width: 90, align: "right", render: (r) => <span className="num">{formatPct(r.marginNowPct)}</span> },
  marginNewPct: {
    width: 90,
    align: "right",
    render: (r) => (
      <span className={`num${r.marginNewPct !== null && r.marginNewPct < 0 ? " tone-error strong" : ""}`}>
        {formatPct(r.marginNewPct)}
      </span>
    ),
  },
  decision: {
    width: 100,
    render: (r) =>
      r.decision === "pending" ? (
        <span className="muted">Pending</span>
      ) : (
        <span className={r.decision === "accepted" ? "tone-good" : "tone-error"} title={r.rejectReason ?? undefined}>
          {r.decision === "accepted" ? "Accepted" : "Rejected"}
        </span>
      ),
  },
  flagged: { width: 70 },
  noticeBreach: { width: 70 },
  backdated: { width: 70 },
};

function Replies({ rn }: { rn: RnDetail }) {
  const send = useSendRnReply();
  const [open, setOpen] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ subject: string; body: string } | null>(null);
  if (!rn.replies.length) return <p className="muted small">No reply yet. Replies follow the decision.</p>;
  return (
    <ul className="rn-replies">
      {rn.replies.map((p) => (
        <li key={p.id}>
          <div className="bulk-row">
            <StatusDot tone={p.status === "sent" ? "good" : p.status === "draft" ? "warning" : "error"} />
            <strong>{p.kind[0]!.toUpperCase() + p.kind.slice(1)}</strong>
            <span className="muted small">
              {p.status === "draft" ? "draft" : `${p.status} ${fmtWhen(p.sentAt)}${p.sentBy ? ` by ${p.sentBy}` : ""}`}
            </span>
            <span className="fb-spacer" />
            <button
              type="button"
              className="link small"
              onClick={() => {
                setOpen(open === p.id ? null : p.id);
                setEdit(null);
              }}
            >
              {open === p.id ? "Hide" : "Show"}
            </button>
          </div>
          <div className="muted small">
            To {p.to.join(", ") || "nobody"} · {p.subject}
          </div>
          {open === p.id &&
            (p.status === "draft" ? (
              <div className="rn-reply-edit">
                <input
                  aria-label="Subject"
                  value={edit?.subject ?? p.subject}
                  onChange={(e) => setEdit({ subject: e.target.value, body: edit?.body ?? p.body })}
                />
                <textarea
                  aria-label="Body"
                  rows={8}
                  value={edit?.body ?? p.body}
                  onChange={(e) => setEdit({ subject: edit?.subject ?? p.subject, body: e.target.value })}
                />
                <Button
                  small
                  variant="primary"
                  disabled={send.isPending}
                  onClick={() =>
                    send.mutate(
                      { id: rn.id, replyId: p.id, body: edit ?? {} },
                      { onSuccess: () => toast({ tone: "good", message: "Reply sent" }), onError: fail },
                    )
                  }
                >
                  Send reply
                </Button>
              </div>
            ) : (
              <pre className="rn-reply-body">{p.body}</pre>
            ))}
        </li>
      ))}
    </ul>
  );
}

function RnReview({ id }: { id: number }) {
  const q = useRn(id);
  const rn = q.data;
  const open = useOpenRn();
  const navigate = useTabNavigate();
  const fields = useListFields("rate_notification_lines");
  const decide = useDecideRn();
  const recheck = useRecheckRn();
  const assign = useAssignRn();
  const notifySaved = useNotifySaved();
  const [grid, setGrid] = useState<GridState>(emptyState);
  const [active, setActive] = useState<RnLineRow | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  // Back-dated rates apply from now; re-rating what was already sent is opt-in (team trial round 2).
  const [rerate, setRerate] = useState(false);
  const [side, setSide] = useState<"replies" | "log" | "errors">("replies");
  useTabTitle(rn ? rn.reference : undefined);
  usePageStatus({
    rows: rn ? `${rn.lines.toLocaleString("en-US")} lines · ${STATUS[rn.status].label}` : "Loading…",
    shortcuts: "Select rates to accept or reject them; flagged rates are on top",
  });
  const gridState: GridState = useMemo(
    () => ({
      ...grid,
      columns: { ...grid.columns, rnId: { field: "rnId", op: "eq", value: id } },
      visible: grid.visible ?? [
        "country",
        "network",
        "mccmnc",
        "change",
        "currentRate",
        "newRate",
        "changePct",
        "statedFrom",
        "appliedFrom",
        "traffic24h",
        "affectedCustomers",
        "marginNowPct",
        "marginNewPct",
        "decision",
      ],
    }),
    [grid, id],
  );

  if (q.isError) return <div className="grid-message error">{problemText(q.error)}</div>;
  if (!rn) return <div className="grid-message muted">Loading…</div>;
  const canDecide = decidable(rn.status);

  const run = async (kind: "accept" | "reject", lineIds: number[], then?: string) => {
    let reason: string | null = null;
    if (kind === "reject") {
      reason = await ask<string>((done) => <ReasonDialog count={lineIds.length || rn.lines} done={done} />);
      if (!reason) return;
    }
    decide.mutate(
      {
        id,
        kind,
        body: {
          ...(lineIds.length ? { lineIds } : {}),
          ...(reason ? { reason } : {}),
          rerate: kind === "accept" && rerate,
        },
      },
      {
        onSuccess: (r) => {
          setSelected(new Set());
          if (r.reratingRequestId)
            toast({
              tone: "good",
              message: `Re-rating request #${r.reratingRequestId} created for the back-dated rates; another user approves it`,
            });
          if (r.change) notifySaved(r.change, `Accepted ${r.applied} rate${r.applied === 1 ? "" : "s"}`);
          else
            toast({
              tone: "good",
              message: `${kind === "accept" ? "Accepted" : "Rejected"} ${r.applied} rate${r.applied === 1 ? "" : "s"}`,
            });
          if (then) navigate(then, { newTab: true });
        },
        onError: fail,
      },
    );
  };
  const sel = [...selected];

  return (
    <div className="page rn-review">
      <div className="page-header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(null)}>
          ← Incoming RNs
        </button>
        <h1>{rn.reference}</h1>
        <span className="muted">
          {rn.vendor ?? "no vendor"} · {rn.vendorTrunk ?? "no trunk"}
        </span>
        {statusCell(rn.status)}
        <span className="fb-spacer" />
        {rn.rateTableId && (
          <Button icon="refresh" disabled={recheck.isPending} onClick={() => recheck.mutate(id, { onError: fail })}>
            Re-check
          </Button>
        )}
        {canDecide && (
          <>
            <Button disabled={decide.isPending} onClick={() => void run("reject", [])}>
              Reject…
            </Button>
            <Button
              disabled={decide.isPending || !rn.affectedMccmncs.length}
              title="Accept, then move traffic in Route Rules before the date"
              onClick={() => void run("accept", [], rerouteUrl(rn))}
            >
              Accept + reroute
            </Button>
            <Button
              disabled={decide.isPending || !rn.affectedRateTableIds.length}
              title="Accept, then re-price the affected customers in Bulk rating (§13.14)"
              onClick={() => void run("accept", [], updateCustomersUrl(rn))}
            >
              Accept + update customers
            </Button>
            {rn.backdatedLive > 0 && (
              <label
                className="toggle-inline small"
                title="Off (default): back-dated rates apply from now and traffic already sent keeps its cost, pending review. On: also creates a re-rating request for the back-dated period, approved by another user."
              >
                <input type="checkbox" checked={rerate} onChange={(e) => setRerate(e.target.checked)} />
                Re-rate back-dated traffic ({rn.backdatedLive})
              </label>
            )}
            <Button variant="primary" icon="check" disabled={decide.isPending} onClick={() => void run("accept", [])}>
              Accept all pending
            </Button>
          </>
        )}
      </div>

      {rn.status === "unmatched" && (
        <div className="rn-banner">
          <Icon name="alert" /> No vendor trunk was found for this RN. Assign it to read the rates against that trunk's
          rates:
          <ListLookup<{ id: number; name: string }>
            list="vendor_trunks"
            value={null}
            onChange={(r) => r && assign.mutate({ id, vendorTrunkId: r.id }, { onError: fail })}
            labelOf={(r) => r.name}
            placeholder="Assign to trunk…"
          />
        </div>
      )}

      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-label">Rates</span>
          <span className="stat-value">{rn.lines.toLocaleString("en-US")}</span>
          <span className="muted small">{changeSummary(rn) || "—"}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Live traffic flags</span>
          <span className={`stat-value${rn.flagged ? " tone-error" : ""}`}>{rn.flagged}</span>
          <span className="muted small">{rn.turnsNegative} turn negative</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Notice breaches</span>
          <span className={`stat-value${rn.noticeBreaches ? " tone-warning" : ""}`}>{rn.noticeBreaches}</span>
          <span className="muted small">{rn.noticeDaysRequired} days required</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Back-dated</span>
          <span className={`stat-value${rn.backdated ? " tone-warning" : ""}`}>{rn.backdated}</span>
          <span className="muted small">applied from receipt, never earlier</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">File errors</span>
          <span className={`stat-value${rn.errors ? " tone-error" : ""}`}>{rn.errors}</span>
          <span className="muted small">{rn.matchReason ? `trunk by ${rn.matchReason}` : "trunk not matched"}</span>
        </div>
      </div>

      <div className="rn-body">
        <section className="rate-grid-card" aria-label="Rates">
          {fields.data && (
            <DataGrid<RnLineRow>
              list="rate_notification_lines"
              fields={fields.data}
              state={gridState}
              onStateChange={(s) => setGrid({ ...s, visible: s.visible })}
              columns={LINE_COLS as Record<string, ColumnOverride<RnLineRow>>}
              activeId={active?.id ?? null}
              onActiveChange={setActive}
              selected={selected}
              onSelectedChange={setSelected}
              rowClass={(r) =>
                r.flagged || r.turnsNegative ? "negative" : r.noticeBreach || r.backdated ? "warn" : undefined
              }
              trailing={{
                header: "Flags",
                width: 300,
                render: (r) => (
                  <span className="rn-flags">
                    {lineFlags(r).map((f) => (
                      <span key={f.label} className={`chip-mini tone-${f.tone}`} title={f.title}>
                        {f.label}
                      </span>
                    ))}
                  </span>
                ),
              }}
            />
          )}
          {selected.size > 0 && (
            <div className="bulk-bar" role="toolbar" aria-label="Rate actions">
              <strong>{selected.size} selected</strong>
              <button
                type="button"
                className="btn btn-sm bar-btn"
                disabled={!canDecide || decide.isPending}
                onClick={() => void run("accept", sel)}
              >
                Accept selected
              </button>
              <button
                type="button"
                className="btn btn-sm bar-btn"
                disabled={!canDecide || decide.isPending}
                onClick={() => void run("reject", sel)}
              >
                Reject selected…
              </button>
              <span className="fb-spacer" />
              <button type="button" className="btn btn-sm btn-ghost bar-btn" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          )}
        </section>
        <aside className="rn-side">
          <div className="segmented small-seg" role="tablist">
            {(
              [
                ["replies", `Replies (${rn.replies.length})`],
                ["log", "Log"],
                ["errors", `File (${rn.fileErrors.length})`],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" className={side === k ? "on" : ""} onClick={() => setSide(k)}>
                {label}
              </button>
            ))}
          </div>
          {active && (
            <div className="rn-active">
              <strong>
                {active.mccmnc} {active.network ?? ""}
              </strong>
              <Kv
                items={[
                  [
                    "Old → new",
                    `${formatRate(active.currentRate)} → ${active.newRate === null ? "closed" : formatRate(active.newRate)} ${active.currency}`,
                  ],
                  ["Stated / applied", `${shortDate(active.statedFrom)} / ${shortDate(active.appliedFrom)}`],
                  ["Notice given", `${active.noticeDaysGiven} days (required ${rn.noticeDaysRequired})`],
                  ["Traffic 1 h / 24 h / 7 d", `${active.traffic1h} / ${active.traffic24h} / ${active.traffic7d}`],
                  [
                    "Sent before receipt",
                    active.backdated
                      ? `${active.sentBetween} msgs, ${active.costBetween} ${active.currency} at the old rate`
                      : null,
                  ],
                  ["Customers", active.affectedCustomers],
                  ["Reject reason", active.rejectReason],
                ]}
              />
            </div>
          )}
          {side === "replies" && <Replies rn={rn} />}
          {side === "log" && (
            <ul className="incident-notes">
              {rn.log.map((g, i) => (
                <li key={i}>
                  <span className="muted small">
                    {g.user ?? "system"} · {fmtWhen(g.at)}
                  </span>
                  <div>{g.text}</div>
                </li>
              ))}
            </ul>
          )}
          {side === "errors" && (
            <>
              <Kv
                items={[
                  ["From", rn.fromAddress],
                  ["Subject", rn.subject],
                  ["File", rn.fileName],
                  ["Header row", rn.headerRow === null ? null : `Row ${rn.headerRow}`],
                ]}
              />
              {rn.columns.length > 0 && (
                <table className="mini-table rn-columns">
                  <thead>
                    <tr>
                      <th className="num">Col</th>
                      <th>Header in the file</th>
                      <th>Read as</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rn.columns.map((c, i) => (
                      <tr key={i} className={c.field ? "" : "off"}>
                        <td className="num">{String.fromCharCode(65 + (i % 26))}</td>
                        <td>{c.header || <span className="muted">(empty)</span>}</td>
                        <td>{c.field ? (FIELD_LABEL[c.field] ?? c.field) : <span className="muted">ignored</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {rn.fileName && (
                <a className="btn btn-sm btn-default" href={rnFileUrl(rn.id)}>
                  <Icon name="download" size={13} /> Download the original file
                </a>
              )}
              {rn.fileErrors.length ? (
                <ul className="rn-errors">
                  {rn.fileErrors.map((e, i) => (
                    <li key={i}>
                      <span className="muted">row {e.line}</span> {e.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">Every row was read.</p>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export function IncomingRnsPage() {
  const location = useLocation();
  const raw = new URLSearchParams(location.search).get("rn");
  const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  return id === null ? <RnQueue /> : <RnReview key={id} id={id} />;
}
