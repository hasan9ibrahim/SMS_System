// One box for a margin (team trial round 1): "0.002" is an amount in the platform currency, "5%" a
// percentage of the sell rate, and a minus sign makes either negative.
import { useState } from "react";
import { formatMargin, parseMargin } from "./ruleModel";

export interface MarginValue {
  value: number | null;
  type: "amount" | "percent";
}

export function MarginInput({
  label,
  value,
  type,
  onChange,
  onValid,
  optional = false,
}: {
  label: string;
  value: number | null | undefined;
  type: string | null | undefined;
  onChange: (m: MarginValue) => void;
  /** Told whether the box holds something readable, so a form can block saving. */
  onValid?: (ok: boolean) => void;
  /** Empty means no margin (null) rather than 0. */
  optional?: boolean;
}) {
  const [text, setText] = useState(formatMargin(value, type));
  const parsed = parseMargin(text);
  const ok = parsed !== null;
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={text}
        aria-invalid={!ok}
        placeholder={optional ? "none, 0.002 or 5%" : "0.002 or 5%"}
        onChange={(e) => {
          setText(e.target.value);
          const m = parseMargin(e.target.value);
          onValid?.(m !== null);
          if (!m) return;
          onChange(optional && e.target.value.trim() === "" ? { value: null, type: m.type } : m);
        }}
      />
      <small className={ok ? "muted" : "tone-error"}>
        {ok
          ? "Amount in the platform currency, or % of the sell rate; - for negative"
          : "A number, with % for a percentage (e.g. 0.002, 5%, -1%)"}
      </small>
    </label>
  );
}
