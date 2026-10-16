// Rate Lookup (§13.16): easy mode (one search box, vendor costs and client rates side by
// side) and advanced mode (many destinations, filters, point in time, comparison views).
// The mode, the destination and the advanced lookup live in the tab URL (§13.5).
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

const page = pageForPath("/routing/rate-lookup")!;

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
  const mode = params.get("mode") === "advanced" ? "advanced" : "easy";
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
  const setMode = (m: "easy" | "advanced", q?: RateLookupQuery) => {
    const p = new URLSearchParams(location.search);
    if (m === "advanced") p.set("mode", "advanced");
    else p.delete("mode");
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
          <div className="segmented" role="radiogroup" aria-label="Mode">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "easy"}
              className={mode === "easy" ? "on" : ""}
              onClick={() => setMode("easy")}
            >
              Easy
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "advanced"}
              className={mode === "advanced" ? "on" : ""}
              onClick={() => setMode("advanced")}
            >
              Advanced
            </button>
          </div>
        }
      />
      {mode === "easy" ? (
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
