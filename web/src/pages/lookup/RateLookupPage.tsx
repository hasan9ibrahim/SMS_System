// Rate Lookup (§13.16): side by side (default since the team trial: customer and vendor rate tables
// each on a side with their own filters), easy mode (one destination, vendor costs and client rates with
// margins) and advanced mode (many destinations, point in time, comparison views).
// The mode, the destination and the lookups live in the tab URL (§13.5).
import { useCallback, useState } from "react";
import { useLocation } from "react-router";
import type { LookupDestination, RateLookupQuery } from "@sms/contract";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { usePageStatus, useTabNavigate } from "../../shell/tabContext";
import type { Picked } from "../routing/pickers";
import { AdvancedLookup, emptyQuery } from "./AdvancedLookup";
import { EasyLookup, type EasyState } from "./EasyLookup";
import { decodeQuery, encodeQuery } from "./lookupModel";
import { SideLookup } from "./SideLookup";
import { decodeSide, encodeSide, type Show, type SideState } from "./sideModel";

type Mode = "sides" | "easy" | "advanced";
const MODES: { value: Mode; label: string }[] = [
  { value: "sides", label: "Side by side" },
  { value: "easy", label: "One destination" },
  { value: "advanced", label: "Advanced" },
];
const SHOW: { value: Show; label: string }[] = [
  { value: "both", label: "Both" },
  { value: "customer", label: "Customer" },
  { value: "vendor", label: "Vendor" },
];

const page = pageForPath("/rates/rate-lookup")!;

function EasyStatus() {
  usePageStatus({
    rows: "",
    shortcuts: "Type to search · ↑↓ Enter pick a destination · click a rate to open it in Rate Manager",
  });
  return null;
}

export function RateLookupPage() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const params = new URLSearchParams(location.search);
  const rawMode = params.get("mode");
  // Tabs saved before the side-by-side view kept the easy lookup in ?t= / ?d=.
  const mode: Mode =
    rawMode === "advanced" ? "advanced" : rawMode === "easy" || params.has("t") || params.has("d") ? "easy" : "sides";
  const rawShow = params.get("show");
  const show: Show = rawShow === "customer" || rawShow === "vendor" ? rawShow : "both";
  const customerSide = decodeSide(params.get("c"));
  const vendorSide = decodeSide(params.get("v"));
  // Names of records picked in the advanced filters (the URL keeps only their IDs).
  const [names, setNamesState] = useState<Record<string, Picked<number>[]>>({});
  const setNames = useCallback((key: string, v: Picked<number>[]) => setNamesState((n) => ({ ...n, [key]: v })), []);

  const write = (next: URLSearchParams) => {
    const qs = next.toString();
    navigate(`${location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
  };
  const flag = (k: string) => params.get(k) === "1";
  const easy: EasyState = {
    text: params.get("t") ?? "",
    mccmnc: params.get("d"),
    live: flag("live"),
    mine: flag("mine"),
    inactive: flag("inactive"),
    scheduled: params.get("sched") !== "0",
    converted: params.get("cur") === "usd",
  };
  const setEasy = (patch: Partial<EasyState>) => {
    const s = { ...easy, ...patch };
    const p = new URLSearchParams(location.search);
    const put = (k: string, v: string | null) => (v ? p.set(k, v) : p.delete(k));
    put("t", s.text || null);
    put("d", s.mccmnc);
    put("live", s.live ? "1" : null);
    put("mine", s.mine ? "1" : null);
    put("inactive", s.inactive ? "1" : null);
    put("sched", s.scheduled ? null : "0");
    put("cur", s.converted ? "usd" : null);
    write(p);
  };
  const applied = decodeQuery(params.get("q"));
  const apply = (q: RateLookupQuery | null) => {
    const p = new URLSearchParams(location.search);
    if (q) p.set("q", encodeQuery(q));
    else p.delete("q");
    write(p);
  };
  const setSide = (key: "c" | "v", st: SideState) => {
    const p = new URLSearchParams(location.search);
    const v = encodeSide(st);
    if (v) p.set(key, v);
    else p.delete(key);
    write(p);
  };
  const setShow = (v: Show) => {
    const p = new URLSearchParams(location.search);
    if (v === "both") p.delete("show");
    else p.set("show", v);
    write(p);
  };
  const setMode = (m: Mode, q?: RateLookupQuery) => {
    const p = new URLSearchParams(location.search);
    if (m === "sides") p.delete("mode");
    else p.set("mode", m);
    if (m !== "easy") {
      p.delete("t");
      p.delete("d");
    }
    if (q) p.set("q", encodeQuery(q));
    write(p);
  };
  const compareCountry = (d: LookupDestination) =>
    setMode("advanced", { ...emptyQuery(), mccmncs: [d.mcc], view: "vendor_costs" });

  return (
    <div className="page lk-page">
      <PageHeader
        page={page}
        actions={
          <>
            {mode === "sides" && (
              <div className="segmented" role="radiogroup" aria-label="Show">
                {SHOW.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={show === o.value}
                    className={show === o.value ? "on" : ""}
                    onClick={() => setShow(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            <div className="segmented" role="radiogroup" aria-label="Mode">
              {MODES.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === o.value}
                  className={mode === o.value ? "on" : ""}
                  onClick={() => setMode(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>
        }
      />
      {mode === "sides" ? (
        <SideLookup
          show={show}
          customer={customerSide}
          vendor={vendorSide}
          setCustomer={(st) => setSide("c", st)}
          setVendor={(st) => setSide("v", st)}
        />
      ) : mode === "easy" ? (
        <>
          <EasyStatus />
          <EasyLookup state={easy} setState={setEasy} onAdvanced={compareCountry} />
        </>
      ) : (
        <AdvancedLookup
          key={params.get("q") === null ? "empty" : "set"}
          applied={applied}
          apply={apply}
          names={names}
          setNames={setNames}
        />
      )}
    </div>
  );
}
