// HLR (§6.5, §13.24): one page with three views kept in the tab URL (?view=): Providers (with
// their per-destination prices, ?provider=<id>), Rules (provider + DNID pattern applied straight
// to customer trunks, §13.2) and Policies (per destination, which providers in which order, and
// cache times; route rules use them in their HLR action).
import { useLocation } from "react-router";
import { useTabNavigate } from "../../../shell/tabContext";
import { PoliciesView } from "./PoliciesView";
import { ProvidersView } from "./ProvidersView";
import { RulesView } from "./RulesView";

export type HlrView = "providers" | "rules" | "policies";
const VIEWS: { key: HlrView; label: string }[] = [
  { key: "providers", label: "Providers" },
  { key: "rules", label: "Rules" },
  { key: "policies", label: "Policies" },
];

export function useHlrNav() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const params = new URLSearchParams(location.search);
  const raw = params.get("view");
  const view: HlrView = raw === "rules" || raw === "policies" ? raw : "providers";
  const provider = params.get("provider");
  return {
    view,
    providerId: provider ? Number(provider) : null,
    go: (next: HlrView, extra = "") => navigate(`/switch/hlr?view=${next}${extra}`, { replace: false }),
  };
}

/** The Providers / Rules / Policies switch shown above each grid. */
export function ViewSwitch() {
  const { view, go } = useHlrNav();
  return (
    <div className="rm-trunk">
      <div className="segmented small" role="radiogroup" aria-label="HLR view">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="radio"
            aria-checked={view === v.key}
            className={view === v.key ? "on" : ""}
            onClick={() => go(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function HlrPage() {
  const { view } = useHlrNav();
  if (view === "rules") return <RulesView />;
  if (view === "policies") return <PoliciesView />;
  return <ProvidersView />;
}
