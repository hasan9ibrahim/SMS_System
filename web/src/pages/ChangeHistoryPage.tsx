// Change history (§13.10): every save with who, when and what, and Undo per change. "What changed"
// reads as a sentence with record names, and Fields shows labels, names for ids and what a list gained
// or lost (team trial round 1).
// "My changes" (?mine=1) is the same page filtered to the signed-in user.
import { useLocation } from "react-router";
import type { Change } from "@sms/contract";
import { useListFields, useMe } from "../api/hooks";
import { pageForPath } from "../nav/registry";
import { describeDiff, useUndo } from "../history/undo";
import { ListScreen } from "../page/ListScreen";
import { Button } from "../ui/primitives";

const page = pageForPath("/admin/changes")!;
const show = (v: unknown) =>
  v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);

/** "NG MTN (#7)" when the record's name is known (team trial round 1), else "#7". */
function recordName(c: Change, id: number): string {
  const i = c.entityIds.indexOf(id);
  const name = i >= 0 ? c.entityNames?.[i] : undefined;
  return name && c.entityNames!.length === Math.min(c.entityIds.length, 20) ? `${name} (#${id})` : `#${id}`;
}

export function ChangeHistoryPage() {
  const { data: me } = useMe();
  const undo = useUndo();
  // Record type labels from the field catalogue ("Reconciliation rule", not recon_rule).
  const fields = useListFields("changes");
  const typeLabel = (t: string) =>
    fields.data?.fields.find((f) => f.field === "entityType")?.enumValues?.find((v) => v.value === t)?.label ?? t;
  const mine = new URLSearchParams(useLocation().search).get("mine") === "1";
  const canUndoOthers = !!me && (me.permissions.includes("*") || me.permissions.includes("undo_others"));
  const undoable = (c: Change) =>
    c.undoneById === null && c.changeType !== "undo" && (c.userId === me?.id || canUndoOthers);
  return (
    <ListScreen<Change>
      key={`${mine ? "mine" : "all"}-${me?.id ?? 0}`}
      list="changes"
      page={page}
      title={mine ? "My changes" : "Change history"}
      initialState={mine && me ? { columns: { userId: { field: "userId", op: "eq", value: me.id } } } : {}}
      columns={{
        id: { width: 90, render: (c) => <span className="num">#{c.id}</span> },
        at: { width: 150 },
        note: { width: 200 },
        userName: { width: 160 },
        changeType: {
          width: 100,
          render: (c) => <span className={`tag${c.changeType === "undo" ? " tag-accent" : ""}`}>{c.changeType}</span>,
        },
        entityType: { width: 190 },
        entityId: {
          width: 110,
          render: (c) =>
            c.entityIds.length > 3
              ? `${c.entityIds.slice(0, 3).join(", ")} +${c.entityIds.length - 3}`
              : c.entityIds.join(", "),
        },
      }}
      trailing={{
        header: "What changed",
        width: 440,
        render: (c) => (
          <span className="ch-what">
            <span className="ch-summary" title={c.summary ?? describeDiff(c.diff, 6)}>
              {c.summary ?? describeDiff(c.diff, 1)}
            </span>
            {c.undoneById ? (
              <span className="muted small">undone by #{c.undoneById}</span>
            ) : (
              undoable(c) && (
                <Button small icon="undo" onClick={() => void undo(c.id)}>
                  Undo
                </Button>
              )
            )}
          </span>
        ),
      }}
      detail={(c) => ({
        title: (
          <>
            <strong>Change #{c.id}</strong>
            <span className="muted">
              {c.changeType} by {c.userName} · {c.at.slice(0, 19).replace("T", " ")} UTC
            </span>
          </>
        ),
        sections: [
          ...(c.summary
            ? [{ key: "summary", label: "Summary", content: <p className="ch-summary-full">{c.summary}</p> }]
            : []),
          {
            key: "diff",
            label: "Fields",
            content: (
              <table className="diff-table">
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Field</th>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  {c.diff.map((d, i) => (
                    <tr key={i}>
                      <td>{recordName(c, d.entityId)}</td>
                      <td>{d.label ?? (d.field === "*" ? "whole record" : d.field)}</td>
                      <td>{d.beforeText ?? show(d.before)}</td>
                      <td>
                        {d.afterText ?? show(d.after)}
                        {d.added?.length || d.removed?.length ? (
                          <div className="ch-delta small">
                            {d.added?.map((x, j) => (
                              <div key={`a${j}`} className="tone-success">
                                + {x}
                              </div>
                            ))}
                            {d.removed?.map((x, j) => (
                              <div key={`r${j}`} className="tone-error">
                                − {x}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ),
          },
          {
            key: "about",
            label: "About",
            content: (
              <dl className="kv">
                <dt>Record type</dt>
                <dd>{typeLabel(c.entityType)}</dd>
                <dt>Records</dt>
                <dd>
                  {c.entityIds
                    .slice(0, 20)
                    .map((id) => recordName(c, id))
                    .join(", ")}
                  {c.entityIds.length > 20 ? ` +${c.entityIds.length - 20} more` : ""}
                </dd>
                <dt>Note</dt>
                <dd>{c.note ?? "—"}</dd>
                <dt>IP</dt>
                <dd>{c.ip ?? "—"}</dd>
                {c.undoOfId && (
                  <>
                    <dt>Undo of</dt>
                    <dd>#{c.undoOfId}</dd>
                  </>
                )}
              </dl>
            ),
          },
        ],
        aside: undoable(c) ? (
          <Button icon="undo" onClick={() => void undo(c.id)}>
            Undo this change
          </Button>
        ) : undefined,
      })}
      shortcuts="↑↓ move · Space select · Undo restores only the fields that change touched"
    />
  );
}
