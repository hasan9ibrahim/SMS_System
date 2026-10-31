// Customer and vendor trunk lists (§5.4, §5.5) on the standard grid; a row opens the trunk
// record in its own tab. "Show deleted" lists archived trunks greyed out (§13.29). Clone and delete
// work from the list too, per row (⋯) or on a selection (team trial round 1).
import { HoverList } from "../ui/HoverList";
import { connectionColumn } from "./trunk/connection";
import type { TrunkListRow } from "@sms/contract";
import type { TrunkKind } from "../api/records";
import { pageForPath } from "../nav/registry";
import { ListScreen } from "../page/ListScreen";
import { useMe } from "../api/hooks";
import { useRestore } from "../api/records";
import { useNotifySaved } from "../history/undo";
import { isAdminUser, useBulkDelete, useDeleteRecord } from "../records/parts";
import { useTabNavigate } from "../shell/tabContext";
import { newTabOf, type OpenEvent } from "../shell/useOpener";
import { toast } from "../ui/feedback";
import { problemText } from "./routing/dialogs";

const LABEL = { customer: "Customer trunk", vendor: "Vendor trunk" } as const;

export function TrunksPage({ kind }: { kind: TrunkKind }) {
  const navigate = useTabNavigate();
  const page = pageForPath(`/enterprises/${kind}-trunks`)!;
  const open = (id: number, name: string, e?: OpenEvent) =>
    // In this tab, Back returns to the list (team trial round 12); Ctrl/Cmd-click or the middle button: a new tab.
    navigate(`/enterprises/${kind}-trunks/${id}`, { ...newTabOf(e), title: `${LABEL[kind]} · ${name}` });
  const clone = (id: number, name: string) =>
    navigate(`/enterprises/${kind}-trunks/new?clone=${id}`, {
      newTab: true,
      forceNew: true,
      title: `Clone of ${name}`,
    });
  const deleteOne = useDeleteRecord();
  const deleteMany = useBulkDelete();
  const { data: me } = useMe();
  const restore = useRestore(kind);
  const notifySaved = useNotifySaved();
  const restoreOne = (id: number, name: string) =>
    restore.mutate(id, {
      onSuccess: (r) => r.change && notifySaved(r.change, `Restored ${name}`),
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  return (
    <ListScreen<TrunkListRow>
      key={kind}
      list={kind === "customer" ? "customer_trunks" : "vendor_trunks"}
      page={page}
      historyScope={{ entityTypes: [`${kind}_trunk`] }}
      primary={{
        label: `New ${LABEL[kind].toLowerCase()}`,
        onClick: () =>
          navigate(`/enterprises/${kind}-trunks/new`, { newTab: true, title: `New ${LABEL[kind].toLowerCase()}` }),
      }}
      rowActions={(r) => [
        // The trunk record tab is its editor (§5.4, §5.5).
        { label: "Edit", icon: "file", main: true, onSelect: () => open(r.id, r.name) },
        { label: "Clone", icon: "copy", disabled: r.archived, onSelect: () => clone(r.id, r.name) },
        "separator",
        r.archived
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !isAdminUser(me?.permissions) || restore.isPending,
              hint: isAdminUser(me?.permissions) ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () => restoreOne(r.id, r.name),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne(kind, r.id, r.name),
            },
      ]}
      selection={{
        bulk: (ids, clear, rows) => [
          {
            label: "Clone…",
            icon: "copy",
            disabled: rows.length !== 1,
            hint: rows.length === 1 ? undefined : "one trunk",
            onSelect: () => clone(rows[0]!.id, rows[0]!.name),
          },
          {
            label: `Delete ${ids.length} trunk${ids.length === 1 ? "" : "s"}…`,
            icon: "trash",
            danger: true,
            disabled: !rows.some((r) => !r.archived),
            onSelect: async () => {
              const live = rows.filter((r) => !r.archived);
              if (await deleteMany(kind, live, LABEL[kind].toLowerCase())) clear();
            },
          },
        ],
      }}
      columns={{
        name: { width: 220, render: (r) => <strong>{r.name}</strong> },
        enterpriseName: { width: 220 },
        connection: connectionColumn,
        // Pointing at the count lists the translation rules running on the trunk (team trial round 1).
        rulesCount: {
          width: 90,
          align: "right",
          render: (r) =>
            r.rulesCount ? (
              <HoverList items={r.ruleNames} more={r.rulesCount - r.ruleNames.length} heading="Rules running">
                <span className="num">{r.rulesCount}</span>
              </HoverList>
            ) : (
              <span className="muted">—</span>
            ),
        },
      }}
      onOpen={(row, e) => open(row.id, row.name, e)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {LABEL[kind]} of {r.enterpriseName}
            </span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "General",
            content: (
              <dl className="kv">
                <dt>Enterprise</dt>
                <dd>
                  <button
                    type="button"
                    className="link"
                    onClick={() => navigate(`/enterprises/${r.enterpriseId}`, { newTab: true })}
                  >
                    {r.enterpriseName} ({r.enterpriseId})
                  </button>
                </dd>
                <dt>Username</dt>
                <dd>{r.username}</dd>
                <dt>Protocol</dt>
                <dd>{r.protocol.toUpperCase()}</dd>
                <dt>Bind type</dt>
                <dd>{r.bindType}</dd>
                <dt>TPS</dt>
                <dd className="num">{r.tps.toLocaleString("en-US")}</dd>
                <dt>Category</dt>
                <dd>{r.category ?? "—"}</dd>
                <dt>Rules running</dt>
                <dd className="num">{r.rulesCount}</dd>
              </dl>
            ),
          },
        ],
        aside: (
          <dl className="kv">
            <dt>ID</dt>
            <dd className="num">{r.id}</dd>
            <dt>Updated</dt>
            <dd>
              {r.updatedBy ?? "—"} · {r.updatedAt.slice(0, 16).replace("T", " ")} UTC
            </dd>
            {r.archived && (
              <>
                <dt>State</dt>
                <dd className="tone-warning">Deleted (archived)</dd>
              </>
            )}
          </dl>
        ),
      })}
    />
  );
}
