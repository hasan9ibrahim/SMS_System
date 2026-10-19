// Customer Portal (§11): Info ID, Email, UserName, Enterprise, First Name, Last Name, Status - logins
// for the customer self-service portal. Change Password sets a temporary password valid 24 hours; the
// monthly change applies to portal users too (§13.28).
import { useState } from "react";
import type { Enterprise, PortalUserInput, PortalUserRow } from "@sms/contract";
import { useSavePortalUser, useSetPortalPassword } from "../../api/admin";
import { FormField, SelectField, TextField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useMe } from "../../api/hooks";
import { useRestore } from "../../api/records";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { problemText } from "../routing/dialogs";
import { Button } from "../../ui/primitives";
import { fmtWhen, RecordActions, RecordDialog } from "../reference/shared";
import { Kv, openTempPassword, PasswordRules, statusCell } from "./parts";

const page = pageForPath("/admin/customer-portal")!;

function PortalUserDialog({ row, done }: { row: PortalUserRow | null; done: () => void }) {
  const form = useForm<PortalUserInput>(
    row
      ? {
          email: row.email,
          username: row.username,
          enterpriseId: row.enterpriseId,
          firstName: row.firstName,
          lastName: row.lastName,
          status: row.status,
        }
      : { email: "", username: "", enterpriseId: 0, firstName: "", lastName: "", status: "active", password: null },
  );
  const save = useSavePortalUser();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  return (
    <RecordDialog
      title={row ? `Edit ${row.username}` : "Add portal user"}
      saveLabel={row ? "Save" : "Add portal user"}
      saving={save.isPending}
      error={error}
      width={640}
      onClose={done}
      onSave={() =>
        save.mutate(
          { id: row?.id ?? null, input: v },
          {
            onSuccess: (r) => {
              if (r.change) notifySaved(r.change, `Saved ${r.record.username}`);
              done();
            },
            onError: (e) => setError(form.fail(e)),
          },
        )
      }
    >
      <FormField label="Enterprise" required wide error={form.error("enterpriseId")}>
        <ListLookup<Enterprise>
          list="enterprises"
          value={v.enterpriseId || null}
          onChange={(e) => form.set("enterpriseId", e?.id ?? 0)}
          labelOf={(e) => e.name}
          detailOf={(e) => `${e.alias} · ${e.type}`}
          fixed={[{ field: "type", op: "in", values: ["customer", "reciprocal"] }]}
          placeholder={row?.enterprise ?? "Customer name…"}
        />
      </FormField>
      <TextField form={form} path="firstName" label="First Name" required maxLength={80} />
      <TextField form={form} path="lastName" label="Last Name" required maxLength={80} />
      <TextField form={form} path="email" label="Email" type="email" required maxLength={200} />
      <TextField form={form} path="username" label="UserName" required maxLength={60} />
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
      {!row && (
        <>
          <TextField
            form={form}
            path="password"
            label="Temporary password"
            type="password"
            required
            maxLength={200}
            autoComplete="new-password"
            hint="Valid 24 hours; changed at first login"
          />
          <div className="ff wide">
            <PasswordRules
              input={{ password: v.password ?? "", username: v.username, firstName: v.firstName, lastName: v.lastName }}
            />
          </div>
        </>
      )}
    </RecordDialog>
  );
}

const openDialog = (row: PortalUserRow | null) => ask<void>((d) => <PortalUserDialog row={row} done={() => d()} />);

function PasswordButton({ r }: { r: PortalUserRow }) {
  const setPassword = useSetPortalPassword();
  if (r.archivedAt) return null;
  return (
    <Button
      small
      icon="key"
      onClick={() =>
        void openTempPassword(
          r.username,
          { username: r.username, firstName: r.firstName, lastName: r.lastName },
          (input) => setPassword.mutateAsync({ id: r.id, input }),
        )
      }
    >
      Change password
    </Button>
  );
}

export function CustomerPortalPage() {
  const setPassword = useSetPortalPassword();
  const notifySaved = useNotifySaved();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("portal_user");
  const deleted = (r: PortalUserRow) => (r.archivedAt ? "Deleted login: restore it first" : undefined);
  return (
    <ListScreen<PortalUserRow>
      list="customer_portal_users"
      page={page}
      noSelection
      historyScope={{ entityTypes: ["portal_user", "portal_user_password"] }}
      primary={{ label: "Add portal user", icon: "plus", onClick: () => void openDialog(null) }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: deleted(r),
          onSelect: () => void openDialog(r),
        },
        {
          label: "Change password…",
          icon: "key",
          disabled: !!r.archivedAt,
          hint: deleted(r) ?? "Temporary password valid 24 hours",
          onSelect: () =>
            void openTempPassword(
              r.username,
              { username: r.username, firstName: r.firstName, lastName: r.lastName },
              (input) => setPassword.mutateAsync({ id: r.id, input }),
            ),
        },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !admin || restore.isPending,
              hint: admin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (x) => x.change && notifySaved(x.change, `Restored ${r.username}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete…",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("portal_user", r.id, r.username),
            },
      ]}
      columns={{
        id: { width: 90 },
        email: { width: 260 },
        username: { width: 160, render: (r) => <strong>{r.username}</strong> },
        enterprise: { width: 240 },
        firstName: { width: 130 },
        lastName: { width: 130 },
        status: { width: 100, render: (r) => statusCell(r.status) },
        passwordDaysLeft: {
          width: 120,
          align: "right",
          render: (r) => (
            <span
              className={`num${r.passwordDaysLeft < 0 ? " tone-error" : r.passwordDaysLeft <= 7 ? " tone-warning" : ""}`}
            >
              {r.passwordDaysLeft}
            </span>
          ),
        },
        lastLoginAt: {
          width: 160,
          render: (r) => (r.lastLoginAt ? fmtWhen(r.lastLoginAt) : <span className="muted">never</span>),
        },
      }}
      rowClass={(r) => (r.archivedAt ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.firstName} {r.lastName}
            </strong>
            <span className="muted">
              {r.username} · {r.enterprise}
            </span>
          </>
        ),
        sections: [
          {
            key: "login",
            label: "Login",
            actions: (
              <>
                <PasswordButton r={r} />
                <RecordActions
                  kind="portal_user"
                  id={r.id}
                  name={r.username}
                  archived={!!r.archivedAt}
                  onEdit={() => void openDialog(r)}
                />
              </>
            ),
            content: (
              <Kv
                items={[
                  ["Enterprise", r.enterprise],
                  ["Email", r.email],
                  ["Password changed", fmtWhen(r.passwordChangedAt)],
                  [
                    "Password expires",
                    `${fmtWhen(r.passwordExpiresAt)} (${r.passwordDaysLeft < 0 ? `${-r.passwordDaysLeft} days ago` : `${r.passwordDaysLeft} days left`})`,
                  ],
                  ["Temporary until", r.tempPasswordExpiresAt ? fmtWhen(r.tempPasswordExpiresAt) : null],
                  ["Must change at login", r.mustChangePassword ? "Yes" : "No"],
                  ["Last login", r.lastLoginAt ? fmtWhen(r.lastLoginAt) : "never"],
                ]}
              />
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["portal_user", "portal_user_password"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
