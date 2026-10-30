// File names of the files partners receive (team trial round 12, §11): the business company's Customer Rate File
// Name, SOA File Name and Invoice File Name patterns. A variable is written [Key] or {Key}, any case, spaces and
// underscores ignored, so [EnterpriseName], {enterpriseName} and {Date and Time} all work; the old {company},
// {enterprise}, {trunk} and {date} keep working. Characters a file name cannot hold become "_".

export type FileNameKind = "rate" | "soa" | "invoice";

type Var = readonly [key: string, description: string];

const COMMON: Var[] = [
  ["Company", "Business company name"],
  ["EnterpriseName", "Partner (enterprise) name"],
  ["EnterpriseAlias", "Partner alias"],
  ["Currency", "Currency"],
  ["Timezone", "Partner billing time zone"],
  ["Username", "Username of who sends the file (system when sent automatically)"],
  ["Date", "Date the file is made, YYYY-MM-DD (UTC)"],
  ["Time", "Time the file is made, HH-MM (UTC)"],
  ["DateTime", "Date and time, YYYY-MM-DD_HH-MM (UTC); also written {Date and Time}"],
];

export const FILE_NAME_VARIABLES: Record<FileNameKind, Var[]> = {
  rate: [
    ...COMMON,
    ["Trunk", "Customer trunk name (several joined with -)"],
    ["ProductCategoryName", "Product category of the customer trunk"],
    ["RateTable", "Rate table name"],
  ],
  soa: [
    ...COMMON,
    ["BeneficiaryAddress", "Partner beneficiary address"],
    ["FromDate", "Statement start date"],
    ["ToDate", "Statement end date"],
  ],
  invoice: [
    ...COMMON,
    ["InvoiceRefNumber", "Invoice reference number"],
    ["InvoiceDate", "Invoice date"],
    ["InvoiceDueDate", "Invoice due date"],
    ["InvoiceStartDate", "Usage start date"],
    ["InvoiceEndDate", "Usage end date"],
    ["InvoiceTimezone", "Invoice time zone"],
    ["CurrencyCode", "Invoice currency code"],
    ["AccountNumber", "Partner account number"],
    ["CompanyRegisteredName", "Partner registered name"],
    ["CompanyAddress", "Partner address"],
    ["RegistrationNumber", "Partner registration number; also [PARAM1001]"],
    ["VATNumber", "Partner VAT number"],
    ["Website", "Partner website"],
    ["FaxNumber", "Partner fax number"],
    ["GrandTotal", "Invoice total due"],
  ],
};

/** Other spellings of a key: the old lower-case variables and the old platform's names. */
const ALIASES: Record<string, string> = {
  enterprise: "enterprisename",
  dateandtime: "datetime",
  param1001: "registrationnumber",
};

const norm = (key: string) => {
  const k = key.toLowerCase().replace(/[\s_]+/g, "");
  return ALIASES[k] ?? k;
};

const TOKEN = /\[([^\]\[{}]{1,40})\]|\{([^{}\[\]]{1,40})\}/g;

/** Keys a pattern uses that its kind does not know ("[Foo]" written as typed). Empty when all are known. */
export function unknownFileNameVariables(kind: FileNameKind, pattern: string): string[] {
  const known = new Set(FILE_NAME_VARIABLES[kind].map(([k]) => norm(k)));
  const bad: string[] = [];
  for (const m of pattern.matchAll(TOKEN)) if (!known.has(norm(m[1] ?? m[2]!))) bad.push(m[0]);
  return bad;
}

/** The common values for a file made now by `username` (or the system). */
export function nowValues(username: string | null, at = new Date()): Record<string, string> {
  const iso = at.toISOString();
  const time = iso.slice(11, 16).replace(":", "-");
  return { username: username ?? "system", date: iso.slice(0, 10), time, datetime: `${iso.slice(0, 10)}_${time}` };
}

/**
 * The file name from a pattern and values (keys in any spelling), with the extension added when the pattern does not
 * end in it. No pattern, or one that comes out empty, gives `fallback`.
 */
export function fillFileName(
  pattern: string | null | undefined,
  values: Record<string, string | number | null | undefined>,
  fallback: string,
  ext: string,
): string {
  const byKey = new Map(
    Object.entries(values).map(([k, v]) => [norm(k), v === null || v === undefined ? "" : String(v)]),
  );
  const filled = (pattern ?? "").replace(TOKEN, (all, a: string | undefined, b: string | undefined) => {
    const v = byKey.get(norm(a ?? b!));
    return v === undefined ? all : v;
  });
  const safe = filled
    // Characters Windows, macOS and mail clients refuse in a file name; line breaks and tabs too.
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/_{2,}/g, "_")
    .trim()
    .replace(/^[_ .]+|[_ .]+$/g, "")
    .slice(0, 150);
  const name = safe || fallback;
  const dot = `.${ext}`;
  return name.toLowerCase().endsWith(dot) ? name : `${name}${dot}`;
}

/**
 * A download header for a file name that may hold any letters (an Arabic or accented partner name): a plain ASCII
 * `filename` for old clients and the exact name in `filename*` (RFC 6266).
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
