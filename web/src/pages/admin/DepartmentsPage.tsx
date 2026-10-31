// Departments (§11): Info ID, Department Name, Manager, Users, Status, Updated By. Delete is blocked
// while users are in the department (§13.29); Delete History is the History tab (§13.10).
import { useState } from "react";
import type { DepartmentInput, DepartmentRow, UserRow } from "@sms/contract";
import { useSaveDepartment } from "../../api/admin";
import { emptyState, encodeState } from "../../grid/filterModel";
import { FormField, SelectField, TextArea, TextField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useMe } from "../../api/hooks";
import { useRestore } from "../../api/records";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { problemText } from "../routing/dialogs";
import { useTabNavigate } from "../../shell/tabContext";
import { Button } from "../../ui/primitives";
import { fmtWhen, RecordActions, RecordDialog } from "../reference/shared";
import { Kv, statusCell } from "./parts";

const page = pageForPath("/admin/departments")!;

function DepartmentDialog({ row, done }: { row: DepartmentRow | null; done: () => void }) {
  const form = useForm<DepartmentInput>(
    row
      ? { name: row.name, status: row.status, managerId: row.managerId, description: row.description }
      : { name: "", status: "active", managerId: null, description: null },
  );
  const save = useSaveDepartment();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  return (
    <RecordDialog
      form={form}
      title={row ? `Edit ${row.name}` : "Add department"}
      saveLabel={row ? "Save" : "Add department"}
      saving={save.isPending}
      error={error}
      onClose={done}
      onSave={() =>
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
      <TextField form={form} path="name" label="Department Name" required maxLength={80} />
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
      <FormField label="Manager" wide error={form.error("managerId")}>
        <ListLookup<UserRow>
          list="users"
          value={form.values.managerId}
          onChange={(u) => form.set("managerId", u?.id ?? null)}
          labelOf={(u) => u.displayName}
          detailOf={(u) => `${u.username} · ${u.department ?? "—"}`}
          placeholder={row?.manager ?? "Search users…"}
        />
      </FormField>
      <TextArea form={form} path="description" label="Description" rows={3} />
    </RecordDialog>
  );
}

const openDialog = (row: DepartmentRow | null) => ask<void>((d) => <DepartmentDialog row={row} done={() => d()} />);

export function DepartmentsPage() {
  const navigate = useTabNavigate();
  const notifySaved = useNotifySaved();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("department");
  const showUsers = (r: DepartmentRow) =>
    navigate(
      `/admin/users?g=${encodeState({ ...emptyState(), columns: { department: { field: "department", op: "eq", value: r.name } } })}`,
    );
  return (
    <ListScreen<DepartmentRow>
      list="departments"
      page={page}
      noSelection
      historyScope={{ entityTypes: ["department"] }}
      primary={{ label: "Add department", icon: "plus", onClick: () => void openDialog(null) }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted department: restore it first" : undefined,
          onSelect: () => void openDialog(r),
        },
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
              onSelect: () => void deleteOne("department", r.id, r.name),
            },
      ]}
      columns={{
        id: { width: 90 },
        name: { width: 240, render: (r) => <strong>{r.name}</strong> },
        manager: { width: 220, render: (r) => r.manager ?? <span className="muted">—</span> },
        userCount: { width: 100, align: "right", render: (r) => <span className="num">{r.userCount}</span> },
        status: { width: 110, render: (r) => statusCell(r.status) },
        updatedBy: { width: 160 },
      }}
      rowClass={(r) => (r.archivedAt ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.userCount} users · manager {r.manager ?? "—"}
            </span>
          </>
        ),
        sections: [
          {
            key: "department",
            label: "Department",
            actions: (
              <>
                <Button small icon="users" onClick={() => showUsers(r)}>
                  Users
                </Button>
                <RecordActions
                  kind="department"
                  id={r.id}
                  name={r.name}
                  archived={!!r.archivedAt}
                  onEdit={() => void openDialog(r)}
                />
              </>
            ),
            content: (
              <Kv
                items={[
                  ["Manager", r.manager],
                  ["Users", String(r.userCount)],
                  ["Description", r.description],
                  ["Updated", `${fmtWhen(r.updatedAt)}${r.updatedBy ? ` by ${r.updatedBy}` : ""}`],
                ]}
              />
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["department"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
