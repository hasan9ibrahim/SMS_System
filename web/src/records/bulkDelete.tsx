// Delete (and Restore) of several selected records of a list, as one change in History (§13.29, §13.10). Double
// confirmation for a delete: the first dialog names the count and the first records, with what the single delete
// would point out and the rows that cannot go (with the reason); the second asks plainly once more. Only then the
// request goes, and the answer's summary (deleted, refused with reasons) is shown. The server applies the single
// delete's safe-delete rules to every row (POST /lists/{list}/bulk-delete); a dry run fills the first dialog.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BulkRecordsResult, ListId } from "@sms/contract";
import { useMe } from "../api/hooks";
import { bulkRecords } from "../api/listActions";
import { useRefreshRecords } from "../api/records";
import { useNotifySaved } from "../history/undo";
import { ask, confirmDialog, toast } from "../ui/feedback";
import { Icon } from "../ui/Icon";
import { Button, Modal } from "../ui/primitives";
import {
  countOf as what,
  goingNames,
  secondConfirmText,
  selectionSentence,
  stillRefused,
  willChange,
  type BulkMode,
} from "./bulkModel";

/** Rows listed in a dialog before "and N more". */
const LISTED = 8;

const n = (count: number) => count.toLocaleString("en-US");

interface Choice {
  override: boolean;
  reason: string;
  count: number;
}

function FirstDialog({
  list,
  mode,
  ids,
  noun,
  plural,
  done,
}: {
  list: ListId;
  mode: BulkMode;
  ids: number[];
  noun: string;
  plural: string;
  done: (c: Choice | null) => void;
}) {
  const { data: me } = useMe();
  const admin = !!me?.permissions.includes("*");
  const preview = useQuery({
    queryKey: ["bulk-preview", list, mode, ids],
    queryFn: () => bulkRecords(list, mode, { ids, dryRun: true }),
    staleTime: 0,
    retry: false,
  });
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const r = preview.data;
  const verb = mode === "delete" ? "Delete" : "Restore";
  const count = r ? willChange(r, override) : 0;
  const overridable = r?.refused.filter((x) => x.overridable).length ?? 0;
  const warned = r?.done.filter((x) => x.warnings.length) ?? [];
  const blocked = r ? stillRefused(r, override) : [];
  const names = r ? goingNames(r, override) : [];
  return (
    <Modal
      title={`${verb} ${what(ids.length, noun, plural)}?`}
      width={620}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant={mode === "delete" ? "danger" : "primary"}
            icon={mode === "delete" ? "trash" : "undo"}
            disabled={!r || count === 0 || (override && !reason.trim())}
            onClick={() => done({ override, reason: reason.trim(), count })}
          >
            {mode === "delete" ? "Continue" : `Restore ${n(count)}`}
          </Button>
        </>
      }
    >
      {preview.isPending && <p className="muted">Checking each record…</p>}
      {preview.isError && <p className="error-text">{(preview.error as Error).message}</p>}
      {r && (
        <>
          <p className="strong">
            {count ? `${selectionSentence(verb, names, noun, plural)}.` : `Nothing to ${verb.toLowerCase()}.`}
          </p>
          {mode === "delete" && (
            <p className="muted small">
              Delete archives each record: it leaves lists, pickers and routing, and stays in reports, invoices and
              history. All of them are one change, so one Undo brings them back.
            </p>
          )}
          {warned.length > 0 && (
            <ul className="dep-list bulk-del" aria-label="Warnings">
              {warned.slice(0, LISTED).map((x) => (
                <li key={x.id}>
                  <Icon name="alert" size={14} />
                  <span className="strong">{x.name}</span>
                  <span className="muted small">{x.warnings.join(" · ")}</span>
                </li>
              ))}
              {warned.length > LISTED && <li className="muted small">and {n(warned.length - LISTED)} more</li>}
            </ul>
          )}
          {blocked.length > 0 && (
            <>
              <p className="error-text">
                {what(blocked.length, noun, plural)} cannot be {mode === "delete" ? "deleted" : "restored"} and{" "}
                {blocked.length === 1 ? "is" : "are"} skipped:
              </p>
              <ul className="dep-list bulk-del" aria-label="Skipped">
                {blocked.slice(0, LISTED).map((x) => (
                  <li key={x.id} className="blocking">
                    <Icon name="alert" size={14} />
                    <span className="strong">{x.name}</span>
                    <span className="muted small">{x.reason}</span>
                  </li>
                ))}
                {blocked.length > LISTED && <li className="muted small">and {n(blocked.length - LISTED)} more</li>}
              </ul>
            </>
          )}
          {mode === "delete" && overridable > 0 && !admin && (
            <p className="muted small">Only an administrator can override the blockers.</p>
          )}
          {mode === "delete" && overridable > 0 && admin && (
            <>
              <label className="toggle-inline">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                Override the blockers of {what(overridable, noun, plural)}
              </label>
              <label className="field" style={{ marginTop: 10 }}>
                <span>
                  Reason{override && <span className="req">*</span>}
                </span>
                <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function SummaryDialog({
  result,
  mode,
  noun,
  plural,
  done,
}: {
  result: BulkRecordsResult;
  mode: BulkMode;
  noun: string;
  plural: string;
  done: () => void;
}) {
  const verb = mode === "delete" ? "Deleted" : "Restored";
  return (
    <Modal
      title={`${verb} ${what(result.done.length, noun, plural)}`}
      width={560}
      onClose={done}
      footer={
        <Button variant="primary" onClick={done}>
          OK
        </Button>
      }
    >
      <p>
        {result.done.length ? `${verb} ${what(result.done.length, noun, plural)}` : `Nothing was ${verb.toLowerCase()}`}
        {result.change ? ` as change #${result.change.id}; Undo brings ${result.done.length === 1 ? "it" : "them all"} back.` : "."}
      </p>
      <p className="error-text">
        {what(result.refused.length, noun, plural)} {result.refused.length === 1 ? "was" : "were"} not{" "}
        {mode === "delete" ? "deleted" : "restored"}:
      </p>
      <ul className="dep-list bulk-del">
        {result.refused.slice(0, 50).map((x) => (
          <li key={x.id} className="blocking">
            <Icon name="alert" size={14} />
            <span className="strong">{x.name}</span>
            <span className="muted small">{x.reason}</span>
          </li>
        ))}
        {result.refused.length > 50 && <li className="muted small">and {n(result.refused.length - 50)} more</li>}
      </ul>
    </Modal>
  );
}

/**
 * Deletes or restores the given records of a list after the confirmations; resolves with how many were changed.
 * Delete asks twice (the selection with its warnings, then "Are you sure?"); restore asks once.
 */
export function useBulkArchive() {
  const notifySaved = useNotifySaved();
  const refresh = useRefreshRecords();
  return async (list: ListId, mode: BulkMode, ids: number[], noun: string, plural = `${noun}s`): Promise<number> => {
    if (!ids.length) return 0;
    const choice = await ask<Choice>((resolve) => (
      <FirstDialog list={list} mode={mode} ids={ids} noun={noun} plural={plural} done={resolve} />
    ));
    if (!choice) return 0;
    if (
      mode === "delete" &&
      !(await confirmDialog({
        title: `Delete ${what(choice.count, noun, plural)}`,
        message: secondConfirmText(choice.count, noun, plural),
        ok: `Delete ${n(choice.count)}`,
        danger: true,
      }))
    )
      return 0;
    try {
      const result = await bulkRecords(list, mode, {
        ids,
        dryRun: false,
        ...(choice.reason ? { reason: choice.reason } : {}),
        ...(choice.override ? { override: true } : {}),
      });
      void refresh();
      const verb = mode === "delete" ? "Deleted" : "Restored";
      if (result.change) notifySaved(result.change, `${verb} ${what(result.done.length, noun, plural)}`);
      if (result.refused.length)
        await ask<void>((resolve) => (
          <SummaryDialog result={result} mode={mode} noun={noun} plural={plural} done={() => resolve(null)} />
        ));
      return result.done.length;
    } catch (e) {
      toast({ tone: "error", message: (e as Error).message });
      return 0;
    }
  };
}
