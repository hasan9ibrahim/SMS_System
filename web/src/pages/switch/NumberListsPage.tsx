// Number lists (§6.4, §12.4): Random, Tag and Sender ID Template lists used by translation and
// route rules. The list grid opens one list's entries in the same tab (?list=<id>): a
// server-side grid with add (one per line, pasted), bulk delete, Import List (dry run first)
// and export. Delete is blocked while rules use a list (§13.29); every save is one undoable
// change (§13.10).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import type { ListQuery, NumberList, NumberListEntry, NumberListInput } from "@sms/contract";
import { fetchListPage, useMe } from "../../api/hooks";
import { downloadCsv } from "../../api/masterData";
import { useAddEntries, useDeleteEntries, useSaveNumberList } from "../../api/switchRules";
import { FormField, SelectField, TextField, useForm } from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useRestore } from "../../api/records";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { HoverList } from "../../ui/HoverList";
import { Button } from "../../ui/primitives";
import { fmtWhen, openImport, RecordActions, RecordDialog } from "../reference/shared";
import { problemText } from "../routing/dialogs";
import { LIST_TYPE_HINT, LIST_TYPES, listTypeLabel, splitTemplates, splitValues } from "./switchModel";

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
        hint={LIST_TYPE_HINT[form.values.listType]}
      />
    </RecordDialog>
  );
}

function AddEntriesDialog({ list, done }: { list: NumberList; done: () => void }) {
  const [text, setText] = useState("");
  const add = useAddEntries(list.id);
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const template = list.listType === "sender_id_template";
  const pairs = template ? splitTemplates(text) : splitValues(text).map((value) => ({ value, content: null }));
  const values = pairs.map((p) => p.value);
  const submit = () => {
    if (!values.length) return setError("Enter at least one value.");
    add.mutate(template ? { values, contents: pairs.map((p) => p.content) } : { values }, {
      onSuccess: (r) => {
        if (r.errors.length)
          return setError(
            `${r.errors.length} value${r.errors.length === 1 ? "" : "s"} do not fit: ${r.errors
              .slice(0, 3)
              .map((e) => `${e.key} (${e.message})`)
              .join("; ")}`,
          );
        if (r.change)
          notifySaved(r.change, `Added ${r.added} to ${list.name}${r.skipped ? ` · ${r.skipped} already there` : ""}`);
        else toast({ tone: "info", message: `All ${r.skipped} values are already in the list` });
        done();
      },
      onError: (e) => setError(problemText(e)),
    });
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
      <FormField
        label={template ? "Sender ID | content template" : "Values"}
        wide
        hint={
          template
            ? "One per line. {n} = random digit, {code} = code found, {text} = original text"
            : `One per line, or separated by commas. ${LIST_TYPE_HINT[list.listType]}`
        }
      >
        <textarea
          rows={8}
          autoFocus
          value={text}
          placeholder={template ? "OURBRAND | Your OurBrand code is {code}" : undefined}
          onChange={(e) => setText(e.target.value)}
        />
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
  const { data: me } = useMe();
  const restore = useRestore("number_list");
  const notifySaved = useNotifySaved();
  const isAdmin = isAdminUser(me?.permissions);
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
        // Double-click or Enter opens the entries; Edit is the list's name/type dialog (§6.4).
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted list" : undefined,
          onSelect: () => void ask<NumberList>((done) => <NumberListDialog row={r} done={done} />),
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
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored number list ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("number_list", r.id, `number list ${r.name}`),
            },
      ]}
      primary={{ label: "Add list", icon: "plus", onClick: () => void addList() }}
      columns={{
        id: { width: 90 },
        name: { width: 280, render: (r) => <strong>{r.name}</strong> },
        listType: { width: 170, render: (r) => <span className="tag">{listTypeLabel(r.listType)}</span> },
        // Pointing at the count lists the entries / the rules using the list (team trial round 1).
        entries: {
          width: 110,
          align: "right",
          render: (r) => (
            <HoverList items={r.entryValues} more={r.entries - r.entryValues.length} heading="Entries">
              <span className="num">{r.entries}</span>
            </HoverList>
          ),
        },
        usedBy: {
          width: 110,
          align: "right",
          render: (r) =>
            r.usedBy ? (
              <HoverList items={r.usedByNames} more={r.usedBy - r.usedByNames.length} heading="Used by">
                <span className="num">{r.usedBy}</span>
              </HoverList>
            ) : (
              <span className="muted">—</span>
            ),
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
                <dd>{listTypeLabel(r.listType)}</dd>
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
      rowActions={(r) => [
        {
          label: "Delete",
          icon: "trash",
          danger: true,
          disabled: archived,
          hint: archived ? "The list is deleted" : undefined,
          onSelect: () => remove([r.id]),
        },
      ]}
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
                    One value per line, or a CSV with a <code>value</code> (or <code>number</code>) column.
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
      {...(l.listType === "sender_id_template"
        ? { initialState: { visible: ["id", "value", "content", "createdBy", "createdAt"] } }
        : {})}
      columns={{
        id: { width: 100 },
        value: {
          width: 220,
          ...(l.listType === "sender_id_template" ? { label: "Sender ID" } : {}),
          render: (r) => <span className="num strong">{r.value}</span>,
        },
        content: { width: 360, render: (r) => r.content ?? <span className="muted">— (Sender ID only)</span> },
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
