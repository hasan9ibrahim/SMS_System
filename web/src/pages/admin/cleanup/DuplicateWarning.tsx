// Duplicate warning on save (§13.20): while a record is edited, asks the server whether an existing one
// looks the same, and offers to open it instead of creating a near-copy.
import { useEffect, useState } from "react";
import type { DuplicateCheck, DuplicateMatch } from "@sms/contract";
import { checkDuplicate } from "../../../api/cleanup";
import { useTabNavigate } from "../../../shell/tabContext";

export function DuplicateWarning({ check, what }: { check: DuplicateCheck | null; what: string }) {
  const [matches, setMatches] = useState<DuplicateMatch[]>([]);
  const navigate = useTabNavigate();
  const key = JSON.stringify(check);
  useEffect(() => {
    if (!check) return setMatches([]);
    const t = setTimeout(
      () =>
        void checkDuplicate(check)
          .then((r) => setMatches(r.matches))
          .catch(() => setMatches([])),
      600,
    );
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!matches.length) return null;
  return (
    <div className="dup-warning" role="status">
      <strong>
        Possible duplicate {what}
        {matches.length > 1 ? "s" : ""}:
      </strong>{" "}
      {matches.slice(0, 3).map((m, i) => (
        <span key={m.id}>
          {i > 0 && ", "}
          <button type="button" className="link" onClick={() => navigate(m.path, { newTab: true })}>
            {m.name}
          </button>{" "}
          <span className="muted small">({m.reason})</span>
        </span>
      ))}
      <span className="muted small"> — use or edit the existing one instead of a copy.</span>
    </div>
  );
}
