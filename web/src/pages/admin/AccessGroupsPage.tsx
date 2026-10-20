// GUI Access Group (§11): Info ID, Access Group Name, Status, pages and users. The form is a matrix of
// every menu page against its buttons (View, Add, Edit, Delete, Export, ...): which menus, pages and
// buttons a role sees. Any button needs View. "Every page" grants actions on all pages at once.
// Clone copies the matrix; delete is blocked while users have the group (§13.29).
import { Fragment, useMemo, useState } from "react";
import type { AccessCatalog, AccessGroupInput, AccessGroupRow } from "@sms/contract";
import { useAccessCatalog, useCloneAccessGroup, useSaveAccessGroup } from "../../api/admin";
import { emptyState, encodeState } from "../../grid/filterModel";
import { SelectField, TextField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { useMe } from "../../api/hooks";
import { useRestore } from "../../api/records";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen, RecordActions } from "../reference/shared";
import { allowed, toggleModule, togglePermission, toggleSection, type Permissions } from "./adminModel";
import { Kv, statusCell } from "./parts";

const page = pageForPath("/admin/access-groups")!;

/** The page × action matrix; read-only in the detail panel. */
export function PermissionMatrix({
  catalog,
  value,
  onChange,
}: {
  catalog: AccessCatalog;
  value: Permissions;
  onChange?: (p: Permissions) => void;
}) {
  const [filter, setFilter] = useState("");
  const actions = catalog.actions;
  const all = value["*"] ?? [];
  const bySection = useMemo(
    () =>
      catalog.sections.map((s) => ({
        ...s,
        modules: catalog.modules.filter(
          (m) => m.section === s.key && (!filter || m.label.toLowerCase().includes(filter.toLowerCase())),
        ),
      })),
    [catalog, filter],
  );
  const edit = !!onChange;
  return (
    <div className="perm-matrix">
      <div className="perm-tools">
        {edit && (
          <input
            className="perm-filter"
            placeholder="Find a page…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Find a page"
          />
        )}
        <span className="muted small">
          {all.length
            ? `Every page: ${all.join(", ")}`
            : `${Object.keys(value).filter((k) => k !== "*").length} pages allowed`}
        </span>
      </div>
      <div className="perm-scroll">
        <table>
          <thead>
            <tr>
              <th className="perm-page">Page</th>
              {actions.map((a) => (
                <th key={a.key} title={a.description}>
                  {a.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="perm-all">
              <td className="perm-page">
                <strong>Every page</strong>
              </td>
              {actions.map((a) => (
                <td key={a.key}>
                  <input
                    type="checkbox"
                    aria-label={`Every page: ${a.label}`}
                    checked={all.includes(a.key)}
                    disabled={!edit}
                    onChange={(e) => {
                      const set = new Set(all);
                      if (e.target.checked) set.add(a.key).add("view");
                      else if (a.key === "view") set.clear();
                      else set.delete(a.key);
                      const next = { ...value };
                      const list = actions.map((x) => x.key).filter((k) => set.has(k));
                      if (list.length) next["*"] = list;
                      else delete next["*"];
                      onChange?.(next);
                    }}
                  />
                </td>
              ))}
            </tr>
            {bySection
              .filter((s) => s.modules.length)
              .map((s) => (
                <Fragment key={s.key}>
                  <tr className="perm-section">
                    <td className="perm-page" colSpan={actions.length + 1}>
                      {s.label}
                      {edit && (
                        <>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => onChange?.(toggleSection(value, s.modules, true))}
                          >
                            all
                          </button>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => onChange?.(toggleSection(value, s.modules, false))}
                          >
                            none
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {s.modules.map((m) => {
                    const on = allowed(value, m);
                    const own = new Set(value[m.key] ?? []);
                    return (
                      <tr key={m.key} className={on.size ? "" : "perm-off"}>
                        <td className="perm-page">
                          {edit ? (
                            <label className="toggle-inline">
                              <input
                                type="checkbox"
                                checked={own.size === m.actions.length}
                                ref={(el) => {
                                  if (el) el.indeterminate = own.size > 0 && own.size < m.actions.length;
                                }}
                                onChange={(e) => onChange?.(toggleModule(value, m, e.target.checked))}
                              />
                              {m.label}
                            </label>
                          ) : (
                            m.label
                          )}
                        </td>
                        {actions.map((a) =>
                          m.actions.includes(a.key) ? (
                            <td key={a.key}>
                              <input
                                type="checkbox"
                                aria-label={`${m.label}: ${a.label}`}
                                checked={on.has(a.key)}
                                disabled={!edit || (all.includes(a.key) && !own.has(a.key))}
                                title={all.includes(a.key) && !own.has(a.key) ? "Granted by Every page" : undefined}
                                onChange={(e) => onChange?.(togglePermission(value, m, a.key, e.target.checked))}
                              />
                            </td>
                          ) : (
                            <td key={a.key} className="perm-na" />
                          ),
                        )}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Tabs and form sections the group sees (team trial round 2): untick to hide, e.g. the Enterprise Docs tab. */
export function TabVisibility({
  catalog,
  hidden,
  onChange,
}: {
  catalog: AccessCatalog;
  hidden: string[];
  onChange?: (h: string[]) => void;
}) {
  const withTabs = catalog.modules.filter((m) => m.tabs?.length);
  const set = new Set(hidden);
  return (
    <div className="tab-visibility">
      <h3>Tabs and sections</h3>
      <p className="muted small">
        Untick a tab or section to hide it from this group. Each user can be given an exception.
      </p>
      <div className="tab-vis-grid">
        {withTabs.map((m) => (
          <fieldset key={m.key}>
            <legend>{m.label}</legend>
            {m.tabs!.map((t) => (
              <label key={t.key} className="toggle-inline">
                <input
                  type="checkbox"
                  checked={!set.has(t.key)}
                  disabled={!onChange}
                  onChange={(e) => {
                    const next = new Set(set);
                    if (e.target.checked) next.delete(t.key);
                    else next.add(t.key);
                    onChange?.([...next].sort());
                  }}
                />
                {t.label}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
    </div>
  );
}

function GroupDialog({ row, done }: { row: AccessGroupRow | null; done: () => void }) {
  const catalog = useAccessCatalog();
  const form = useForm<AccessGroupInput>(
    row
      ? {
          name: row.name,
          status: row.status,
          description: row.description,
          permissions: row.permissions,
          hiddenTabs: row.hiddenTabs,
        }
      : { name: "", status: "active", description: null, permissions: { dashboard: ["view"] }, hiddenTabs: [] },
  );
  const save = useSaveAccessGroup();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const permError = Object.entries(form.errors).find(([k]) => k.startsWith("permissions"));
  return (
    <Modal
      title={row ? `Edit ${row.name}` : "Add GUI access group"}
      width={1060}
      onClose={done}
      footer={
        <>
          {(error || permError) && (
            <span className="error-text small">
              {permError ? `${permError[0].replace("permissions.", "")}: ${permError[1]}` : error}
            </span>
          )}
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { id: row?.id ?? null, input: form.values },
                {
                  onSuccess: (r) => {
                    if (r.change) notifySaved(r.change, `Saved ${r.record.name}`);
                    done();
                  },
                  onError: (e) => setError(form.fail(e)),
                },
              )
            }
          >
            {row ? "Save" : "Add group"}
          </Button>
        </>
      }
    >
      <div className="fgrid cols-3">
        <TextField form={form} path="name" label="Access Group Name" required maxLength={80} />
        <SelectField
          form={form}
          path="status"
          label="Status"
          required
          options={[
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
        />
        <TextField form={form} path="description" label="Description" maxLength={500} />
      </div>
      {catalog.data ? (
        <>
          <PermissionMatrix
            catalog={catalog.data}
            value={form.values.permissions}
            onChange={(p) => form.set("permissions", p)}
          />
          <TabVisibility
            catalog={catalog.data}
            hidden={form.values.hiddenTabs}
            onChange={(h) => form.set("hiddenTabs", h)}
          />
        </>
      ) : (
        <p className="muted">Loading pages…</p>
      )}
    </Modal>
  );
}

const openDialog = (row: AccessGroupRow | null) => ask<void>((d) => <GroupDialog row={row} done={() => d()} />);

function MatrixView({ r }: { r: AccessGroupRow }) {
  const catalog = useAccessCatalog();
  return catalog.data ? (
    <>
      <PermissionMatrix catalog={catalog.data} value={r.permissions} />
      {r.hiddenTabs.length > 0 && <TabVisibility catalog={catalog.data} hidden={r.hiddenTabs} />}
    </>
  ) : (
    <p className="muted">Loading…</p>
  );
}

export function AccessGroupsPage() {
  const clone = useCloneAccessGroup();
  const navigate = useTabNavigate();
  const notifySaved = useNotifySaved();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("access_group");
  const cloneGroup = (r: AccessGroupRow) => {
    const name = window.prompt("Name of the copy", `${r.name} (copy)`);
    if (name?.trim())
      clone.mutate(
        { id: r.id, name: name.trim() },
        {
          onSuccess: (x) => x.change && notifySaved(x.change, `Cloned as ${x.record.name}`),
          onError: (e) => toast({ tone: "error", message: problemText(e) }),
        },
      );
  };
  const showUsers = (r: AccessGroupRow) =>
    navigate(
      `/admin/users?g=${encodeState({ ...emptyState(), columns: { accessGroup: { field: "accessGroup", op: "eq", value: r.name } } })}`,
    );
  return (
    <ListScreen<AccessGroupRow>
      list="access_groups"
      page={page}
      noSelection
      historyScope={{ entityTypes: ["access_group"] }}
      primary={{ label: "Add group", icon: "plus", onClick: () => void openDialog(null) }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted group: restore it first" : undefined,
          onSelect: () => void openDialog(r),
        },
        { label: "Clone", icon: "copy", disabled: clone.isPending, onSelect: () => cloneGroup(r) },
        { label: "Users", icon: "users", onSelect: () => showUsers(r) },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !admin || restore.isPending,
              hint: admin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (x) => x.change && notifySaved(x.change, `Restored ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete…",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("access_group", r.id, r.name),
            },
      ]}
      columns={{
        id: { width: 90 },
        name: { width: 220, render: (r) => <strong>{r.name}</strong> },
        description: { width: 360 },
        moduleCount: {
          width: 100,
          align: "right",
          render: (r) => (r.fullAccess ? "All" : <span className="num">{r.moduleCount}</span>),
        },
        fullAccess: { width: 110, render: (r) => (r.fullAccess ? "Yes" : <span className="muted">No</span>) },
        userCount: { width: 90, align: "right", render: (r) => <span className="num">{r.userCount}</span> },
        status: { width: 110, render: (r) => statusCell(r.status) },
      }}
      rowClass={(r) => (r.archivedAt ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.fullAccess ? "every page" : `${r.moduleCount} pages`} · {r.userCount} users
            </span>
          </>
        ),
        sections: [
          {
            key: "matrix",
            label: "Pages and buttons",
            actions: (
              <>
                <Button small icon="copy" disabled={clone.isPending} onClick={() => cloneGroup(r)}>
                  Clone
                </Button>
                <Button small icon="users" onClick={() => showUsers(r)}>
                  Users
                </Button>
                <RecordActions
                  kind="access_group"
                  id={r.id}
                  name={r.name}
                  archived={!!r.archivedAt}
                  onEdit={() => void openDialog(r)}
                />
              </>
            ),
            content: <MatrixView r={r} />,
          },
          {
            key: "info",
            label: "Info",
            content: (
              <Kv
                items={[
                  ["Description", r.description],
                  ["Users", String(r.userCount)],
                  ["Updated", `${fmtWhen(r.updatedAt)}${r.updatedBy ? ` by ${r.updatedBy}` : ""}`],
                ]}
              />
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["access_group"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
