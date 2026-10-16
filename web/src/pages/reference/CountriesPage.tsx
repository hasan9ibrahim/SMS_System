// Countries (§6.1): name, ISO code, dial code and the destination picker's region (§13.21).
// Countries hold the MCCMNC codes, so they are added and changed but not deleted. Export
// gives the filtered list as CSV.
import { useState } from "react";
import type { Country, CountryInput } from "@sms/contract";
import { useListFields } from "../../api/hooks";
import { downloadCsv, useSaveCountry } from "../../api/masterData";
import { emptyState, encodeState, toListQuery } from "../../grid/filterModel";
import { SelectField, TextField, useForm } from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { problemText } from "../routing/dialogs";
import { fmtWhen, RecordActions, RecordDialog } from "./shared";

const page = pageForPath("/rates/countries")!;

/** Grid state for the MCCMNC page filtered to one country. */
const countryFilter = (name: string) =>
  encodeState({ ...emptyState(), columns: { country: { field: "country", op: "eq", value: name } } });

function CountryDialog({ row, regions, done }: { row: Country | null; regions: string[]; done: () => void }) {
  const form = useForm<CountryInput>({
    name: row?.name ?? "",
    iso: row?.iso ?? "",
    dialCode: row?.dialCode ?? "",
    region: row?.region ?? "",
  });
  const save = useSaveCountry();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    save.mutate(
      { id: row?.id ?? null, input: { ...form.values, iso: form.values.iso.toUpperCase() } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, row ? `Saved ${r.record.name}` : `Added ${r.record.name}`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  return (
    <RecordDialog
      title={row ? `Edit ${row.name}` : "Add country"}
      saveLabel={row ? "Save" : "Add country"}
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={done}
    >
      <TextField form={form} path="name" label="Name" required maxLength={80} wide nullable={false} />
      <TextField form={form} path="iso" label="ISO" required maxLength={2} placeholder="DE" nullable={false} />
      <TextField
        form={form}
        path="dialCode"
        label="Dial Code"
        required
        maxLength={4}
        placeholder="49"
        nullable={false}
      />
      <SelectField
        form={form}
        path="region"
        label="Region"
        required
        wide
        hint="Region set in the destination picker (§13.21)"
        options={regions.map((r) => ({ value: r, label: r }))}
      />
    </RecordDialog>
  );
}

export function CountriesPage() {
  const fields = useListFields("countries");
  const navigate = useTabNavigate();
  const regions = fields.data?.fields.find((f) => f.field === "region")?.enumValues?.map((v) => v.value) ?? [];
  const openDialog = (row: Country | null) =>
    ask<void>((done) => <CountryDialog row={row} regions={regions} done={() => done()} />);
  return (
    <ListScreen<Country>
      list="countries"
      page={page}
      historyScope={{ entityTypes: ["country"] }}
      primary={{ label: "Add country", icon: "plus", onClick: () => void openDialog(null) }}
      onExport={(s) =>
        void downloadCsv("/countries/export", toListQuery(s)).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        id: { width: 80 },
        name: { width: 240, render: (r) => <strong>{r.name}</strong> },
        iso: { width: 90 },
        dialCode: { width: 100, render: (r) => <span className="num">+{r.dialCode}</span> },
        region: { width: 200 },
        networks: { width: 120, align: "right" },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? <span className="muted">—</span> },
      }}
      onOpen={(r) => void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.iso} · +{r.dialCode}
            </span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "Country",
            actions: (
              <RecordActions
                kind="destination"
                id={r.id}
                name={r.name}
                archived={false}
                canDelete={false}
                onEdit={() => void openDialog(r)}
              />
            ),
            content: (
              <dl className="kv">
                <dt>Region</dt>
                <dd>{r.region}</dd>
                <dt>MCCMNC codes</dt>
                <dd>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      navigate(`/rates/mccmnc?g=${countryFilter(r.name)}`, {
                        newTab: true,
                        title: `MCCMNC · ${r.name}`,
                      })
                    }
                  >
                    {r.networks} codes
                  </button>
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
      shortcuts="↑↓ move · Enter or double-click edits · Ctrl+Z undo"
    />
  );
}
