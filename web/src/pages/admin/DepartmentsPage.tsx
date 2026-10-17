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
import { ListLookup } from "../../records/parts";
import { ask } from "../../ui/feedback";
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
  return (
    <ListScreen<DepartmentRow>
      list="departments"
      page={page}
      noSelection
      historyScope={{ entityTypes: ["department"] }}
      primary={{ label: "Add department", icon: "plus", onClick: () => void openDialog(null) }}
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
                <Button
                  small
                  icon="users"
                  onClick={() =>
                    navigate(
                      `/admin/users?g=${encodeState({ ...emptyState(), columns: { department: { field: "department", op: "eq", value: r.name } } })}`,
                    )
                  }
                >
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
