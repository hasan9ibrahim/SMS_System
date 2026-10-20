// Live connection of a trunk in the trunk lists (team trial round 2): green up, amber reconnecting (vendor
// binds the switch is retrying), red down. "State" (active / inactive) is the separate status column.
import type { TrunkListRow } from "@sms/contract";
import type { ColumnOverride } from "../../grid/DataGrid";
import { StatusDot } from "../../ui/primitives";

const LOOK: Record<TrunkListRow["connection"], { tone: "good" | "warning" | "error"; label: string }> = {
  up: { tone: "good", label: "Up" },
  reconnecting: { tone: "warning", label: "Reconnecting" },
  down: { tone: "error", label: "Down" },
};

export const connectionColumn: ColumnOverride<TrunkListRow> = {
  width: 130,
  render: (r) => {
    const l = LOOK[r.connection] ?? LOOK.down;
    return (
      <span className="conn-cell">
        <StatusDot tone={l.tone} label={l.label} /> {l.label}
      </span>
    );
  },
};
