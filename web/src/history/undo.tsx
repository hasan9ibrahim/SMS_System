// Per-user undo and change history hooks (§13.10), shared by every page that edits records:
//   useUndo()              undo one change; a conflict asks keep current / restore mine / cancel
//   useUndoLast(scope)     the user's last change in a page scope (header Undo button, Ctrl+Z)
//   useUndoShortcut(scope) Ctrl+Z on the page undoes the user's last change
//   notifySaved(change)    the 10-second "Undo" toast right after a save
//   <HistoryDrawer>        a record's or page's History list with Undo per change
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Change, ChangeField, FilterCondition, FilterGroup, ListQuery, UndoConflict } from "@sms/contract";
import { api, ApiError, unwrap } from "../api/client";
import { fetchListPage, useMe } from "../api/hooks";
import { ask, confirmDialog, toast } from "../ui/feedback";
import { Button, Modal } from "../ui/primitives";
import { Icon } from "../ui/Icon";

export interface HistoryScope {
  /** e.g. route_rule, rate_line, translation_rule, customer_trunk */
  entityTypes: string[];
  entityId?: number;
  /** More conditions on the changes list, e.g. numberListId for one number list's entries (QA 2026-10-31, §6.4). */
  conditions?: FilterCondition[];
}

export function scopeFilter(scope: HistoryScope | null, userId?: number): FilterGroup | undefined {
  const conditions: FilterGroup["conditions"] = [];
  if (scope?.entityTypes.length) conditions.push({ field: "entityType", op: "in", values: scope.entityTypes });
  if (scope?.entityId) conditions.push({ field: "entityId", op: "eq", value: scope.entityId });
  if (scope?.conditions) conditions.push(...scope.conditions);
  if (userId) conditions.push({ field: "userId", op: "eq", value: userId });
  return conditions.length ? { logic: "and", conditions } : undefined;
}

/** A rate line snapshot (rate table changes, §13.12) reads as "20801 0.0450 until 2026-10-20". */
function showLine(v: Record<string, unknown>): string {
  const code = `${String(v.mccmnc)}${v.senderId ? `/${String(v.senderId)}` : ""}`;
  const until = v.to ? ` until ${String(v.to).slice(0, 10)}` : "";
  const from = Date.parse(String(v.from)) > Date.now() ? ` from ${String(v.from).slice(0, 10)}` : "";
  return `${code} ${String(v.rate)}${from}${until}${v.blocked ? " blocked" : ""}`;
}

const show = (v: unknown) =>
  v === null || v === undefined
    ? "—"
    : typeof v === "object"
      ? "rate" in (v as object) && "mccmnc" in (v as object)
        ? showLine(v as Record<string, unknown>)
        : JSON.stringify(v)
      : String(v);

export function describeDiff(diff: ChangeField[], max = 3): string {
  const parts = diff
    .slice(0, max)
    .map((d) =>
      d.field === "*"
        ? `#${d.entityId} ${show(d.after ?? d.before)}`
        : `${d.field} ${show(d.before)} → ${show(d.after)}`,
    );
  return parts.join(" · ") + (diff.length > max ? ` · +${diff.length - max} more` : "");
}

function ConflictDialog({
  conflict,
  resolve,
}: {
  conflict: UndoConflict;
  resolve: (r: "restore_mine" | "keep_current" | null) => void;
}) {
  return (
    <Modal
      title="Someone changed the same field since"
      width={560}
      onClose={() => resolve(null)}
      footer={
        <>
          <Button onClick={() => resolve(null)}>Cancel</Button>
          <Button onClick={() => resolve("keep_current")}>Keep current</Button>
          <Button variant="primary" onClick={() => resolve("restore_mine")}>
            Restore mine
          </Button>
        </>
      }
    >
      <p>Undo would overwrite later work. Choose what to keep:</p>
      <ul className="conflicts">
        {conflict.conflicts.map((c, i) => (
          <li key={i}>
            <strong>{c.field}</strong> on #{c.entityId}: you set <code>{show(c.mine)}</code>, {c.changedBy} later set{" "}
            <code>{show(c.current)}</code>{" "}
            <span className="muted small">({c.changedAt.slice(0, 16).replace("T", " ")} UTC)</span>
          </li>
        ))}
      </ul>
      <p className="muted small">
        Keep current undoes only the fields nobody changed since. Restore mine puts your earlier values back everywhere.
      </p>
    </Modal>
  );
}

/** Undo one change. Resolves with the new undo change, or null when cancelled or refused. */
export function useUndo() {
  const qc = useQueryClient();
  const run = useCallback(
    async (changeId: number, quiet = false, change?: Change, confirmed = false): Promise<Change | null> => {
      // Ask first (team trial round 2); Redo (quiet) is the user's own just-made choice.
      if (!quiet && !confirmed) {
        const ok = await confirmDialog({
          title: "Undo this change?",
          message: (
            <>
              <p>
                Change #{changeId}
                {change ? `: ${describeDiff(change.diff, 3)}` : ""}
              </p>
              <p className="muted small">The values go back to what they were before it. You can redo it afterwards.</p>
            </>
          ),
          ok: "Undo",
        });
        if (!ok) return null;
      }
      const call = (body: { resolution?: "restore_mine" | "keep_current" }) =>
        unwrap(api.POST("/changes/{id}/undo", { params: { path: { id: changeId } }, body }));
      try {
        let result: Change;
        try {
          result = await call({});
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 409) throw err;
          const resolution = await ask<"restore_mine" | "keep_current">((resolve) => (
            <ConflictDialog conflict={err.problem as unknown as UndoConflict} resolve={resolve} />
          ));
          if (!resolution) return null;
          result = await call({ resolution });
        }
        // Records and history may both have changed.
        await qc.invalidateQueries({ queryKey: ["record"] });
        await qc.invalidateQueries({ queryKey: ["list"] });
        await qc.invalidateQueries({ queryKey: ["history"] });
        if (!quiet) {
          toast({
            tone: "good",
            message: `Undone #${changeId}: ${describeDiff(result.diff, 2)}`,
            action: { label: "Redo", run: () => void run(result.id, true) },
            timeoutMs: 10_000,
          });
        }
        return result;
      } catch (err) {
        toast({ tone: "error", message: err instanceof ApiError ? err.message : `Undo failed: ${String(err)}` });
        return null;
      }
    },
    [qc],
  );
  return run;
}

/** "Saved" toast with Undo for 10 seconds (§13.10 quick undo). */
export function useNotifySaved() {
  const undo = useUndo();
  return useCallback(
    (change: Change, message = "Saved") =>
      toast({
        tone: "good",
        message: `${message} · change #${change.id}`,
        action: { label: "Undo", run: () => void undo(change.id, false, change) },
        timeoutMs: 10_000,
      }),
    [undo],
  );
}

/** The signed-in user's latest change in a scope that can still be undone. */
export function useUndoLast(scope: HistoryScope | null) {
  const { data: me } = useMe();
  const undo = useUndo();
  const last = useQuery({
    queryKey: ["history", "last", scope, me?.id],
    enabled: !!me && !!scope,
    retry: false,
    queryFn: async () => {
      const filter = scopeFilter(scope, me!.id)!;
      filter.conditions.push({ field: "changeType", op: "not_in", values: ["undo"] });
      const page = await fetchListPage<Change>("changes", { filter, limit: 20, withTotal: false } as ListQuery);
      return page.rows.find((c) => c.undoneById === null) ?? null;
    },
  });
  const undoLast = useCallback(async () => {
    const change = last.data ?? (await last.refetch()).data;
    if (!change) {
      toast({ tone: "info", message: "Nothing of yours to undo here." });
      return;
    }
    await undo(change.id, false, change);
  }, [last, undo]);
  return { last: last.data ?? null, undoLast };
}

/** Ctrl+Z (Cmd+Z) on the active page undoes the user's last change in its scope. */
export function useUndoShortcut(scope: HistoryScope | null, active: boolean) {
  const { undoLast } = useUndoLast(scope);
  useEffect(() => {
    if (!active || !scope) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      void undoLast();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, scope, undoLast]);
}

const VERB: Record<string, string> = {
  create: "Created",
  edit: "Edited",
  clone: "Cloned",
  delete: "Deleted",
  reorder: "Reordered",
  enable: "Turned on",
  disable: "Turned off",
  bulk: "Bulk edit",
  undo: "Undo",
  import: "Imported",
  cleanup: "Cleanup",
};

/** "Today", "Yesterday" or "Wed 28 Oct 2026" (UTC, like the times). */
export function dayLabel(at: string, now = new Date()): string {
  const day = at.slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** One field of a change: a list field's +added / −removed / ~changed lines, or before → after. */
function FieldValue({ d }: { d: ChangeField }) {
  if (d.added?.length || d.removed?.length || d.changed?.length)
    return (
      <ul className="change-items">
        {d.added?.map((x, i) => (
          <li key={`a${i}`}>
            <span className="tone-good">+</span> {x}
          </li>
        ))}
        {d.changed?.map((x, i) => (
          <li key={`c${i}`}>
            <span className="muted">~</span> {x}
          </li>
        ))}
        {d.removed?.map((x, i) => (
          <li key={`r${i}`}>
            <span className="tone-error">−</span> {x}
          </li>
        ))}
      </ul>
    );
  const before = d.beforeText ?? show(d.before);
  const after = d.afterText ?? show(d.after);
  // A whole record created or deleted: just what it holds.
  if (d.field === "*") return <>{after !== "—" ? after : before}</>;
  return (
    <>
      <span className="change-before">{before}</span>
      <span className="change-arrow" aria-label="changed to">
        →
      </span>
      <span>{after}</span>
    </>
  );
}

/** Fields shown before "Show all": enough for a normal save. */
const FIELDS_SHOWN = 6;

export function ChangeEntry({ change, onUndo }: { change: Change; onUndo: (c: Change) => void }) {
  // The server decides: own changes, or someone else's for an administrator, a director or their department's
  // manager (team trial round 12, §13.10).
  const undoable = change.canUndo ?? change.undoneById === null;
  const [all, setAll] = useState(false);
  const fields = all ? change.diff : change.diff.slice(0, FIELDS_SHOWN);
  const many = change.entityIds.length > 1;
  return (
    <li className={`change${change.undoneById ? " undone" : ""}`}>
      <div className="change-head">
        <span className="change-time num" title={`${change.at.slice(0, 19).replace("T", " ")} UTC`}>
          {change.at.slice(11, 16)}
        </span>
        <strong className="change-who">{change.userName}</strong>
        <span className={`tag${change.changeType === "undo" ? " tag-accent" : ""}`}>
          {VERB[change.changeType] ?? change.changeType}
        </span>
        {many && <span className="muted small">{change.entityIds.length.toLocaleString("en-US")} records</span>}
        <span className="fb-spacer" />
        <span className="muted small num">#{change.id}</span>
        {change.undoneById ? (
          <span className="muted small">undone by #{change.undoneById}</span>
        ) : (
          undoable && (
            <Button small icon="undo" onClick={() => onUndo(change)}>
              Undo
            </Button>
          )
        )}
      </div>
      {change.diff.length && change.diff.some((d) => d.label) ? (
        <dl className="change-fields">
          {fields.map((d, i) => (
            <Fragment key={i}>
              <dt>{d.label ?? (d.field === "*" ? "Whole record" : d.field)}</dt>
              <dd>
                <FieldValue d={d} />
              </dd>
            </Fragment>
          ))}
          {change.diff.length > FIELDS_SHOWN && (
            <dd className="change-more">
              <button type="button" className="link-btn small" onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer" : `Show all ${change.diff.length} fields`}
              </button>
            </dd>
          )}
        </dl>
      ) : (
        <div className="change-diff">{change.summary ?? describeDiff(change.diff, 4)}</div>
      )}
      {change.note && <div className="change-note muted small">“{change.note}”</div>}
    </li>
  );
}

/** The History list of a record or page scope, newest first, with Undo per change. */
export function HistoryList({ scope }: { scope: HistoryScope }) {
  const undo = useUndo();
  const filter = scopeFilter(scope);
  const history = useInfiniteQuery({
    queryKey: ["history", "list", scope],
    queryFn: ({ pageParam }) =>
      fetchListPage<Change>("changes", { ...(filter ? { filter } : {}), limit: 50, cursor: pageParam } as ListQuery),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
    retry: false,
  });
  const rows = history.data?.pages.flatMap((p) => p.rows) ?? [];
  return (
    <>
      {history.isError && <p className="error-text pad">{String((history.error as Error).message)}</p>}
      <ul className="change-list">
        {rows.map((c, i) => {
          // Changes grouped by day, newest first (team trial round 12).
          const day = dayLabel(c.at);
          return (
            <Fragment key={c.id}>
              {(i === 0 || dayLabel(rows[i - 1]!.at) !== day) && <li className="change-day">{day}</li>}
              <ChangeEntry change={c} onUndo={(ch) => void undo(ch.id, false, ch)} />
            </Fragment>
          );
        })}
      </ul>
      {history.hasNextPage && (
        <div className="pad">
          <Button small onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            Load older changes
          </Button>
        </div>
      )}
      {!history.isPending && rows.length === 0 && !history.isError && (
        <p className="muted pad">No changes recorded yet.</p>
      )}
    </>
  );
}

/** Side drawer with the History list of a record or page scope. */
export function HistoryDrawer({ scope, title, onClose }: { scope: HistoryScope; title: string; onClose: () => void }) {
  const backdrop = useRef<HTMLDivElement>(null);
  // Escape closes it like a dialog (functional QA round 13): only the drawer of the tab in view (a hidden tab's has
  // no layout box), and not while a dialog opened from it (an undo question) is on top.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !backdrop.current?.getClientRects().length) return;
      if ([...document.querySelectorAll(".modal-backdrop")].some((m) => m.getClientRects().length)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div ref={backdrop} className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label={`History: ${title}`}>
        <div className="drawer-head">
          <Icon name="history" />
          <h2>History · {title}</h2>
          <span className="fb-spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <HistoryList scope={scope} />
      </aside>
    </div>
  );
}
