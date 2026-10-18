// Number lists (§6.4, §12.4): Random, Tag and Sender ID Template lists used by translation and
// route rules. The list grid opens one list's entries in the same tab (?list=<id>): a
// server-side grid with add (one per line, pasted), bulk delete, Import List (dry run first)
// and export. Delete is blocked while rules use a list (§13.29); every save is one undoable
// change (§13.10).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import type { ListQuery, NumberList, NumberListEntry, NumberListInput } from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import { downloadCsv } from "../../api/masterData";
import { useAddEntries, useDeleteEntries, useSaveNumberList } from "../../api/switchRules";
import { FormField, SelectField, TextField, useForm } from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useDeleteRecord } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { fmtWhen, openImport, RecordActions, RecordDialog } from "../reference/shared";
import { problemText } from "../routing/dialogs";
import { LIST_TYPES, listTypeHint, listTypeLabel, splitValues } from "./switchModel";

const page = pageForPath("/switch/number-lists")!;

// ---------------------------------------------------------------- dialogs

/** Add or edit a list; resolves with the saved list (used by "+ New list" in rule forms, §13.2). */
export function NumberListDialog({
  row,
  fixedType,
  done,
}: {
  row: NumberList | null;
  fixedType?: NumberList["listType"];
  done: (saved: NumberList | null) => void;
}) {
  const form = useForm<NumberListInput>({ name: row?.name ?? "", listType: row?.listType ?? fixedType ?? "tag" });
  const save = useSaveNumberList();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    save.mutate(
      { id: row?.id ?? null, input: { ...form.values, name: form.values.name.trim() } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, row ? `Saved ${r.record.name}` : `Added number list ${r.record.name}`);
          done(r.record);
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  return (
    <RecordDialog
      title={row ? `Edit ${row.name}` : "Add number list"}
      saveLabel={row ? "Save" : "Add list"}
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={() => done(null)}
      width={520}
    >
      <TextField form={form} path="name" label="Name" required wide maxLength={100} nullable={false} />
      <SelectField
        form={form}
        path="listType"
        label="Type"
        required
        wide
        disabled={!!fixedType}
        options={LIST_TYPES}
        hint={listTypeHint(form.values.listType)}
      />
    </RecordDialog>
  );
}

function AddEntriesDialog({ list, done }: { list: NumberList; done: () => void }) {
  const [text, setText] = useState("");
  const add = useAddEntries(list.id);
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const values = splitValues(text);
  const submit = () => {
    if (!values.length) return setError("Enter at least one value.");
    add.mutate(
      { values },
      {
        onSuccess: (r) => {
          if (r.errors.length)
            return setError(
              `${r.errors.length} value${r.errors.length === 1 ? "" : "s"} do not fit: ${r.errors
                .slice(0, 3)
                .map((e) => `${e.key} (${e.message})`)
                .join("; ")}`,
            );
          if (r.change)
            notifySaved(
              r.change,
              `Added ${r.added} to ${list.name}${r.skipped ? ` · ${r.skipped} already there` : ""}`,
            );
          else toast({ tone: "info", message: `All ${r.skipped} values are already in the list` });
          done();
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  };
  return (
    <RecordDialog
      title={`Add to ${list.name}`}
      saveLabel={`Add ${values.length || ""}`.trim()}
      saving={add.isPending}
      error={error}
      onSave={submit}
      onClose={done}
      width={520}
    >
      <FormField label="Values" wide hint={`One per line, or separated by commas. ${listTypeHint(list.listType)}`}>
        <textarea rows={8} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      </FormField>
    </RecordDialog>
  );
}

// ---------------------------------------------------------------- pages

function useListParam(): [number | null, (id: number | null) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const raw = new URLSearchParams(location.search).get("list");
  return [
    raw ? Number(raw) : null,
    (id) => navigate(id === null ? "/switch/number-lists" : `/switch/number-lists?list=${id}`, { replace: false }),
  ];
}

export function NumberListsPage() {
  const [listId, open] = useListParam();
  return listId === null ? <Lists open={open} /> : <Entries id={listId} back={() => open(null)} />;
}

function Lists({ open }: { open: (id: number) => void }) {
  const deleteOne = useDeleteRecord();
  const addList = async () => {
    const saved = await ask<NumberList>((done) => <NumberListDialog row={null} done={done} />);
    if (saved) open(saved.id);
  };
  return (
    <ListScreen<NumberList>
      list="number_lists"
      page={page}
      historyScope={{ entityTypes: ["number_list", "number_list_entry"] }}
      rowActions={(r) => [
        { label: "Open entries", icon: "list", disabled: !!r.archivedAt, onSelect: () => open(r.id) },
        "separator",
        {
          label: "Delete…",
          icon: "trash",
          danger: true,
          disabled: !!r.archivedAt,
          onSelect: () => void deleteOne("number_list", r.id, r.name),
        },
      ]}
      primary={{ label: "Add list", icon: "plus", onClick: () => void addList() }}
      columns={{
        id: { width: 90 },
        name: { width: 280, render: (r) => <strong>{r.name}</strong> },
        listType: { width: 170, render: (r) => <span className="tag">{listTypeLabel(r.listType)}</span> },
        entries: { width: 110, align: "right" },
        usedBy: {
          width: 110,
          align: "right",
          render: (r) => (r.usedBy ? <span className="num">{r.usedBy}</span> : <span className="muted">—</span>),
        },
        updatedBy: { width: 150, render: (r) => r.updatedBy ?? <span className="muted">—</span> },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
      }}
      onOpen={(r) => !r.archivedAt && open(r.id)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {listTypeLabel(r.listType)} · {r.entries.toLocaleString("en-US")} entries
            </span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "List",
            actions: (
              <>
                {!r.archivedAt && (
                  <Button small icon="list" onClick={() => open(r.id)}>
                    Open entries
                  </Button>
                )}
                <RecordActions
                  kind="number_list"
                  id={r.id}
                  name={`number list ${r.name}`}
                  archived={!!r.archivedAt}
                  onEdit={() => void ask<NumberList>((done) => <NumberListDialog row={r} done={done} />)}
                />
              </>
            ),
            content: (
              <dl className="kv">
                <dt>Type</dt>
                <dd>{listTypeHint(r.listType)}</dd>
                <dt>Used by</dt>
                <dd>
                  {r.usedBy
                    ? `${r.usedBy} live rule${r.usedBy === 1 ? "" : "s"} (translation and route rules): delete is blocked`
                    : "No rule uses it"}
                </dd>
                <dt>Updated</dt>
                <dd>
                  {r.updatedBy ?? "seed data"} · {fmtWhen(r.updatedAt)}
                </dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter opens the entries · Ctrl+Z undo"
    />
  );
}

function Entries({ id, back }: { id: number; back: () => void }) {
  const list = useQuery({
    queryKey: ["list", "number_lists", "one", id],
    queryFn: () =>
      fetchListPage<NumberList>("number_lists", {
        filter: {
          logic: "and",
          conditions: [
            { field: "id", op: "eq", value: id },
            { field: "archived", op: "in", values: [true, false] },
          ],
        },
        limit: 1,
        withTotal: false,
      }).then((p) => p.rows[0] ?? null),
  });
  const del = useDeleteEntries(id);
  const delList = useDeleteRecord();
  const notifySaved = useNotifySaved();
  const l = list.data;
  if (list.isPending) return <div className="grid-message muted">Loading…</div>;
  if (!l)
    return (
      <div className="grid-message">
        Number list {id} not found.{" "}
        <button type="button" className="link" onClick={back}>
          Back to the lists
        </button>
      </div>
    );
  const archived = !!l.archivedAt;
  const remove = (ids: number[], clear?: () => void) =>
    del.mutate(ids, {
      onSuccess: (r) => {
        if (r.change) notifySaved(r.change, `Deleted ${ids.length} entr${ids.length === 1 ? "y" : "ies"}`);
        clear?.();
      },
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  const withList = (body: ListQuery): ListQuery => ({
    ...body,
    filter: {
      logic: "and",
      conditions: [{ field: "numberListId", op: "eq", value: id }, ...(body.filter ? [body.filter] : [])],
    },
  });
  return (
    <ListScreen<NumberListEntry>
      list="number_list_entries"
      page={page}
      title={`Number list · ${l.name}`}
      historyScope={{ entityTypes: ["number_list_entry"] }}
      queryScope={id}
      fetchPage={(body) => fetchListPage<NumberListEntry>("number_list_entries", withList(body))}
      primary={{
        label: "Add",
        icon: "plus",
        disabled: archived,
        onClick: () => void ask<void>((done) => <AddEntriesDialog list={l} done={() => done()} />),
      }}
      actions={
        <>
          <Button icon="list" onClick={back}>
            All lists
          </Button>
          <span className="tag">{listTypeLabel(l.listType)}</span>
          <Button
            icon="upload"
            disabled={archived}
            onClick={() =>
              void openImport({
                target: { kind: "number_list", listId: l.id },
                title: `Import List · ${l.name}`,
                help: (
                  <p>
                    One value per line, or a CSV with a <code>value</code> (or <code>number</code>) column.{" "}
                    {listTypeHint(l.listType)} Values already in the list are left as they are.
                  </p>
                ),
                replaceHint: `Entries of ${l.name} missing from the file are deleted.`,
              })
            }
          >
            Import List
          </Button>
          {!archived && (
            <Button
              icon="trash"
              onClick={() => void delList("number_list", l.id, `number list ${l.name}`).then((r) => r && back())}
            >
              Delete list
            </Button>
          )}
        </>
      }
      onExport={() =>
        void downloadCsv(`/number-lists/${l.id}/export`).catch((e) => toast({ tone: "error", message: problemText(e) }))
      }
      columns={{
        id: { width: 100 },
        value: { width: 260, render: (r) => <span className="num strong">{r.value}</span> },
        createdBy: { width: 160, render: (r) => r.createdBy ?? <span className="muted">—</span> },
        createdAt: { width: 180, render: (r) => fmtWhen(r.createdAt) },
      }}
      selection={
        archived
          ? undefined
          : {
              summary: (_rows, ids) => `${ids.size} selected`,
              bulk: (ids, clear) => [
                {
                  label: `Delete ${ids.length} entr${ids.length === 1 ? "y" : "ies"}`,
                  icon: "trash",
                  danger: true,
                  onSelect: () => remove(ids, clear),
                },
              ],
            }
      }
      detail={(r) => ({
        title: <strong className="num">{r.value}</strong>,
        sections: [
          {
            key: "general",
            label: "Entry",
            actions: archived ? undefined : (
              <Button small icon="trash" onClick={() => remove([r.id])}>
                Delete
              </Button>
            ),
            content: (
              <dl className="kv">
                <dt>List</dt>
                <dd>{l.name}</dd>
                <dt>Created</dt>
                <dd>
                  {r.createdBy ?? "seed data"} · {fmtWhen(r.createdAt)}
                </dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Space selects · a filter like 4477% finds a range · Ctrl+Z undo"
    />
  );
}
