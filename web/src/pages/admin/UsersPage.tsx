// Users (§11, §12.5, §13.28): Department, UserName, Name, Email, User Type, GUI Access Group, Status
// and the Password column (last changed, days left; filter expired / expiring). The form is the
// §12.5 user edit page. Change password sets a temporary password valid 24 hours; Force change works
// on one or many selected users; QR 2FA enrols with a code from the app. Delete is blocked while the
// user is account manager of live enterprises (§13.29). Saves are undoable (§13.10).
import { useState } from "react";
import type { AccessCatalog, AccessGroupRow, DepartmentRow, UserInput, UserRow } from "@sms/contract";
import {
  setupTotp,
  useAccessCatalog,
  useAllRows,
  usePickRows,
  useConfirmTotp,
  useDisableTotp,
  useForcePasswordChange,
  useSaveUser,
  useSetUserPassword,
} from "../../api/admin";
import { useMe } from "../../api/hooks";
import { useReference, useRestore } from "../../api/records";
import { CheckField, FormField, SelectField, TextField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { openPasswordLinks } from "./PasswordLinks";
import { fmtWhen, RecordActions, RecordDialog } from "../reference/shared";
import { countryOptions, PASSWORD_TONE, passwordLabel, USER_TYPE } from "./adminModel";
import { Kv, openTempPassword, PasswordRules, statusCell } from "./parts";
import { useUserVisibility } from "../../api/visibility";
import { EffectiveCard } from "./visibility/VisibilityPage";
import { QrCode } from "../../ui/QrCode";

const page = pageForPath("/admin/users")!;
const muted = (v: string) => <span className="muted">{v}</span>;

/** 2FA as the user signs in (R9): code by e-mail, the authenticator app (once enrolled), or off. */
function twoFactorCell(r: UserRow) {
  if (r.otpMethod === "email") return "E-mail code";
  if (r.otpMethod === "authenticator")
    return r.totpEnabled ? "Authenticator" : <span className="tone-warning">App not enrolled</span>;
  return <span className="tone-warning">Off</span>;
}

const blank = (): UserInput => ({
  username: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: null,
  departmentId: 0,
  accessGroupId: null,
  businessCompanyId: null,
  managerId: null,
  userType: "wholesale",
  isAccountManager: false,
  isTeamLead: false,
  status: "active",
  allowMultipleLogin: false,
  otpMethod: "off",
  language: "en",
  address1: "",
  address2: null,
  countryIso: "AE",
  state: null,
  city: null,
  zip: null,
  password: null,
  permissionOverrides: {},
  tabOverrides: {},
});

const inputOf = (r: UserRow): UserInput => ({
  username: r.username,
  firstName: r.firstName,
  lastName: r.lastName,
  email: r.email,
  phone: r.phone,
  departmentId: r.departmentId,
  accessGroupId: r.accessGroupId,
  businessCompanyId: r.businessCompanyId,
  managerId: r.managerId,
  userType: r.userType,
  isAccountManager: r.isAccountManager,
  isTeamLead: r.isTeamLead,
  status: r.status,
  allowMultipleLogin: r.allowMultipleLogin,
  otpMethod: r.otpMethod,
  language: r.language,
  address1: r.address1,
  address2: r.address2,
  countryIso: r.countryIso,
  state: r.state,
  city: r.city,
  zip: r.zip,
  permissionOverrides: r.permissionOverrides,
  tabOverrides: r.tabOverrides,
});

function UserDialog({ row, done }: { row: UserRow | null; done: () => void }) {
  const ref = useReference();
  const departments = usePickRows<DepartmentRow>("departments");
  const groups = useAllRows<AccessGroupRow>("access_groups");
  const catalog = useAccessCatalog();
  const form = useForm<UserInput>(row ? inputOf(row) : blank());
  const save = useSaveUser();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  return (
    <RecordDialog
      title={row ? `Edit ${row.displayName}` : "Add user"}
      saveLabel={row ? "Save" : "Add user"}
      saving={save.isPending}
      error={error}
      width={820}
      onClose={done}
      onSave={() => {
        const { password, ...rest } = v;
        save.mutate(
          { id: row?.id ?? null, input: row ? rest : { ...rest, password } },
          {
            onSuccess: (r) => {
              if (r.change) notifySaved(r.change, `Saved ${r.record.username}`);
              done();
            },
            onError: (e) => setError(form.fail(e)),
          },
        );
      }}
    >
      <TextField form={form} path="firstName" label="First Name" required maxLength={80} />
      <TextField form={form} path="lastName" label="Last Name" required maxLength={80} />
      <TextField
        form={form}
        path="username"
        label="UserName"
        required
        maxLength={40}
        hint="Lower case letters, digits, dot, dash, underscore"
      />
      <TextField form={form} path="email" label="Email" type="email" required maxLength={200} />
      <TextField form={form} path="phone" label="Phone" type="tel" maxLength={50} />
      <SelectField
        form={form}
        path="departmentId"
        label="Department"
        required
        options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
        placeholder="Choose…"
      />
      <SelectField
        form={form}
        path="accessGroupId"
        label="GUI Access Group"
        options={(groups.data ?? []).map((g) => ({ value: g.id, label: g.name }))}
      />
      <SelectField
        form={form}
        path="businessCompanyId"
        label="Business Company"
        options={(ref.data?.businessCompanies ?? []).map((b) => ({ value: b.id, label: b.name }))}
      />
      <FormField label="Reports to (Director / Head)" error={form.error("managerId")}>
        <ListLookup<UserRow>
          list="users"
          value={v.managerId}
          onChange={(u) => form.set("managerId", u?.id ?? null)}
          labelOf={(u) => u.displayName}
          detailOf={(u) => `${u.username} · ${u.department ?? "—"}`}
          exclude={row ? [row.id] : []}
          placeholder={row?.manager ?? "Search users…"}
        />
      </FormField>
      <SelectField
        form={form}
        path="userType"
        label="Api User"
        required
        options={[
          { value: "wholesale", label: "No (Wholesale GUI user)" },
          { value: "api", label: "Yes (Api user)" },
        ]}
      />
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
      <SelectField
        form={form}
        path="otpMethod"
        label="OTP verification"
        required
        options={[
          { value: "off", label: "Off" },
          { value: "email", label: "Code by e-mail" },
          { value: "authenticator", label: "Authenticator app (Google Authenticator)" },
        ]}
        hint={
          v.otpMethod === "authenticator" && !row?.totpEnabled
            ? "Enrol the app with Enable QR 2FA after saving"
            : undefined
        }
      />
      <SelectField
        form={form}
        path="language"
        label="Language"
        required
        options={[{ value: "en", label: "English" }]}
      />
      {/* Roles in one row next to Language (team trial round 1: aligned; Team lead renamed Director / Head). */}
      <div className="ff user-roles">
        <span className="ff-label">Roles and access</span>
        <div className="user-roles-row">
          <CheckField form={form} path="isAccountManager" label="Account manager" />
          <CheckField form={form} path="isTeamLead" label="Director / Head" />
          <CheckField form={form} path="allowMultipleLogin" label="Allow multiple logins" />
        </div>
      </div>
      <TextField form={form} path="address1" label="Address 1" required maxLength={200} />
      <TextField form={form} path="address2" label="Address 2" maxLength={200} />
      <SelectField
        form={form}
        path="countryIso"
        label="Country"
        required
        options={countryOptions(ref.data?.countries ?? [])}
      />
      <TextField form={form} path="state" label="State" maxLength={100} />
      <TextField form={form} path="city" label="City" maxLength={100} />
      <TextField form={form} path="zip" label="Zip Code" maxLength={20} />
      <AccessOverrides
        catalog={catalog.data}
        group={groups.data?.find((g) => g.id === v.accessGroupId) ?? null}
        perms={v.permissionOverrides}
        tabs={v.tabOverrides}
        onPerms={(x) => form.set("permissionOverrides", x)}
        onTabs={(x) => form.set("tabOverrides", x)}
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
          <div className="ff">
            <PasswordRules
              input={{ password: v.password ?? "", username: v.username, firstName: v.firstName, lastName: v.lastName }}
            />
          </div>
        </>
      )}
    </RecordDialog>
  );
}

type Level = "inherit" | "none" | "view" | "full" | "custom";

/** Per-user exceptions to the access group (team trial round 2, §11): a page or tab can be opened or closed for one
 *  user without a new group. Pages and tabs left on Inherit follow the group. */
function AccessOverrides({
  catalog,
  group,
  perms,
  tabs,
  onPerms,
  onTabs,
}: {
  catalog: AccessCatalog | undefined;
  group: AccessGroupRow | null;
  perms: Record<string, string[]>;
  tabs: Record<string, boolean>;
  onPerms: (x: Record<string, string[]>) => void;
  onTabs: (x: Record<string, boolean>) => void;
}) {
  const count = Object.keys(perms).length + Object.keys(tabs).length;
  const [open, setOpen] = useState(count > 0);
  if (!catalog) return null;
  const levelOf = (key: string, all: string[]): Level => {
    const a = perms[key];
    if (!a) return "inherit";
    if (a.length === 0) return "none";
    if (a.length === 1 && a[0] === "view") return "view";
    if (all.every((x) => a.includes(x))) return "full";
    return "custom";
  };
  const groupHidden = new Set(group?.hiddenTabs ?? []);
  const groupHas = (page: string) => {
    const p = group?.permissions ?? {};
    return !!(p["*"]?.includes("view") || p[page]?.includes("view"));
  };
  return (
    <div className="ff wide access-overrides">
      <span className="ff-label">
        Access exceptions{" "}
        <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
          {open ? "Hide" : count ? `Show (${count})` : "Add…"}
        </button>
      </span>
      {open && (
        <>
          <p className="muted small">
            Inherit follows {group ? group.name : "the group"}.
          </p>
          <div className="tab-vis-grid">
            {catalog.sections.map((sec) => {
              const mods = catalog.modules.filter((m) => m.section === sec.key);
              if (!mods.length) return null;
              return (
                <fieldset key={sec.key}>
                  <legend>{sec.label}</legend>
                  {mods.map((m) => {
                    const level = levelOf(m.key, m.actions);
                    return (
                      <div key={m.key}>
                        <label className="override-row">
                          <span>{m.label}</span>
                          <select
                            value={level}
                            onChange={(e) => {
                              const next = { ...perms };
                              const l = e.target.value as Level;
                              if (l === "inherit") delete next[m.key];
                              else if (l === "none") next[m.key] = [];
                              else if (l === "view") next[m.key] = ["view"];
                              else if (l === "full") next[m.key] = [...m.actions];
                              onPerms(next);
                            }}
                          >
                            <option value="inherit">Inherit ({groupHas(m.key) ? "open" : "closed"})</option>
                            <option value="none">No access</option>
                            <option value="view">View only</option>
                            <option value="full">Full</option>
                            {level === "custom" && <option value="custom">Custom</option>}
                          </select>
                        </label>
                        {m.tabs?.map((t) => (
                          <label key={t.key} className="override-row override-tab">
                            <span>{t.label}</span>
                            <select
                              value={t.key in tabs ? (tabs[t.key] ? "show" : "hide") : "inherit"}
                              onChange={(e) => {
                                const next = { ...tabs };
                                if (e.target.value === "inherit") delete next[t.key];
                                else next[t.key] = e.target.value === "show";
                                onTabs(next);
                              }}
                            >
                              <option value="inherit">Inherit ({groupHidden.has(t.key) ? "hidden" : "shown"})</option>
                              <option value="show">Show</option>
                              <option value="hide">Hide</option>
                            </select>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </fieldset>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const openDialog = (row: UserRow | null) => ask<void>((d) => <UserDialog row={row} done={() => d()} />);

function TotpDialog({ row, done }: { row: UserRow; done: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const confirm = useConfirmTotp();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const start = () =>
    setupTotp(row.id).then(setSetup, (e: unknown) => toast({ tone: "error", message: problemText(e) }));
  return (
    <Modal
      title={`Enable QR 2FA – ${row.displayName}`}
      width={640}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          {setup ? (
            <Button
              variant="primary"
              icon="shield"
              disabled={code.length !== 6 || confirm.isPending}
              onClick={() =>
                confirm.mutate(
                  { id: row.id, code },
                  {
                    onSuccess: (r) => {
                      if (r.change) notifySaved(r.change, `2FA enabled for ${row.username}`);
                      done();
                    },
                    onError: (e) => setError(problemText(e)),
                  },
                )
              }
            >
              Confirm
            </Button>
          ) : (
            <Button variant="primary" icon="key" onClick={() => void start()}>
              Create secret
            </Button>
          )}
        </>
      }
    >
      {!setup ? (
        <p>A new secret is created for {row.username}. Add it to an authenticator app, then enter the 6-digit code.</p>
      ) : (
        <div className="totp-setup">
          {/* Two ways in (R9): scan the QR code, or type the setup key ("Enter a setup key" in Google Authenticator). */}
          <div className="totp-ways">
            <div className="totp-way">
              <strong>1 · Scan the QR code</strong>
              <QrCode value={setup.otpauthUri} label={`Authenticator QR code for ${row.username}`} />
              <span className="muted small">Google Authenticator: + › Scan a QR code</span>
            </div>
            <div className="totp-way">
              <strong>2 · Or enter the key</strong>
              <span className="muted small">Google Authenticator: + › Enter a setup key</span>
              <Kv
                items={[
                  ["Account", row.username],
                  [
                    "Key",
                    <span key="k" className="mono selectable">
                      {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
                    </span>,
                  ],
                  ["Type of key", "Time based"],
                ]}
              />
              <Button
                small
                icon="copy"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(setup.secret)
                    .then(() => toast({ tone: "good", message: "Key copied" }))
                }
              >
                Copy key
              </Button>
            </div>
          </div>
          <p className="muted small">Then type the 6-digit code the app shows.</p>
          <label className="field">
            <span>6-digit code</span>
            <input
              autoFocus
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function SecurityActions({ r }: { r: UserRow }) {
  const setPassword = useSetUserPassword();
  const force = useForcePasswordChange();
  const disable = useDisableTotp();
  const notifySaved = useNotifySaved();
  if (r.archivedAt) return null;
  return (
    <>
      <Button
        small
        icon="key"
        onClick={() =>
          void openTempPassword(r.username, { userId: r.id }, (input) => setPassword.mutateAsync({ id: r.id, input }))
        }
      >
        Change password
      </Button>
      <Button
        small
        icon="lock"
        disabled={r.mustChangePassword || force.isPending}
        onClick={() =>
          force.mutate([r.id], {
            onSuccess: (x) => x.change && notifySaved(x.change, `${r.username} must change the password at next login`),
            onError: (e) => toast({ tone: "error", message: problemText(e) }),
          })
        }
      >
        Force change
      </Button>
      {r.totpEnabled ? (
        <Button
          small
          icon="shield"
          disabled={disable.isPending}
          onClick={() =>
            window.confirm(`Disable QR 2FA for ${r.username}?`) &&
            disable.mutate(r.id, {
              onSuccess: () => toast({ tone: "warning", message: `2FA disabled for ${r.username}` }),
              onError: (e) => toast({ tone: "error", message: problemText(e) }),
            })
          }
        >
          Disable QR 2FA
        </Button>
      ) : (
        <Button small icon="shield" onClick={() => void ask<void>((d) => <TotpDialog row={r} done={() => d()} />)}>
          Enable QR 2FA
        </Button>
      )}
    </>
  );
}

export function UsersPage() {
  const force = useForcePasswordChange();
  const notifySaved = useNotifySaved();
  const setPassword = useSetUserPassword();
  const disable = useDisableTotp();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("user");
  const deleted = (r: UserRow) => (r.archivedAt ? "Deleted user: restore it first" : undefined);
  return (
    <ListScreen<UserRow>
      list="users"
      page={page}
      // Ctrl K: /admin/users?user=<id> selects that user and opens the detail (functional QA round 13).
      deepLink="user"
      historyScope={{ entityTypes: ["user", "user_password", "user_totp"] }}
      primary={{ label: "Add user", icon: "plus", onClick: () => void openDialog(null) }}
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
            void openTempPassword(r.username, { userId: r.id }, (input) =>
              setPassword.mutateAsync({ id: r.id, input }),
            ),
        },
        {
          label: "E-mail password link…",
          icon: "mail",
          disabled: !!r.archivedAt || r.status !== "active",
          hint: deleted(r) ?? (r.status !== "active" ? "Inactive user" : "A link to choose their own password (72 hours)"),
          onSelect: () => void openPasswordLinks([r.id], r.username),
        },
        {
          label: "Force change",
          icon: "lock",
          disabled: !!r.archivedAt || r.mustChangePassword || force.isPending,
          hint: deleted(r) ?? (r.mustChangePassword ? "Already has to change it at next login" : undefined),
          onSelect: () =>
            force.mutate([r.id], {
              onSuccess: (x) =>
                x.change && notifySaved(x.change, `${r.username} must change the password at next login`),
              onError: (e) => toast({ tone: "error", message: problemText(e) }),
            }),
        },
        r.totpEnabled
          ? {
              label: "Disable QR 2FA",
              icon: "shield",
              disabled: !!r.archivedAt || disable.isPending,
              hint: deleted(r),
              onSelect: () =>
                window.confirm(`Disable QR 2FA for ${r.username}?`) &&
                disable.mutate(r.id, {
                  onSuccess: () => toast({ tone: "warning", message: `2FA disabled for ${r.username}` }),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Enable QR 2FA…",
              icon: "shield",
              disabled: !!r.archivedAt,
              hint: deleted(r),
              onSelect: () => void ask<void>((d) => <TotpDialog row={r} done={() => d()} />),
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
              onSelect: () => void deleteOne("user", r.id, r.username),
            },
      ]}
      columns={{
        id: { width: 80 },
        department: { width: 120 },
        username: { width: 170, render: (r) => <strong>{r.username}</strong> },
        displayName: { width: 180 },
        email: { width: 240 },
        userType: { width: 110, render: (r) => USER_TYPE[r.userType] },
        accessGroup: { width: 170, render: (r) => r.accessGroup ?? muted("—") },
        status: { width: 100, render: (r) => statusCell(r.status) },
        passwordState: {
          width: 210,
          render: (r) => (
            <span title={`Changed ${fmtWhen(r.passwordChangedAt)}`}>
              <StatusDot tone={PASSWORD_TONE[r.passwordState]} /> {passwordLabel(r)}
            </span>
          ),
        },
        passwordChangedAt: { width: 160, render: (r) => fmtWhen(r.passwordChangedAt) },
        passwordDaysLeft: {
          width: 100,
          align: "right",
          render: (r) => (
            <span
              className={`num${r.passwordDaysLeft < 0 ? " tone-error" : r.passwordDaysLeft <= 7 ? " tone-warning" : ""}`}
            >
              {r.passwordDaysLeft}
            </span>
          ),
        },
        // The sign-in code method (R9): an e-mailed code is 2FA too; the app counts once it is enrolled.
        totpEnabled: { width: 110, render: (r) => twoFactorCell(r) },
        isAccountManager: { width: 90, render: (r) => (r.isAccountManager ? "Yes" : muted("No")) },
        lastLoginAt: { width: 160, render: (r) => (r.lastLoginAt ? fmtWhen(r.lastLoginAt) : muted("never")) },
      }}
      rowClass={(r) => (r.archivedAt ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      selection={{
        summary: (_rows, ids) => `${ids.size} user${ids.size === 1 ? "" : "s"} selected`,
        bulk: (ids, clear) => [
          {
            // Team trial round 11: e.g. users just imported, so each picks their own password.
            label: `E-mail password links (${ids.length})`,
            icon: "mail",
            onSelect: () => void openPasswordLinks(ids, `${ids.length} users`).then(clear),
          },
          {
            label: `Force a password change (${ids.length})`,
            icon: "lock",
            onSelect: () =>
              force.mutate(ids, {
                onSuccess: (x) => {
                  if (x.change) notifySaved(x.change, `${x.updated} user(s) must change the password at next login`);
                  else toast({ tone: "good", message: "Every selected user already has to change it" });
                  clear();
                },
                onError: (e) => toast({ tone: "error", message: problemText(e) }),
              }),
          },
        ],
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.displayName}</strong>
            <span className="muted">
              {r.username} · {r.department ?? "—"} · {r.accessGroup ?? "no access group"}
            </span>
          </>
        ),
        sections: [
          {
            key: "profile",
            label: "Profile",
            actions: (
              <RecordActions
                kind="user"
                id={r.id}
                name={r.username}
                archived={!!r.archivedAt}
                onEdit={() => void openDialog(r)}
              />
            ),
            content: (
              <Kv
                items={[
                  ["Email", r.email],
                  ["Phone", r.phone],
                  [
                    "User type",
                    `${USER_TYPE[r.userType]}${r.isAccountManager ? " · Account Manager" : ""}${r.isTeamLead ? " · Director / Head" : ""}`,
                  ],
                  ["Business company", r.businessCompany],
                  ["Reports to", r.manager],
                  [
                    "Address",
                    [r.address1, r.address2, r.city, r.state, r.zip, r.countryIso].filter(Boolean).join(", "),
                  ],
                  ["Multiple login", r.allowMultipleLogin ? "Allowed" : "One session at a time"],
                  ["Account Manager of live enterprises", r.liveEnterprises ? r.liveEnterprises.toLocaleString("en-US") : null],
                  ["Updated", `${fmtWhen(r.updatedAt)}${r.updatedBy ? ` by ${r.updatedBy}` : ""}`],
                ]}
              />
            ),
          },
          {
            key: "security",
            label: "Password & 2FA",
            actions: <SecurityActions r={r} />,
            content: (
              <Kv
                items={[
                  [
                    "Password",
                    <span key="p">
                      <StatusDot tone={PASSWORD_TONE[r.passwordState]} /> {passwordLabel(r)}
                    </span>,
                  ],
                  ["Last changed", fmtWhen(r.passwordChangedAt)],
                  ["Expires", fmtWhen(r.passwordExpiresAt)],
                  ["Temporary until", r.tempPasswordExpiresAt ? fmtWhen(r.tempPasswordExpiresAt) : null],
                  ["QR 2FA (TOTP)", r.totpEnabled ? "Enabled" : <span className="tone-warning">Not enabled</span>],
                  ["OTP verification", twoFactorCell(r)],
                  ["Last login", r.lastLoginAt ? fmtWhen(r.lastLoginAt) : "never"],
                  ["Open sessions", String(r.activeSessions)],
                ]}
              />
            ),
          },
          {
            key: "visibility",
            label: "Visibility",
            content: <UserVisibility id={r.id} />,
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["user", "user_password", "user_totp"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Space selects · Ctrl+Z undo"
    />
  );
}

/** The user's effective visibility policy (§13.17: shown on their profile). */
function UserVisibility({ id }: { id: number }) {
  const v = useUserVisibility(id);
  if (!v.data) return <span className="muted">Loading…</span>;
  return <EffectiveCard v={v.data} />;
}
