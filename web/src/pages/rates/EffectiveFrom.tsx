// Shared pieces for saving rate changes (team trial round 2): the effective date in the platform time zone
// (default: the start of the next day, 00:00), the note added to the rate notification, and the summary of
// a customer table save shown before it is sent.
import { useState } from "react";
import { DateTimeInput } from "../../ui/DateTimeInput";
import { Button, Modal } from "../../ui/primitives";
import { formatZoned, isoToZoned, nextMidnight, usePlatformTz, zonedToIso } from "../../ui/zonedTime";
import { formatPct, formatRate } from "./format";
import { SendRnCheck } from "./dialogs";
import type { SummaryKind, SummaryRow } from "./pending";

/** The default start of rate changes: the next 00:00 in the platform time zone, as a UTC timestamp. */
export function defaultEffectiveIso(tz: string, now = Date.now()): string {
  return zonedToIso(nextMidnight(tz, now), tz);
}

/**
 * Effective date and time in the platform time zone. `value` is the field value ("YYYY-MM-DDTHH:mm" in that
 * zone, "" = now); use `effectiveIso` to send it.
 */
export function EffectiveFromField({
  value,
  onChange,
  label = "Effective from",
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const tz = usePlatformTz();
  return (
    <div className="field">
      <span title="Rates never start in the past: traffic already sent keeps its rate (§13.32).">
        {label} <span className="muted">({tz}, 24-hour)</span>
      </span>
      <DateTimeInput
        autoFocus={autoFocus}
        value={value}
        min={isoToZoned(Date.now(), tz)}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="eff-quick small">
        <button type="button" className="link-btn" onClick={() => onChange(nextMidnight(tz))}>
          Next 00:00
        </button>
        {" · "}
        <button type="button" className="link-btn" onClick={() => onChange("")}>
          Now
        </button>
        {!value && <span className="muted"> · empty = now</span>}
      </span>
    </div>
  );
}

/** The field value as the API's UTC timestamp; null = now. */
export function effectiveIso(value: string, tz: string): string | null {
  return value ? zonedToIso(value, tz) : null;
}

/** Initial field value: the next 00:00 in the platform time zone. */
export function useDefaultEffective(): [string, (v: string) => void] {
  const tz = usePlatformTz();
  const [v, setV] = useState<string | null>(null);
  return [v ?? nextMidnight(tz), setV];
}

/** Text added to the rate notification e-mail and sheet (team trial round 2). */
export function RnNoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>Note on the RN (included in the e-mail to the clients)</span>
      <textarea
        rows={2}
        maxLength={2000}
        value={value}
        placeholder="e.g. New prices follow the operator's increase from 1 November."
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

const KIND_LABEL: Record<SummaryKind, string> = {
  increase: "Increases",
  decrease: "Decreases",
  close: "Closed",
  block: "Blocked",
  unblock: "Unblocked",
  same: "Other",
};

/** What a customer table save will do, with the RN choice and note, before anything is saved. */
export function SaveSummaryDialog({
  table,
  clients,
  counts,
  rows,
  effectiveFrom,
  scheduledKept,
  sendRn: initialSendRn,
  done,
}: {
  table: string;
  clients: string[];
  counts: Record<SummaryKind, number>;
  rows: SummaryRow[];
  /** UTC timestamp; null = now. */
  effectiveFrom: string | null;
  scheduledKept: boolean;
  sendRn: boolean;
  done: (v: { sendRn: boolean; note: string } | null) => void;
}) {
  const tz = usePlatformTz();
  const [sendRn, setSendRn] = useState(initialSendRn);
  const [note, setNote] = useState("");
  const shown = rows.slice(0, 50);
  const total = rows.length;
  return (
    <Modal
      title={`Save ${total} change${total === 1 ? "" : "s"} to ${table}?`}
      width={720}
      onClose={() => done(null)}
      footer={
        <>
          <SendRnCheck checked={sendRn} onChange={setSendRn} />
          <span className="fb-spacer" />
          <Button onClick={() => done(null)}>Back to editing</Button>
          <Button variant="primary" onClick={() => done({ sendRn, note })}>
            Save {total} change{total === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="save-summary-counts">
        {(Object.keys(KIND_LABEL) as SummaryKind[])
          .filter((k) => counts[k] > 0)
          .map((k) => (
            <span
              key={k}
              className={`chip${k === "increase" ? " tone-warning" : k === "close" || k === "block" ? " tone-error" : ""}`}
            >
              {KIND_LABEL[k]} <strong className="num">{counts[k]}</strong>
            </span>
          ))}
      </div>
      <p className="small">
        Effective <strong>{effectiveFrom ? `${formatZoned(effectiveFrom, tz)} (${tz})` : "now"}</strong>
        {scheduledKept ? " · scheduled rates keep their own start date" : ""}
        {clients.length ? (
          <>
            {" "}
            · used by <strong>{clients.slice(0, 5).join(", ")}</strong>
            {clients.length > 5 ? ` and ${clients.length - 5} more` : ""}
          </>
        ) : (
          " · no client uses this table yet"
        )}
      </p>
      <div className="save-summary-table">
        <table className="mini-table">
          <thead>
            <tr>
              <th>Destination</th>
              <th>Sender ID</th>
              <th>Change</th>
              <th className="num">Current</th>
              <th className="num">New</th>
              <th className="num">%</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.lineId}-${r.kind}`}>
                <td>{r.row ? `${r.row.country} · ${r.row.network} (${r.row.mccmnc})` : `Rate #${r.lineId}`}</td>
                <td>{r.row?.senderId ?? <span className="muted">Any</span>}</td>
                <td
                  className={
                    r.kind === "increase"
                      ? "tone-warning"
                      : r.kind === "close" || r.kind === "block"
                        ? "tone-error"
                        : ""
                  }
                >
                  {KIND_LABEL[r.kind].replace(/s$/, "").replace(/^Other$/, "Change")}
                </td>
                <td className="num">{r.row?.rate == null ? "–" : formatRate(r.row.rate)}</td>
                <td className="num">{r.newRate === null ? "–" : formatRate(r.newRate)}</td>
                <td className="num">{r.changePct === null ? "" : formatPct(r.changePct, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {total > shown.length && <p className="muted small">… and {total - shown.length} more.</p>}
      </div>
      {sendRn && <RnNoteField value={note} onChange={setNote} />}
    </Modal>
  );
}
