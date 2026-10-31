// MCCMNC Unique Codes (§6.1, §13.21): the destination master list, the routing and rating
// key. Add, edit, delete (archive, blocked while rate lines, rules, dial codes or MO numbers
// use the code, §13.29), import with a dry run and export. Each country has an "All networks"
// code (MCC only) used as the fallback. The DLR target per destination (decided 2026-10-16)
// turns route rule DLRs amber below it (§15.4); a country's target covers its networks
// unless a network has its own.
import { useState } from "react";
import type { Country, Destination, DestinationInput } from "@sms/contract";
import { useMe } from "../../api/hooks";
import { downloadCsv, useSaveDestination } from "../../api/masterData";
import { useRestore, useSetDlrTarget } from "../../api/records";
import { FormField, TextField, useForm } from "../../form/form";
import { toListQuery } from "../../grid/filterModel";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { codeLabel } from "../reference/referenceModel";
import { fmtWhen, openImport, RecordActions, RecordDialog } from "../reference/shared";

const page = pageForPath("/rates/mccmnc")!;

function TargetCell({ row }: { row: Destination }) {
  const save = useSetDlrTarget();
  const notifySaved = useNotifySaved();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const submit = () => {
    const text = value.trim().replace("%", "");
    const targetPct = text === "" ? null : Number(text);
    if (targetPct !== null && (!Number.isFinite(targetPct) || targetPct < 0 || targetPct > 100))
      return toast({ tone: "error", message: "Enter a target between 0 and 100 %, or leave it empty to remove it." });
    setEditing(false);
    save.mutate(
      { id: row.id, targetPct },
      {
        onSuccess: (r) =>
          r.change &&
          notifySaved(r.change, `DLR target ${row.mccmnc}: ${targetPct === null ? "removed" : `${targetPct}%`}`),
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
  };
  if (editing)
    return (
      <input
        className="cell-input num"
        autoFocus
        value={value}
        placeholder="none"
        aria-label={`DLR target for ${row.mccmnc}`}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  return (
    <button
      type="button"
      className="cell-edit num"
      title={
        row.allNetworks
          ? "Target for every network of the country without its own. Click to change; empty removes it."
          : "This network's own target; empty = the country's target. Click to change."
      }
      onClick={(e) => {
        e.stopPropagation();
        setValue(row.dlrTargetPct === null ? "" : String(row.dlrTargetPct));
        setEditing(true);
      }}
    >
      {row.dlrTargetPct === null ? (
        <span className="muted">{row.allNetworks ? "none" : "country's"}</span>
      ) : (
        `${row.dlrTargetPct}%`
      )}
    </button>
  );
}

function DestinationDialog({ row, done }: { row: Destination | null; done: () => void }) {
  const form = useForm<DestinationInput>({
    mcc: row?.mcc ?? "",
    mnc: row?.mnc ?? "",
    originalMnc: row?.originalMnc ?? null,
    countryId: row?.countryId ?? (0 as number),
    network: row && !row.allNetworks ? row.network : "",
  });
  const save = useSaveDestination();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  const submit = () => {
    if (!v.countryId) return setError("Choose the country.");
    save.mutate(
      { id: row?.id ?? null, input: { ...v, network: v.mnc === "" ? "All networks" : v.network } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${row ? "Saved" : "Added"} MCCMNC ${r.record.mccmnc}`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  return (
    <RecordDialog
      form={form}
      title={row ? `Edit MCCMNC ${row.mccmnc}` : "Add MCCMNC code"}
      saveLabel={row ? "Save" : "Add code"}
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={done}
      width={560}
    >
      <TextField form={form} path="mcc" label="MCC" required maxLength={3} placeholder="262" nullable={false} />
      <TextField
        form={form}
        path="mnc"
        label="MNC"
        maxLength={3}
        nullable={false}
        hint="Empty = the country's All networks code"
      />
      <TextField
        form={form}
        path="originalMnc"
        label="Original MNC"
        maxLength={10}
        hint="As the operator publishes it"
      />
      <FormField label="MCCMNC">
        <span className="num strong ro-value">{v.mcc ? codeLabel(v.mcc, v.mnc) : "—"}</span>
      </FormField>
      <FormField label="Country" required wide error={form.error("countryId")}>
        <ListLookup<Country>
          list="countries"
          value={v.countryId || null}
          onChange={(c) => form.set("countryId", c?.id ?? 0)}
          labelOf={(c) => `${c.name} (${c.iso}, +${c.dialCode})`}
          detailOf={(c) => c.region}
          placeholder="Search countries…"
          clearable={false}
        />
      </FormField>
      {v.mnc !== "" && (
        <TextField form={form} path="network" label="Code Network" required wide maxLength={120} nullable={false} />
      )}
      {row && (
        <p className="muted small wide">
          MCC and MNC are fixed once the code is in use.
        </p>
      )}
    </RecordDialog>
  );
}

const openDialog = (row: Destination | null) =>
  ask<void>((done) => <DestinationDialog row={row} done={() => done()} />);

const importCodes = () =>
  openImport({
    target: { kind: "destinations" },
    title: "MCCMNC Unique Codes Import",
    help: (
      <p>
        Columns <code>mcc</code>, <code>mnc</code> (empty = All networks), <code>original_mnc</code>,{" "}
        <code>country</code> (name; or <code>iso</code>) and <code>network</code>. Codes are matched by MCC + MNC:
        existing ones are updated, new ones added.
      </p>
    ),
    replaceHint:
      "Codes missing from the file are archived, except those still used by rates, rules, dial codes or MO numbers, which are kept and listed.",
  });

export function MccmncPage() {
  const deleteOne = useDeleteRecord();
  const { data: me } = useMe();
  const restore = useRestore("destination");
  const notifySaved = useNotifySaved();
  const isAdmin = isAdminUser(me?.permissions);
  return (
    <ListScreen<Destination>
      list="destinations"
      bulkDelete={{ noun: "MCCMNC code", restore: true }}
      page={page}
      title="MCCMNC codes"
      historyScope={{ entityTypes: ["destination"] }}
      primary={{ label: "Add code", icon: "plus", onClick: () => void openDialog(null) }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted code" : undefined,
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
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored MCCMNC ${r.mccmnc}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("destination", r.id, `MCCMNC ${r.mccmnc}`),
            },
      ]}
      actions={
        <Button icon="upload" onClick={() => void importCodes()}>
          Import
        </Button>
      }
      onExport={(s) =>
        void downloadCsv("/destinations/export", toListQuery(s)).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        mcc: { width: 70, render: (r) => <span className="num">{r.mcc}</span> },
        mnc: { width: 70, render: (r) => <span className="num">{r.mnc || <span className="muted">—</span>}</span> },
        originalMnc: { width: 110, render: (r) => <span className="num">{r.originalMnc ?? ""}</span> },
        mccmnc: {
          width: 100,
          render: (r) => <span className="num strong">{r.mccmnc}</span>,
        },
        countryIso: { width: 60 },
        country: { width: 200 },
        dialCode: { width: 110, render: (r) => <span className="num">+{r.dialCode}</span> },
        network: {
          width: 260,
          render: (r) => (r.allNetworks ? <span className="muted">All networks</span> : r.network),
        },
        allNetworks: { width: 100, render: (r) => (r.allNetworks ? "Yes" : "") },
        dlrTargetPct: { width: 120, align: "right", render: (r) => <TargetCell row={r} /> },
      }}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong className="num">{r.mccmnc}</strong>
            <span className="muted">
              {r.country} · {r.allNetworks ? "All networks" : r.network}
            </span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "Code",
            actions: (
              <RecordActions
                kind="destination"
                id={r.id}
                name={`MCCMNC ${r.mccmnc}`}
                archived={!!r.archivedAt}
                onEdit={() => void openDialog(r)}
              />
            ),
            content: (
              <dl className="kv">
                <dt>MCC / MNC</dt>
                <dd>
                  {r.mcc} / {r.mnc || "— (All networks)"}
                </dd>
                <dt>Original MNC</dt>
                <dd>{r.originalMnc ?? "—"}</dd>
                <dt>Country</dt>
                <dd>
                  {r.country} ({r.countryIso}, +{r.dialCode})
                </dd>
                <dt>DLR target</dt>
                <dd>{r.dlrTargetPct === null ? (r.allNetworks ? "none" : "the country's") : `${r.dlrTargetPct}%`}</dd>
                <dt>Updated</dt>
                <dd>
                  {r.updatedBy ?? "seed data"} · {fmtWhen(r.updatedAt)}
                </dd>
                {r.archivedAt && (
                  <>
                    <dt>State</dt>
                    <dd className="tone-warning">Deleted {fmtWhen(r.archivedAt)}</dd>
                  </>
                )}
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · click a DLR target to change it (empty removes) · Ctrl+Z undo"
    />
  );
}
