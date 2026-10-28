// Sender ID / receiver values as rows (team trial round 8, §6.3, §6.4): each value can be edited and has its own
// match (is / starts with / contains) and, for Sender IDs, its own Case sensitive, like the content rewrite words.
import type { ValueMatch } from "@sms/contract";
import { Button } from "../../ui/primitives";
import { VALUE_MATCHES } from "./ruleModel";

export function ValueRows({
  value,
  onChange,
  noun,
  showCase,
}: {
  value: ValueMatch[];
  onChange: (v: ValueMatch[]) => void;
  /** "Sender ID" or "Receiver". */
  noun: string;
  /** Receivers are numbers: no case to match. */
  showCase: boolean;
}) {
  const patch = (i: number, p: Partial<ValueMatch>) => onChange(value.map((r, j) => (j === i ? { ...r, ...p } : r)));
  // A new row copies the match and case of the last one.
  const blank = (v = ""): ValueMatch => ({
    value: v,
    match: value.at(-1)?.match ?? "is",
    matchCase: showCase ? (value.at(-1)?.matchCase ?? true) : false,
  });
  return (
    <div className="dlr-map value-rows">
      {value.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>{noun}</th>
              <th>Match</th>
              {showCase && <th>Case sensitive</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {value.map((r, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={r.value}
                    maxLength={100}
                    autoFocus={i === value.length - 1 && r.value === ""}
                    placeholder={showCase ? "e.g. BANK" : "e.g. 4479"}
                    aria-label={noun}
                    onChange={(e) => patch(i, { value: e.target.value })}
                    // A pasted list (one per line, or comma separated) becomes one row each.
                    onPaste={(e) => {
                      const parts = e.clipboardData
                        .getData("text")
                        .split(/[\n,;]/)
                        .map((x) => x.trim())
                        .filter(Boolean);
                      if (parts.length < 2) return;
                      e.preventDefault();
                      const rows = parts.map((v) => ({ ...r, value: v }));
                      onChange([...value.slice(0, i), ...rows, ...value.slice(i + 1)].slice(0, 500));
                    }}
                  />
                </td>
                <td>
                  <select
                    value={r.match}
                    aria-label="Match"
                    onChange={(e) => patch(i, { match: e.target.value as ValueMatch["match"] })}
                  >
                    {VALUE_MATCHES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </td>
                {showCase && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label="Case sensitive"
                      checked={r.matchCase}
                      onChange={(e) => patch(i, { matchCase: e.target.checked })}
                    />
                  </td>
                )}
                <td>
                  <Button
                    small
                    variant="ghost"
                    icon="x"
                    aria-label="Remove"
                    onClick={() => onChange(value.filter((__, j) => j !== i))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Button small icon="plus" disabled={value.length >= 500} onClick={() => onChange([...value, blank()])}>
        Add {noun}
      </Button>
    </div>
  );
}
