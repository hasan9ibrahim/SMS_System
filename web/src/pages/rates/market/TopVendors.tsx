// Hand-picked top vendors per destination for market moves (team trial round 5, §13.14). Instead of the cheapest N,
// a destination can list the vendor trunks that count, with or without the Tier 1 vendors. Destinations without a
// list follow the settings (cheapest N, or not watched).
import { useState } from "react";
import type { MarketTopVendor, MarketTopVendorRow } from "@sms/contract";
import { useRemoveTopVendors, useSaveTopVendors, useTopVendorCandidates, useTopVendorList } from "../../../api/market";
import { api, unwrap } from "../../../api/client";
import { ask, toast } from "../../../ui/feedback";
import { Icon } from "../../../ui/Icon";
import { Button, Modal } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { RuleCodesDialog } from "../DestinationTree";
import { formatRate } from "../format";

const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
const TIER = { tier1: "Tier 1", tier2: "Tier 2", tier3: "Tier 3" } as const;
const destName = (r: { country: string | null; network: string | null; mccmnc: string }) =>
  `${r.country ?? "—"} · ${r.network ?? "All networks"} (${r.mccmnc})`;

interface Draft {
  mccmncs: string[];
  vendors: MarketTopVendor[];
  includeTier1: boolean;
}

/** Pick the destinations, tick their top vendor trunks and choose whether Tier 1 vendors count too. */
function EditDialog({ initial, done }: { initial: Draft; done: (saved: boolean) => void }) {
  const save = useSaveTopVendors();
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [find, setFind] = useState("");
  // Vendor trunks pricing the first destination, cheapest first, as the checklist.
  const cand = useTopVendorCandidates(d.mccmncs[0] ?? null);
  const picked = new Set(d.vendors.map((v) => v.vendorTrunkId));
  const toggle = (v: MarketTopVendor) =>
    setD({
      ...d,
      vendors: picked.has(v.vendorTrunkId)
        ? d.vendors.filter((x) => x.vendorTrunkId !== v.vendorTrunkId)
        : [...d.vendors, v],
    });
  const listed = new Set((cand.data?.vendors ?? []).map((v) => v.vendorTrunkId));
  // Search the checklist: trunk or vendor name, starts with (a word inside with %), like every search box.
  const needle = find.trim().toLowerCase();
  const matches = (v: MarketTopVendor) =>
    !needle ||
    [v.vendorTrunk, v.vendor].some((x) =>
      needle.startsWith("%") ? x.toLowerCase().includes(needle.slice(1)) : x.toLowerCase().startsWith(needle),
    );
  const extra = d.vendors.filter((v) => !listed.has(v.vendorTrunkId));
  const submit = () => {
    setError(null);
    save.mutate(
      { mccmncs: d.mccmncs, vendorTrunkIds: d.vendors.map((v) => v.vendorTrunkId), includeTier1: d.includeTier1 },
      {
        onSuccess: (r) => {
          toast({ tone: "good", message: `Top vendors saved for ${r.sent} destination${r.sent === 1 ? "" : "s"}` });
          done(true);
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  };
  return (
    <Modal
      title="Top vendors"
      width={680}
      onClose={() => done(false)}
      footer={
        <>
          <span className="muted small fb-spacer">
            {d.vendors.length} vendor trunk{d.vendors.length === 1 ? "" : "s"}
            {d.includeTier1 ? " + Tier 1 vendors" : ""} · {d.mccmncs.length} destination
            {d.mccmncs.length === 1 ? "" : "s"}
          </span>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!d.mccmncs.length || (!d.vendors.length && !d.includeTier1) || save.isPending}
            onClick={submit}
          >
            Save
          </Button>
        </>
      }
    >
      <h3 className="part-title">Destinations</h3>
      <div className="bulk-row">
        <span className="small">
          {d.mccmncs.length === 0
            ? "None yet."
            : d.mccmncs.length <= 6
              ? d.mccmncs.join(", ")
              : `${d.mccmncs.slice(0, 6).join(", ")} +${d.mccmncs.length - 6}`}
        </span>
        <Button
          small
          icon="globe"
          onClick={async () => {
            const codes = await ask<string[]>((close) => <RuleCodesDialog initial={d.mccmncs} done={close} />);
            if (codes) setD({ ...d, mccmncs: codes });
          }}
        >
          {d.mccmncs.length ? "Change…" : "Pick countries and networks…"}
        </Button>
      </div>
      <h3 className="part-title">Vendor trunks that count</h3>
      {d.mccmncs.length > 1 && (
        <p className="muted small">
          The list shows the vendor trunks pricing {d.mccmncs[0]}; the same choice is saved for every destination.
        </p>
      )}
      <input
        type="search"
        placeholder="Search vendor trunks or vendors…"
        value={find}
        onChange={(e) => setFind(e.target.value)}
        aria-label="Search vendor trunks"
      />
      <div className="pick-list top-vendor-list">
        {!d.mccmncs.length && <p className="muted small pad">Pick the destinations first.</p>}
        {cand.isLoading && <p className="muted small pad">Loading…</p>}
        {(cand.data?.vendors ?? []).map((v, i) =>
          !matches(v) ? null : (
            <label key={v.vendorTrunkId} className="choice-row">
              <input type="checkbox" checked={picked.has(v.vendorTrunkId)} onChange={() => toggle(v)} />
              <span>
                <span className="muted small num">{i + 1}.</span> {v.vendorTrunk}{" "}
                {v.tier === "tier1" && <span className="chip-tag blue">Tier 1</span>}
              </span>
              <span className="muted small num">
                {v.vendor} · {formatRate(v.rateEur)} EUR
              </span>
            </label>
          ),
        )}
        {needle && cand.isSuccess && !cand.data.vendors.some(matches) && (
          <p className="muted small pad">No vendor trunk matches.</p>
        )}
        {cand.isSuccess && !cand.data.vendors.length && (
          <p className="muted small pad">No live vendor trunk prices {d.mccmncs[0]}.</p>
        )}
      </div>
      {extra.length > 0 && (
        <div className="chips">
          {extra.map((v) => (
            <span key={v.vendorTrunkId} className="chip">
              {v.vendorTrunk}
              <button type="button" aria-label={`Remove ${v.vendorTrunk}`} onClick={() => toggle(v)}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <label className="toggle-inline">
        <input
          type="checkbox"
          checked={d.includeTier1}
          onChange={(e) => setD({ ...d, includeTier1: e.target.checked })}
        />
        Tier 1 vendors pricing the destination count too
      </label>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

/** Opens the editor; resolves true when saved. */
export function editTopVendors(initial?: Partial<Draft>) {
  return ask<boolean>((done) => (
    <EditDialog initial={{ mccmncs: [], vendors: [], includeTier1: true, ...initial }} done={(saved) => done(saved)} />
  ));
}

/** Edit one destination's list (from a move): starts from its saved list, or empty with Tier 1 ticked. */
export async function editTopVendorsFor(mccmnc: string) {
  const page = await unwrap(
    api.GET("/market-moves/top-vendors", { params: { query: { search: mccmnc, limit: 50 } } }),
  ).catch(() => null);
  const row = page?.rows.find((r) => r.mccmnc === mccmnc);
  return editTopVendors(
    row ? { mccmncs: [mccmnc], vendors: row.vendors, includeTier1: row.includeTier1 } : { mccmncs: [mccmnc] },
  );
}

/** The destinations with a hand-picked list: search, edit, remove, add. */
function TopVendorsDialog({ done }: { done: () => void }) {
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const q = useTopVendorList(search.trim(), limit);
  const remove = useRemoveTopVendors();
  const rows = q.data?.rows ?? [];
  const edit = (r: MarketTopVendorRow) =>
    void editTopVendors({ mccmncs: [r.mccmnc], vendors: r.vendors, includeTier1: r.includeTier1 });
  return (
    <Modal
      title="Top vendors per destination"
      width={860}
      onClose={done}
      footer={
        <>
          <span className="muted small fb-spacer">
            Destinations not listed use the settings (cheapest N, or not watched).
          </span>
          <Button onClick={done}>Close</Button>
          <Button variant="primary" icon="plus" onClick={() => void editTopVendors()}>
            Add destinations…
          </Button>
        </>
      }
    >
      <div className="bulk-row">
        <input
          type="search"
          placeholder="Country, network or MCCMNC (starts with)…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search destinations"
        />
        <span className="muted small">
          {q.data ? `${q.data.total.toLocaleString("en-US")} destination${q.data.total === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <div className="mm-table-wrap">
        <table className="rtable">
          <thead>
            <tr>
              <th>Destination</th>
              <th>Top vendors</th>
              <th>Tier 1</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.mccmnc}>
                <td className="strong">{destName(r)}</td>
                <td>
                  <span className="tag-row">
                    {r.vendors.map((v) => (
                      <span key={v.vendorTrunkId} className="chip-tag" title={v.vendor}>
                        {v.vendorTrunk}
                        {v.tier ? ` · ${TIER[v.tier]}` : ""}
                      </span>
                    ))}
                    {!r.vendors.length && <span className="muted small">Tier 1 only</span>}
                  </span>
                </td>
                <td>{r.includeTier1 ? "Counted" : <span className="muted">No</span>}</td>
                <td className="muted small">{r.updatedBy ?? "—"}</td>
                <td className="num">
                  <Button small variant="ghost" onClick={() => edit(r)}>
                    Edit
                  </Button>
                  <Button
                    small
                    variant="ghost"
                    title="Go back to the default rule"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate([r.mccmnc], { onError: fail })}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.isSuccess && !rows.length && (
          <p className="muted small pad">
            {search ? "No destination matches." : "No destination has a hand-picked list yet."}
          </p>
        )}
        {q.data && q.data.total > rows.length && (
          <Button small onClick={() => setLimit(limit + 500)}>
            Show more
          </Button>
        )}
      </div>
    </Modal>
  );
}

export const openTopVendors = () => ask<void>((done) => <TopVendorsDialog done={() => done(undefined)} />);
