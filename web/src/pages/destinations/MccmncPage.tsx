// MCCMNC codes (§6.1, §13.21): the destination master list. In this build it carries the
// DLR target per destination (decided 2026-10-16): route rules sending here show their DLR in
// amber below it (§15.4). A country-level code covers its networks unless a network has its
// own. Adding and editing codes comes with the master-data screens (build step 5).
import { useState } from "react";
import type { Destination } from "@sms/contract";
import { useSetDlrTarget } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { toast } from "../../ui/feedback";
import { problemText } from "../routing/dialogs";

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

export function MccmncPage() {
  return (
    <ListScreen<Destination>
      list="destinations"
      page={page}
      title="MCCMNC codes"
      historyScope={{ entityTypes: ["destination"] }}
      columns={{
        mccmnc: {
          width: 100,
          render: (r) => <span className="num strong">{r.allNetworks ? `${r.mccmnc} · all` : r.mccmnc}</span>,
        },
        country: { width: 220 },
        countryIso: { width: 70 },
        network: {
          width: 280,
          render: (r) => (r.allNetworks ? <span className="muted">All networks</span> : r.network),
        },
        allNetworks: { width: 110, render: (r) => (r.allNetworks ? "Yes" : "") },
        dlrTargetPct: { width: 130, align: "right", render: (r) => <TargetCell row={r} /> },
      }}
      shortcuts="↑↓ move · click a DLR target to change it (Enter saves, empty removes) · Ctrl+Z undo"
    />
  );
}
