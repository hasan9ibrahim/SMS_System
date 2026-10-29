// Migration Center (§13.22): pure helpers for the page — views, form checks, report totals and labels.
import type {
  MigrationConflict,
  MigrationEntityReport,
  MigrationExportInput,
  MigrationImport,
  MigrationImportEntity,
  MigrationSensitivity,
} from "@sms/contract";

export const VIEWS = [
  { key: "imports", label: "Imports" },
  { key: "exports", label: "Exports" },
  { key: "mappings", label: "Column mappings" },
] as const;
export type MigrationView = (typeof VIEWS)[number]["key"];
export const isView = (v: string | null): v is MigrationView => VIEWS.some((x) => x.key === v);

export const SENSITIVITY: Record<MigrationSensitivity, string> = {
  general: "General",
  business: "Business",
  financial: "Financial",
  credentials: "Credentials",
};
export const sensitivityTone = (s: MigrationSensitivity) =>
  s === "credentials" ? "error" : s === "financial" ? "warning" : "neutral";

export const CONFLICTS: { value: MigrationConflict; label: string }[] = [
  { value: "skip", label: "Skip" },
  { value: "update", label: "Update" },
  { value: "create", label: "Add new" },
];

export const STATUS: Record<
  MigrationImport["status"],
  { label: string; tone: "good" | "warning" | "error" | "neutral" }
> = {
  validated: { label: "Dry run", tone: "warning" },
  applying: { label: "Applying…", tone: "warning" },
  applied: { label: "Applied", tone: "good" },
  rolled_back: { label: "Rolled back", tone: "neutral" },
  failed: { label: "Failed", tone: "error" },
};

export const MIN_PASSWORD = 12;

export interface ExportDraft extends MigrationExportInput {
  confirm: string;
}
export const blankExport = (): ExportDraft => ({
  includeCredentials: false,
  withPasswords: false,
  rateLines: "current",
  password: "",
  confirm: "",
  totpCode: "",
});
/** Problems that keep Export disabled, in the order the form shows the fields. */
export function exportProblems(d: ExportDraft): string[] {
  const out: string[] = [];
  if (d.password.length < MIN_PASSWORD) out.push(`The package password needs at least ${MIN_PASSWORD} characters`);
  else if (d.password !== d.confirm) out.push("The two passwords differ");
  if (d.withPasswords && !d.includeCredentials) out.push("Passwords go only with credentials included");
  if (d.includeCredentials && !/^\d{6}$/.test(d.totpCode ?? "")) out.push("Credentials need your 6-digit 2FA code");
  return out;
}
export const exportInput = (d: ExportDraft): MigrationExportInput => ({
  includeCredentials: d.includeCredentials,
  withPasswords: d.includeCredentials && d.withPasswords,
  rateLines: d.rateLines,
  password: d.password,
  totpCode: d.includeCredentials ? d.totpCode : null,
});

/** Columns that hold connection details or passwords: the file then needs a 2FA code to import. */
const CREDENTIAL_HEADERS = /^(system id|username|password|host|host ip|hostips|port)$/i;
export function headerHasCredentials(content: string): boolean {
  const first = content.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const delim = first.includes("\t") ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
  return first.split(delim).some((h) => CREDENTIAL_HEADERS.test(h.replace(/^"|"$/g, "").trim()));
}

export interface ReportTotals {
  rows: number;
  create: number;
  update: number;
  skip: number;
  errors: number;
}
export function reportTotals(entities: MigrationEntityReport[]): ReportTotals {
  return entities.reduce(
    (t, e) => ({
      rows: t.rows + e.rows,
      create: t.create + e.create,
      update: t.update + e.update,
      skip: t.skip + e.skip,
      errors: t.errors + e.errors,
    }),
    { rows: 0, create: 0, update: 0, skip: 0, errors: 0 },
  );
}
/** One line for the list: "12 new · 3 updated · 40 skipped · 2 errors". */
export function reportLine(entities: MigrationEntityReport[]): string {
  const t = reportTotals(entities);
  const parts = [`${t.create.toLocaleString("en-US")} new`];
  if (t.update) parts.push(`${t.update.toLocaleString("en-US")} updated`);
  if (t.skip) parts.push(`${t.skip.toLocaleString("en-US")} skipped`);
  if (t.errors) parts.push(`${t.errors.toLocaleString("en-US")} with errors`);
  return parts.join(" · ");
}

export function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** What the import button does next, for the detail panel. */
export function nextStep(i: MigrationImport): string {
  if (i.status === "applying") return "Applying in the background: this updates by itself when it is done.";
  if (i.status === "validated")
    return i.report.canApply
      ? "Review the report, then apply. Apply writes exactly this as one change in History."
      : i.report.entities.some((e) => e.errors)
        ? "Fix the files and re-run the dry run: errors block apply."
        : // Every row skipped (R9): e.g. an earlier import already wrote these records.
          "Nothing to apply: every row is already in the system as in the files (Skip). Change the files, or delete this import.";
  if (i.status === "applied")
    return i.inactiveTrunks
      ? `${i.inactiveTrunks} imported trunks wait inactive: go live per partner when ready.`
      : "Applied. Undoing its change in History rolls the whole import back.";
  if (i.status === "rolled_back") return "Rolled back: the records it created are archived.";
  return "The import failed.";
}

export const ENTITY_ORDER: MigrationImportEntity[] = [
  "users",
  "enterprises",
  "customer_trunks",
  "vendor_trunks",
  "rate_tables",
  "rate_lines",
  "route_rules",
  "opening_balances",
];
