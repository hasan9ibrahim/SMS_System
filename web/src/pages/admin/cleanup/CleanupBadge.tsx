// Small badge on the rules pages (§13.19): open Cleanup Center findings for these kinds, opening
// the Cleanup Center filtered on them.
import { useCleanupSummary } from "../../../api/cleanup";
import { useTabNavigate } from "../../../shell/tabContext";
import { Button } from "../../../ui/primitives";
import { cleanupUrl } from "./cleanupModel";

export function CleanupBadge({ kinds }: { kinds: string[] }) {
  const s = useCleanupSummary();
  const navigate = useTabNavigate();
  const found = (s.data?.byKind ?? []).filter((k) => kinds.includes(k.kind));
  const n = found.reduce((a, k) => a + k.open, 0);
  if (!n) return null;
  return (
    <Button
      icon="sparkles"
      title={found.map((k) => `${k.open} × ${k.kindLabel}`).join("\n")}
      onClick={() => navigate(cleanupUrl({ kinds }), { newTab: true, title: "Cleanup center" })}
    >
      Cleanup <span className="chip-mini tone-warning">{n.toLocaleString("en-US")}</span>
    </Button>
  );
}
