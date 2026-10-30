// CSV cells that are safe to open in a spreadsheet (security audit, team trial round 12): message text, sender IDs and
// names come from outside, and a cell that starts like a formula (=, +, -, @, tab, CR) would run in Excel. Such a cell
// gets a leading apostrophe, so it shows as text. Numbers, negative ones included, stay numbers.
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

export function csvText(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) && !NUMBER.test(s) ? `'${s}` : s;
}

/** The ClickHouse expression of the same rule for a text column of a CSV export. */
export const csvTextSql = (expr: string) =>
  `if(match(toString(${expr}), '^[=+@\\t\\r-]') AND NOT match(toString(${expr}), '^[-+]?[0-9.]+([eE][-+]?[0-9]+)?$'), concat('\\'', toString(${expr})), toString(${expr}))`;
