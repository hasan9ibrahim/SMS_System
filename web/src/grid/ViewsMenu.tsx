// Saved views (§13.25, decided 2026-10-16): private to the owner, optionally shared
// read-only with chosen colleagues. A view restores filters, quick search, sort and columns.
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ListId, SavedView, UserSummary, ViewState } from "@sms/contract";
import { fetchListPage, useDeleteView, useMe, useSaveView, useViews } from "../api/hooks";
import { ApiError } from "../api/client";
import { confirmDialog, toast } from "../ui/feedback";
import { Icon } from "../ui/Icon";
import { Button, Modal, Popover } from "../ui/primitives";
import { buildFilter, type GridState } from "./filterModel";

export function toViewState(state: GridState): ViewState {
  const filter = buildFilter(state);
  return {
    ...(filter ? { filter } : {}),
    ...(state.search ? { search: state.search } : {}),
    ...(state.sort.length ? { sort: state.sort } : {}),
    ...(state.visible ? { columns: state.visible } : {}),
  };
}

/** Restores a view: top-level single conditions go back under their columns, the rest into the builder. */
export function fromViewState(view: SavedView): GridState {
  const columns: GridState["columns"] = {};
  const rest: NonNullable<ViewState["filter"]>["conditions"] = [];
  const f = view.state.filter;
  if (f) {
    for (const node of f.conditions) {
      if (f.logic === "and" && !("logic" in node) && !columns[node.field]) columns[node.field] = node;
      else rest.push(node);
    }
  }
  // A saved builder group under AND is one element; unwrap it so it edits naturally.
  const builder =
    rest.length === 0
      ? null
      : rest.length === 1 && "logic" in rest[0]!
        ? rest[0]
        : { logic: f!.logic, conditions: rest };
  return {
    columns,
    builder,
    search: view.state.search ?? "",
    sort: view.state.sort ?? [],
    visible: view.state.columns ?? null,
    viewId: view.id,
  };
}

function UserPicker({ value, onChange }: { value: number[]; onChange: (ids: number[]) => void }) {
  const [q, setQ] = useState("");
  const { data: me } = useMe();
  const users = useQuery({
    queryKey: ["user-picker", q],
    queryFn: () =>
      fetchListPage<UserSummary>("users", { search: q || undefined, limit: 30, withTotal: false } as never),
    retry: false,
  });
  const [names, setNames] = useState<Record<number, string>>({});
  return (
    <div className="user-picker">
      <div className="chips">
        {value.map((id) => (
          <span key={id} className="chip">
            {names[id] ?? `User #${id}`}
            <button type="button" aria-label="Remove" onClick={() => onChange(value.filter((v) => v !== id))}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        {value.length === 0 && <span className="muted small">Private: only you see this view.</span>}
      </div>
      <input
        placeholder="Find a colleague by name or username…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Find a colleague"
      />
      <div className="user-list">
        {users.data?.rows
          .filter((u) => u.id !== me?.id && u.status === "active")
          .map((u) => (
            <label key={u.id} className="choice-row">
              <input
                type="checkbox"
                checked={value.includes(u.id)}
                onChange={(e) => {
                  setNames((n) => ({ ...n, [u.id]: u.displayName }));
                  onChange(e.target.checked ? [...value, u.id] : value.filter((v) => v !== u.id));
                }}
              />
              <span>{u.displayName}</span>
              <span className="muted small">
                {u.username}
                {u.department ? ` · ${u.department}` : ""}
              </span>
            </label>
          ))}
        {users.isError && <p className="muted small">Users could not be loaded.</p>}
      </div>
    </div>
  );
}

function SaveViewDialog({
  list,
  state,
  existing,
  onSaved,
  onClose,
}: {
  list: ListId;
  state: GridState;
  existing: SavedView | null;
  onSaved: (v: SavedView) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [shared, setShared] = useState<number[]>(existing?.sharedWithUserIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveView(list);
  const submit = () => {
    if (!name.trim()) return setError("Give the view a name.");
    save.mutate(
      {
        ...(existing ? { id: existing.id } : {}),
        input: { list, name: name.trim(), sharedWithUserIds: shared, state: toViewState(state) },
      },
      {
        onSuccess: (v) => {
          toast({
            tone: "good",
            message: `View "${v.name}" saved${v.sharedWithUserIds.length ? `, shared with ${v.sharedWithUserIds.length}` : ""}`,
          });
          onSaved(v);
          onClose();
        },
        onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
      },
    );
  };
  return (
    <Modal
      title={existing ? `Save changes to "${existing.name}"` : "Save as view"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            Save view
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input
          autoFocus
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <div className="field">
        <span>Share read-only with</span>
        <UserPicker value={shared} onChange={setShared} />
      </div>
      <p className="muted small">The view keeps the current filters, quick search, sort and columns.</p>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

export function ViewsMenu({
  list,
  state,
  onApply,
}: {
  list: ListId;
  state: GridState;
  onApply: (s: GridState) => void;
}) {
  const views = useViews(list);
  const remove = useDeleteView(list);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"new" | "update" | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const current = views.data?.find((v) => v.id === state.viewId) ?? null;
  const own = views.data?.filter((v) => !v.readOnly) ?? [];
  const shared = views.data?.filter((v) => v.readOnly) ?? [];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
      >
        <Icon name="star" size={13} />
        {current ? current.name : "Views"}
        <Icon name="chevronDown" size={11} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="views-pop">
        <div className="menu">
          {views.isError && <p className="muted small pad">Views need the mock server and database.</p>}
          {own.length > 0 && <div className="menu-label">My views</div>}
          {own.map((v) => (
            <div key={v.id} className="menu-item-row">
              <button
                type="button"
                className={`menu-item${v.id === state.viewId ? " on" : ""}`}
                onClick={() => {
                  setOpen(false);
                  onApply(fromViewState(v));
                }}
              >
                <Icon name={v.id === state.viewId ? "check" : "star"} size={13} />
                <span>{v.name}</span>
                {v.sharedWithUserIds.length > 0 && (
                  <span className="muted small">shared · {v.sharedWithUserIds.length}</span>
                )}
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Delete view ${v.name}`}
                onClick={async () => {
                  setOpen(false);
                  if (
                    await confirmDialog({
                      title: "Delete view?",
                      message: `"${v.name}" will be deleted for you and everyone you shared it with.`,
                      ok: "Delete",
                      danger: true,
                    })
                  ) {
                    remove.mutate(v.id);
                    if (state.viewId === v.id) onApply({ ...state, viewId: null });
                  }
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
          {shared.length > 0 && <div className="menu-label">Shared with me (read-only)</div>}
          {shared.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`menu-item${v.id === state.viewId ? " on" : ""}`}
              onClick={() => {
                setOpen(false);
                onApply(fromViewState(v));
              }}
            >
              <Icon name="eye" size={13} />
              <span>{v.name}</span>
              <span className="muted small">{v.owner.displayName}</span>
            </button>
          ))}
          {(own.length > 0 || shared.length > 0) && <div className="menu-sep" />}
          {current && !current.readOnly && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                setDialog("update");
              }}
            >
              <Icon name="save" size={13} />
              <span>Save changes to "{current.name}"</span>
            </button>
          )}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              setDialog("new");
            }}
          >
            <Icon name="plus" size={13} />
            <span>Save as new view…</span>
          </button>
        </div>
      </Popover>
      {dialog && (
        <SaveViewDialog
          list={list}
          state={state}
          existing={dialog === "update" ? current : null}
          onSaved={(v) => onApply({ ...state, viewId: v.id })}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

export function SaveViewButton({
  list,
  state,
  onSaved,
}: {
  list: ListId;
  state: GridState;
  onSaved: (s: GridState) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        <Icon name="star" size={13} /> Save as view
      </button>
      {open && (
        <SaveViewDialog
          list={list}
          state={state}
          existing={null}
          onSaved={(v) => onSaved({ ...state, viewId: v.id })}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
