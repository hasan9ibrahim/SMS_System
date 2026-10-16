// Change history (§13.10): every save with who, when and what, and Undo per change.
// "My changes" (?mine=1) is the same page filtered to the signed-in user.
import { useLocation } from "react-router";
import type { Change } from "@sms/contract";
import { useMe } from "../api/hooks";
import { pageForPath } from "../nav/registry";
import { describeDiff, useUndo } from "../history/undo";
import { ListScreen } from "../page/ListScreen";
import { Button } from "../ui/primitives";

const page = pageForPath("/admin/changes")!;
const show = (v: unknown) =>
  v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function ChangeHistoryPage() {
  const { data: me } = useMe();
  const undo = useUndo();
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
        note: { width: 260 },
        userName: { width: 160 },
        changeType: {
          width: 100,
          render: (c) => <span className={`tag${c.changeType === "undo" ? " tag-accent" : ""}`}>{c.changeType}</span>,
        },
        entityId: {
          width: 150,
          render: (c) =>
            c.entityIds.length > 3
              ? `${c.entityIds.slice(0, 3).join(", ")} +${c.entityIds.length - 3}`
              : c.entityIds.join(", "),
        },
      }}
      trailing={{
        header: "",
        width: 200,
        render: (c) =>
          c.undoneById ? (
            <span className="muted small">undone by #{c.undoneById}</span>
          ) : undoable(c) ? (
            <Button small icon="undo" onClick={() => void undo(c.id)}>
              Undo
            </Button>
          ) : (
            <span className="muted small" title="Diff">
              {describeDiff(c.diff, 1)}
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
                      <td className="num">#{d.entityId}</td>
                      <td>{d.field === "*" ? "whole record" : d.field}</td>
                      <td>{show(d.before)}</td>
                      <td>{show(d.after)}</td>
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
                <dd>{c.entityType}</dd>
                <dt>Records</dt>
                <dd>{c.entityIds.join(", ")}</dd>
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
