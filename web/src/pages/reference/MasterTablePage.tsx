// Master Table (§6.1): dial-code profiles, each a set of prefixes mapped to MCCMNC codes.
// "All" is the default profile, used to resolve numbers (Rate Lookup, route tests); it
// cannot be renamed or deleted. The profile list opens one profile's dial codes in the same
// tab (?profile=<id>), a server-side grid with add, edit, bulk delete, the Master Data
// Import (dry run first) and export. Every save is one undoable change (§13.10).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import type { Destination, DialCode, DialCodeInput, DialCodeProfile, ListQuery } from "@sms/contract";
import { fetchListPage, useMe } from "../../api/hooks";
import { useRestore } from "../../api/records";
import { downloadCsv, useDeleteDialCodes, useSaveDialCode, useSaveProfile } from "../../api/masterData";
import { FormField, TextField, useForm } from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen, openImport, RecordActions, RecordDialog } from "./shared";
import { destLabel } from "../rates/DestinationTree";

const page = pageForPath("/rates/master-table")!;

// ---------------------------------------------------------------- dialogs

function ProfileDialog({ row, done }: { row: DialCodeProfile | null; done: (id: number | null) => void }) {
  const form = useForm<{ name: string; copyFromId: number | null }>({ name: row?.name ?? "", copyFromId: null });
  const save = useSaveProfile();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    save.mutate(
      { id: row?.id ?? null, input: { name: form.values.name.trim(), copyFromId: form.values.copyFromId } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, row ? `Renamed to ${r.record.name}` : `Added profile ${r.record.name}`);
          done(r.record.id);
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  return (
    <RecordDialog
      form={form}
      title={row ? `Rename ${row.name}` : "Add dial-code profile"}
      saveLabel={row ? "Save" : "Add profile"}
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={() => done(null)}
      width={480}
    >
      <TextField form={form} path="name" label="Profile" required wide maxLength={40} nullable={false} />
      {!row && (
        <FormField label="Copy dial codes from" wide hint="Optional">
          <ListLookup<DialCodeProfile>
            list="dial_code_profiles"
            value={form.values.copyFromId}
            onChange={(p) => form.set("copyFromId", p?.id ?? null)}
            labelOf={(p) => p.name}
            detailOf={(p) => `${p.prefixes} dial codes`}
            placeholder="Start empty"
          />
        </FormField>
      )}
    </RecordDialog>
  );
}

function DialCodeDialog({ profile, row, done }: { profile: DialCodeProfile; row: DialCode | null; done: () => void }) {
  const form = useForm<DialCodeInput>({
    profileId: profile.id,
    prefix: row?.prefix ?? "",
    destinationId: row?.destinationId ?? (0 as number),
  });
  const save = useSaveDialCode();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!form.values.destinationId) return setError("Choose the MCCMNC code.");
    save.mutate(
      { id: row?.id ?? null, input: { ...form.values, prefix: form.values.prefix.replace(/^\+/, "") } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${row ? "Saved" : "Added"} dial code ${r.record.prefix}`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  return (
    <RecordDialog
      form={form}
      title={row ? `Edit dial code ${row.prefix}` : `Add dial code to ${profile.name}`}
      saveLabel={row ? "Save" : "Add dial code"}
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={done}
      width={520}
    >
      <TextField
        form={form}
        path="prefix"
        label="Dial Code"
        required
        wide
        maxLength={16}
        placeholder="4915"
        nullable={false}
        hint="Digits only"
      />
      <FormField label="MCCMNC" required wide error={form.error("destinationId")}>
        <ListLookup<Destination>
          list="destinations"
          value={form.values.destinationId || null}
          onChange={(d) => form.set("destinationId", d?.id ?? 0)}
          labelOf={(d) => destLabel(d.country, d.network, d.allNetworks, d.mccmnc)}
          detailOf={(d) => `+${d.dialCode}`}
          placeholder="Country, network or MCCMNC…"
          clearable={false}
        />
      </FormField>
    </RecordDialog>
  );
}

// ---------------------------------------------------------------- pages

function useProfileParam(): [number | null, (id: number | null) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const raw = new URLSearchParams(location.search).get("profile");
  return [
    raw ? Number(raw) : null,
    (id) => navigate(id === null ? "/rates/master-table" : `/rates/master-table?profile=${id}`, { replace: false }),
  ];
}

export function MasterTablePage() {
  const [profileId, open] = useProfileParam();
  return profileId === null ? <ProfileList open={open} /> : <ProfileCodes id={profileId} back={() => open(null)} />;
}

function ProfileList({ open }: { open: (id: number) => void }) {
  const deleteOne = useDeleteRecord();
  const { data: me } = useMe();
  const restore = useRestore("dial_code_profile");
  const notifySaved = useNotifySaved();
  const isAdmin = isAdminUser(me?.permissions);
  const addProfile = async () => {
    const id = await ask<number>((done) => <ProfileDialog row={null} done={done} />);
    if (id) open(id);
  };
  return (
    <ListScreen<DialCodeProfile>
      list="dial_code_profiles"
      listExport
      bulkDelete={{ noun: "profile", restore: true }}
      page={page}
      historyScope={{ entityTypes: ["dial_code_profile", "dial_code"] }}
      primary={{ label: "Add profile", icon: "plus", onClick: () => void addProfile() }}
      // Double-click or Enter opens the dial codes; the default profile is not renamed or deleted (§6.1).
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: r.isDefault || !!r.archivedAt,
          hint: r.isDefault ? "The default profile cannot be renamed" : r.archivedAt ? "Deleted profile" : undefined,
          onSelect: () => void ask<number>((done) => <ProfileDialog row={r} done={done} />),
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
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored profile ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              disabled: r.isDefault,
              hint: r.isDefault ? "The default profile cannot be deleted" : undefined,
              onSelect: () => void deleteOne("dial_code_profile", r.id, `profile ${r.name}`),
            },
      ]}
      columns={{
        name: {
          width: 240,
          render: (r) => (
            <strong>
              {r.name}
              {r.isDefault && <span className="muted"> · default</span>}
            </strong>
          ),
        },
        prefixes: { width: 120, align: "right" },
        destinations: { width: 140, align: "right" },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? <span className="muted">—</span> },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
      }}
      onOpen={(r) => !r.archivedAt && open(r.id)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.prefixes.toLocaleString("en-US")} dial codes · {r.destinations.toLocaleString("en-US")} MCCMNC codes
            </span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "Profile",
            actions: (
              <>
                {!r.archivedAt && (
                  <Button small icon="list" onClick={() => open(r.id)}>
                    Open dial codes
                  </Button>
                )}
                <RecordActions
                  kind="dial_code_profile"
                  id={r.id}
                  name={`profile ${r.name}`}
                  archived={!!r.archivedAt}
                  canDelete={!r.isDefault}
                  onEdit={
                    r.isDefault ? undefined : () => void ask<number>((done) => <ProfileDialog row={r} done={done} />)
                  }
                />
              </>
            ),
            content: (
              <p className="muted">
                {r.isDefault
                  ? "Default profile. It cannot be renamed or deleted."
                  : "Open it to edit its dial codes."}
              </p>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter opens the profile's dial codes · Ctrl+Z undo"
    />
  );
}

function ProfileCodes({ id, back }: { id: number; back: () => void }) {
  const profile = useQuery({
    queryKey: ["list", "dial_code_profiles", "one", id],
    queryFn: () =>
      fetchListPage<DialCodeProfile>("dial_code_profiles", {
        filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: id }] },
        limit: 1,
        withTotal: false,
      }).then((p) => p.rows[0] ?? null),
  });
  const del = useDeleteDialCodes();
  const delProfile = useDeleteRecord();
  const notifySaved = useNotifySaved();
  const p = profile.data;
  if (profile.isPending) return <div className="grid-message muted">Loading…</div>;
  if (!p)
    return (
      <div className="grid-message">
        Profile {id} not found.{" "}
        <button type="button" className="link" onClick={back}>
          Back to the profiles
        </button>
      </div>
    );
  const edit = (row: DialCode | null) =>
    ask<void>((done) => <DialCodeDialog profile={p} row={row} done={() => done()} />);
  const remove = (ids: number[], clear?: () => void) =>
    del.mutate(ids, {
      onSuccess: (r) => {
        if (r.change) notifySaved(r.change, `Deleted ${ids.length} dial code${ids.length === 1 ? "" : "s"}`);
        clear?.();
      },
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  const withProfile = (body: ListQuery): ListQuery => ({
    ...body,
    filter: {
      logic: "and",
      conditions: [{ field: "profileId", op: "eq", value: id }, ...(body.filter ? [body.filter] : [])],
    },
  });
  return (
    <ListScreen<DialCode>
      list="dial_codes"
      page={page}
      title={`Master table · ${p.name}`}
      historyScope={{ entityTypes: ["dial_code"] }}
      queryScope={id}
      fetchPage={(body) => fetchListPage<DialCode>("dial_codes", withProfile(body))}
      primary={{ label: "Add dial code", icon: "plus", onClick: () => void edit(null), disabled: !!p.archivedAt }}
      actions={
        <>
          <Button icon="list" onClick={back}>
            All profiles
          </Button>
          <Button
            icon="upload"
            disabled={!!p.archivedAt}
            onClick={() =>
              void openImport({
                target: { kind: "dial_codes", profileId: p.id, profile: p.name },
                title: `Master Data Import · ${p.name}`,
                help: (
                  <p>
                    Columns <code>prefix</code> (digits) and <code>mccmnc</code> (a live code). A prefix already in{" "}
                    {p.name} is updated, a new one added.
                  </p>
                ),
                replaceHint: `Prefixes of ${p.name} missing from the file are archived.`,
              })
            }
          >
            Import
          </Button>
          {!p.isDefault && !p.archivedAt && (
            <Button
              icon="trash"
              onClick={() => void delProfile("dial_code_profile", p.id, `profile ${p.name}`).then((r) => r && back())}
            >
              Delete profile
            </Button>
          )}
        </>
      }
      onExport={() =>
        void downloadCsv(`/dial-code-profiles/${p.id}/export`).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        prefix: { width: 140, render: (r) => <span className="num strong">{r.prefix}</span> },
        mccmnc: { width: 110, render: (r) => <span className="num">{r.mccmnc}</span> },
        country: { width: 220 },
        network: { width: 280 },
      }}
      onOpen={(r) => void edit(r)}
      rowActions={(r) => [
        { label: "Edit", icon: "file", main: true, onSelect: () => void edit(r) },
        { label: "Delete", icon: "trash", danger: true, onSelect: () => remove([r.id]) },
      ]}
      selection={{
        summary: (_rows, ids) => `${ids.size} selected`,
        bulk: (ids, clear) => [
          { label: `Delete ${ids.length} dial codes`, icon: "trash", danger: true, onSelect: () => remove(ids, clear) },
        ],
      }}
      detail={(r) => ({
        title: (
          <>
            <strong className="num">{r.prefix}</strong>
            <span className="muted">
              → {r.mccmnc} {r.country} · {r.network}
            </span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "Dial code",
            actions: (
              <>
                <Button small icon="file" onClick={() => void edit(r)}>
                  Edit
                </Button>
                <Button small icon="trash" onClick={() => remove([r.id])}>
                  Delete
                </Button>
              </>
            ),
            content: (
              <dl className="kv">
                <dt>Profile</dt>
                <dd>{r.profile}</dd>
                <dt>Updated</dt>
                <dd>
                  {r.updatedBy ?? "seed data"} · {fmtWhen(r.updatedAt)}
                </dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Space selects · a prefix filter like 4475% finds a range · Ctrl+Z undo"
    />
  );
}
