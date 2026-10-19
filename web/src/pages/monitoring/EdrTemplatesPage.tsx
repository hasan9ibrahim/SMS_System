// EDR Template (§9.2, §12.4): saved EDR column sets (Name, Column Selection) used by EDR Search, EDR
// Download and Trouble Ticket. Saves are undoable (§13.10); delete archives (§13.29).
import { useState } from "react";
import type { EdrTemplateRow } from "@sms/contract";
import { useListFields, useMe } from "../../api/hooks";
import { useSaveEdrTemplate } from "../../api/observation";
import { useRestore } from "../../api/records";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { problemText } from "../routing/dialogs";
import { fmtWhen, RecordActions, RecordDialog } from "../reference/shared";

const page = pageForPath("/monitoring/edr-templates")!;

function TemplateDialog({ row, done }: { row: EdrTemplateRow | null; done: () => void }) {
  const fields = useListFields("edrs");
  const [name, setName] = useState(row?.name ?? "");
  const [columns, setColumns] = useState<string[]>(
    row?.columns ?? ["startTime", "customerTrunk", "senderId", "dnid", "msgStatus"],
  );
  const [error, setError] = useState<string | null>(null);
  const save = useSaveEdrTemplate();
  const notifySaved = useNotifySaved();
  const label = new Map((fields.data?.fields ?? []).map((f) => [f.field, f.label]));
  const move = (i: number, d: -1 | 1) => {
    const next = [...columns];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setColumns(next);
  };
  return (
    <RecordDialog
      title={row ? `Edit EDR template ${row.name}` : "Add EDR template"}
      saveLabel={row ? "Save" : "Add template"}
      saving={save.isPending}
      error={error}
      width={760}
      onClose={done}
      onSave={() =>
        save.mutate(
          { id: row?.id ?? null, input: { name, columns } },
          {
            onSuccess: (r) => {
              if (r.change) notifySaved(r.change, `Saved EDR template ${r.record.name}`);
              done();
            },
            onError: (e) => setError(e instanceof Error ? e.message : String(e)),
          },
        )
      }
    >
      <label className="field wide">
        <span>Name *</span>
        <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field wide">
        <span>Column Selection * ({columns.length}) · in order</span>
        <div className="template-cols">
          <ol className="template-order">
            {columns.map((c, i) => (
              <li key={c}>
                <span>{label.get(c) ?? c}</span>
                <button
                  type="button"
                  className="link small"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="link small"
                  disabled={i === columns.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="link small"
                  onClick={() => setColumns(columns.filter((x) => x !== c))}
                  aria-label="Remove"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
          <div className="column-checks">
            {(fields.data?.fields ?? []).map((f) => (
              <label key={f.field} className="toggle-inline small">
                <input
                  type="checkbox"
                  checked={columns.includes(f.field)}
                  onChange={(e) =>
                    setColumns(e.target.checked ? [...columns, f.field] : columns.filter((x) => x !== f.field))
                  }
                />
                {f.label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </RecordDialog>
  );
}

const openDialog = (row: EdrTemplateRow | null) => ask<void>((d) => <TemplateDialog row={row} done={() => d()} />);

export function EdrTemplatesPage() {
  const fields = useListFields("edrs");
  const label = new Map((fields.data?.fields ?? []).map((f) => [f.field, f.label]));
  const { data: me } = useMe();
  const deleteOne = useDeleteRecord();
  const restore = useRestore("edr_template");
  const notifySaved = useNotifySaved();
  const isAdmin = isAdminUser(me?.permissions);
  return (
    <ListScreen<EdrTemplateRow>
      list="edr_templates"
      page={page}
      noSelection
      historyScope={{ entityTypes: ["edr_template"] }}
      primary={{ label: "Add", icon: "plus", onClick: () => void openDialog(null) }}
      columns={{
        id: { width: 90 },
        name: { width: 280, render: (r) => <strong>{r.name}</strong> },
        columnCount: { width: 100, align: "right", render: (r) => <span className="num">{r.columns.length}</span> },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? "—" },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
      }}
      rowClass={(r) => (r.archivedAt ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted templates cannot be edited" : undefined,
          onSelect: () => void openDialog(r),
        },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !isAdmin || restore.isPending,
              hint: isAdmin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored EDR template ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("edr_template", r.id, `EDR template ${r.name}`),
            },
      ]}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">{r.columns.length} columns</span>
          </>
        ),
        sections: [
          {
            key: "view",
            label: "Columns",
            actions: (
              <RecordActions
                kind="edr_template"
                id={r.id}
                name={`EDR template ${r.name}`}
                archived={!!r.archivedAt}
                onEdit={() => void openDialog(r)}
              />
            ),
            content: (
              <ol className="template-view">
                {r.columns.map((c) => (
                  <li key={c}>{label.get(c) ?? c}</li>
                ))}
              </ol>
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["edr_template"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
