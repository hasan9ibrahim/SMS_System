// Reconciliation rule evaluation (§13.31), kept free of I/O so it can be unit-tested. A partner's
// figures match ours when the amount, and the message count when the invoice has one, are within
// tolerance; an optional per-destination check flags any destination off by more than X %.
import type { ReconRuleValues } from "@sms/contract";

export interface ReconFigures {
  theirAmount: number;
  ourAmount: number;
  theirVolume: number | null;
  ourVolume: number;
  currency: string;
}

export interface DestinationFigure {
  mccmnc: string;
  theirAmount: number | null;
  ourAmount: number;
}

const fmt = (v: number, digits = 2) =>
  v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (v: number, digits = 2) => `${v >= 0 ? "+" : "−"}${fmt(Math.abs(v), digits)}`;

/** Within tolerance by percentage and/or fixed amount, combined stricter (both) or looser (either). */
export function withinTolerance(
  diff: number,
  base: number,
  pct: number | null,
  fixed: number | null,
  combine: "stricter" | "looser",
): boolean {
  const d = Math.abs(diff);
  const byPct = pct === null ? null : base > 0 ? (d / base) * 100 <= pct + 1e-9 : d === 0;
  const byFixed = fixed === null ? null : d <= fixed + 1e-9;
  if (byPct === null && byFixed === null) return true;
  if (byPct === null) return byFixed!;
  if (byFixed === null) return byPct;
  return combine === "stricter" ? byPct && byFixed : byPct || byFixed;
}

export function toleranceText(pct: number | null, fixed: number | null, combine: string, unit: string): string {
  const parts = [
    pct !== null ? `${fmt(pct, pct % 1 ? 1 : 0)} %` : null,
    fixed !== null ? `${fmt(fixed, unit === "messages" ? 0 : 2)} ${unit}` : null,
  ].filter(Boolean);
  if (!parts.length) return "no tolerance check";
  return parts.length === 2 ? `${parts.join(combine === "stricter" ? " and " : " or ")}` : parts[0]!;
}

/** Destinations off by more than the rule's per-destination share (both directions). */
export function flaggedDestinations(rule: ReconRuleValues, lines: DestinationFigure[]): Set<string> {
  const out = new Set<string>();
  if (rule.destinationPct === null) return out;
  for (const l of lines) {
    if (l.theirAmount === null) continue;
    const diff = Math.abs(l.theirAmount - l.ourAmount);
    const off = l.ourAmount > 0 ? (diff / l.ourAmount) * 100 > rule.destinationPct + 1e-9 : diff > 0.005;
    if (off) out.add(l.mccmnc);
  }
  return out;
}

/** Compares their figures with ours under a rule; returns the result and one reason per check. */
export function evaluateRecon(
  rule: ReconRuleValues,
  f: ReconFigures,
  lines: DestinationFigure[] = [],
): { match: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const diff = f.theirAmount - f.ourAmount;
  const pct = f.ourAmount > 0 ? (diff / f.ourAmount) * 100 : null;
  const amountOk = withinTolerance(diff, f.ourAmount, rule.amountPct, rule.amountFixed, rule.amountCombine);
  reasons.push(
    `Amount ${amountOk ? "within" : "outside"} tolerance (${toleranceText(rule.amountPct, rule.amountFixed, rule.amountCombine, f.currency)}): ` +
      `theirs ${fmt(f.theirAmount)}, ours ${fmt(f.ourAmount)}, ${signed(diff)} ${f.currency}${pct === null ? "" : ` (${signed(pct)} %)`}`,
  );
  let countOk = true;
  if (f.theirVolume === null) reasons.push("Message count: not on the invoice, not checked");
  else {
    const vd = f.theirVolume - f.ourVolume;
    countOk = withinTolerance(vd, f.ourVolume, rule.countPct, rule.countFixed, rule.countCombine);
    reasons.push(
      `Message count ${countOk ? "within" : "outside"} tolerance (${toleranceText(rule.countPct, rule.countFixed, rule.countCombine, "messages")}): ` +
        `theirs ${fmt(f.theirVolume, 0)}, ours ${fmt(f.ourVolume, 0)}, ${signed(vd, 0)}`,
    );
  }
  let destOk = true;
  if (rule.destinationPct !== null) {
    const withLines = lines.filter((l) => l.theirAmount !== null);
    if (!withLines.length) reasons.push("Per-destination check: the invoice has no destination lines");
    else {
      const flagged = flaggedDestinations(rule, withLines);
      destOk = flagged.size === 0;
      reasons.push(
        destOk
          ? `Every destination within ${fmt(rule.destinationPct, rule.destinationPct % 1 ? 1 : 0)} %`
          : `${flagged.size} destination${flagged.size === 1 ? "" : "s"} off by more than ${fmt(rule.destinationPct, rule.destinationPct % 1 ? 1 : 0)} %: ${[...flagged].slice(0, 5).join(", ")}${flagged.size > 5 ? "…" : ""}`,
      );
    }
  }
  return { match: amountOk && countOk && destOk, reasons };
}
