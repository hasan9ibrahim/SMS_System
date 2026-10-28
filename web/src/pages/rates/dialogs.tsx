// Rate Manager dialogs (§6.2, §13.12): new rate table (optionally copied from a vendor
// trunk's rates plus a margin), rename, and Add rates for new destinations (§13.21 picker).
import { showRnSummary } from "./SendRatesDialog";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NoticeBreach, RateLineEdit, RateTableDetail, TrunkListRow } from "@sms/contract";
import { ApiError } from "../../api/client";
import { fetchListPage } from "../../api/hooks";
import { usePlatformCurrency, useChangeRateLines, useReference, useSaveRateTable } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { ListLookup } from "../../records/parts";
import { Icon } from "../../ui/Icon";
import { Button, Modal } from "../../ui/primitives";
import { DestinationTree } from "./DestinationTree";
import { NoticeDialog, type NoticeChoice } from "./RateTableView";
import { ask } from "../../ui/feedback";
import { todayMidnight, usePlatformTz } from "../../ui/zonedTime";
import { EffectiveFromField, effectiveIso, RnNoteField } from "./EffectiveFrom";

/** "Send RN" on rating saves (team trial round 1): ticked by default on customer tables. */
export function SendRnCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      className="toggle-inline send-rn"
      title="E-mail a rate notification with the changed rates to each client using the table (Email logs)"
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Send RN to clients
    </label>
  );
}

const problemText = (e: unknown) => {
  if (!(e instanceof ApiError)) return String(e);
  const errors = (e.problem.errors ?? []) as { path: string; message: string }[];
  return errors.length ? errors.map((x) => `${x.path.replace(/^\//, "")}: ${x.message}`).join("; ") : e.message;
};

export function NewRateTableDialog({
  done,
  initial,
}: {
  done: (id: number | null) => void;
  /** Starting values, e.g. from the customer trunk the table is created for (team trial round 5). */
  initial?: { name?: string; categoryId?: number | null };
}) {
  const ref = useReference();
  const save = useSaveRateTable();
  const notifySaved = useNotifySaved();
  const [name, setName] = useState(initial?.name ?? "");
  const [categoryId, setCategoryId] = useState<number | null>(initial?.categoryId || null);
  const [currency, setCurrency] = useState(usePlatformCurrency());
  const [description, setDescription] = useState("");
  const [copy, setCopy] = useState(false);
  const [vendorTrunkId, setVendorTrunkId] = useState<number | null>(null);
  const [marginPct, setMarginPct] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!name.trim() || !categoryId) return setError("Name and product category are required.");
    if (copy && !vendorTrunkId) return setError("Choose the vendor trunk to copy from.");
    save.mutate(
      {
        id: null,
        input: {
          name: name.trim(),
          categoryId,
          currency,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(copy && vendorTrunkId ? { copyFrom: { vendorTrunkId, marginPct } } : {}),
        },
      },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `Added ${r.record.name}`);
          done(r.record.id);
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  };
  return (
    <Modal
      title="New rate table"
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            Add rate table
          </Button>
        </>
      }
    >
      <label className="field">
        <span>
          Name<span className="req">*</span>
        </span>
        <input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="fgrid cols-2">
        <label className="field">
          <span>
            Product category<span className="req">*</span>
          </span>
          <select
            value={categoryId ?? ""}
            onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">—</option>
            {ref.data?.productCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            Currency<span className="req">*</span>
          </span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {ref.data?.currencies.map((c) => (
              <option key={c.iso} value={c.iso}>
                {c.iso} – {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Description</span>
        <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="toggle-inline">
        <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
        Copy rates from a vendor trunk
      </label>
      {copy && (
        <div className="fgrid cols-2" style={{ marginTop: 8 }}>
          <div className="field">
            <span>Vendor trunk</span>
            <ListLookup<TrunkListRow>
              list="vendor_trunks"
              value={vendorTrunkId}
              onChange={(r) => setVendorTrunkId(r?.id ?? null)}
              labelOf={(r) => r.name}
              detailOf={(r) => `${r.enterpriseName} · ${r.category ?? ""}`}
              placeholder="Search vendor trunks…"
            />
          </div>
          <label className="field">
            <span>Margin %</span>
            <input type="number" value={marginPct} step={0.5} onChange={(e) => setMarginPct(Number(e.target.value))} />
          </label>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

export function RenameTableDialog({ table, done }: { table: RateTableDetail; done: () => void }) {
  const save = useSaveRateTable();
  const notifySaved = useNotifySaved();
  const [name, setName] = useState(table.name);
  const [description, setDescription] = useState(table.description ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title={`Rename ${table.name}`}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { id: table.id, input: { name: name.trim(), description: description.trim() || null } },
                {
                  onSuccess: (r) => {
                    if (r.change) notifySaved(r.change, "Saved");
                    done();
                  },
                  onError: (e) => setError(problemText(e)),
                },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <label className="field">
        <span>
          Name<span className="req">*</span>
        </span>
        <input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Description</span>
        <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

/**
 * Add rates for destinations (§12.1 Add rate line: one line per chosen MCCMNC). Destinations are picked
 * in the country / network tree, with select all on the filtered ones (team trial round 1).
 */
export function AddRatesDialog({ table, done }: { table: RateTableDetail; done: () => void }) {
  const change = useChangeRateLines(table.id);
  const notifySaved = useNotifySaved();
  const [picked, setPicked] = useState<string[]>([]);
  const [rate, setRate] = useState("");
  const [senderId, setSenderId] = useState("");
  const tz = usePlatformTz();
  const platformCurrency = usePlatformCurrency();
  // Default start: today 00:00 in the platform time zone; applies from the save (team trial round 2).
  const [from, setFrom] = useState(() => todayMidnight(tz));
  const [note, setNote] = useState("");
  const [rnNote, setRnNote] = useState("");
  const [sendRn, setSendRn] = useState(table.kind === "customer");
  const [error, setError] = useState<string | null>(null);
  const submit = (notice: NoticeChoice | null = null) => {
    const value = Number(rate);
    if (!picked.length) return setError("Choose at least one destination.");
    if (!rate || !Number.isFinite(value) || value < 0) return setError("Enter the rate.");
    const items: RateLineEdit[] = picked.map((mccmnc) => ({
      action: "set",
      mccmnc,
      rate: value,
      ...(senderId.trim() ? { senderId: senderId.trim() } : {}),
      ...(from ? { effectiveFrom: effectiveIso(from, tz)! } : {}),
      ...(note.trim() ? { rateNote: note.trim() } : {}),
    }));
    const notify = sendRn && table.kind === "customer";
    change.mutate(
      {
        items,
        sendNotification: notify,
        ...(notify && rnNote.trim() ? { notificationNote: rnNote.trim() } : {}),
        ...(notice === "anyway" ? { acceptNoticeBreach: true } : notice === "notice" ? { respectNotice: true } : {}),
      },
      {
        onSuccess: (r) => {
          if (r.change)
            notifySaved(
              r.change,
              `Added ${r.applied} rate${r.applied === 1 ? "" : "s"}`,
            );
          showRnSummary(r.notifications);
          done();
        },
        onError: (e) => {
          // Sooner than a client's notice (team trial round 8): warn, then apply anyway or send with notice.
          if (e instanceof ApiError && e.status === 409) {
            setError(null);
            void ask<NoticeChoice>((d) => <NoticeDialog breach={e.problem as unknown as NoticeBreach} done={d} />).then(
              (choice) => choice && submit(choice),
            );
            return;
          }
          setError(problemText(e));
        },
      },
    );
  };
  return (
    <Modal
      title={`Add rates to ${table.name}`}
      width={680}
      onClose={done}
      footer={
        <>
          {table.kind === "customer" && <SendRnCheck checked={sendRn} onChange={setSendRn} />}
          <Button onClick={done}>Cancel</Button>
          <Button variant="primary" onClick={() => submit()} disabled={change.isPending}>
            Add {picked.length || ""} rate{picked.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="field">
        <span>
          Destinations<span className="req">*</span>
        </span>
        <DestinationTree selected={picked} onChange={setPicked} height={260} />
      </div>
      <div className="fgrid cols-3">
        <label className="field">
          <span>
            Rate ({table.currency})<span className="req">*</span>
          </span>
          <input type="number" min={0} step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} />
          {rate !== "" && table.currency !== platformCurrency && Number.isFinite(Number(rate)) && (
            <span className="muted small">
              = {(Number(rate) * table.platformPerUnit).toFixed(6)} {platformCurrency}
            </span>
          )}
        </label>
        <label className="field">
          <span>Sender ID</span>
          <input value={senderId} maxLength={20} placeholder="Any" onChange={(e) => setSenderId(e.target.value)} />
        </label>
        <EffectiveFromField value={from} onChange={setFrom} />
      </div>
      <label className="field">
        <span>Rate note (saved on the rates)</span>
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      {sendRn && table.kind === "customer" && <RnNoteField value={rnNote} onChange={setRnNote} />}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}
