// Problems in plain words (functional QA round 13). A failed save answers problem+json with `errors[]`: a JSON
// pointer and, when the request did not match the contract, the schema checker's own words ("must NOT have fewer than
// 1 characters", "must match format \"email\""). This is the one place that turns them into what a person reads under
// a field, in a banner or in a toast; messages the server already wrote for people pass through unchanged.
import type { Problem } from "@sms/contract";

export interface FieldProblem {
  /** JSON pointer, e.g. "/contacts/0/email"; "" for the record as a whole. */
  path: string;
  message: string;
}

const FORMAT: Record<string, string> = {
  email: "Enter a valid e-mail address, e.g. name@example.com.",
  "idn-email": "Enter a valid e-mail address, e.g. name@example.com.",
  uri: "Enter a web address starting with https://.",
  "uri-reference": "Enter a valid web address.",
  url: "Enter a web address starting with https://.",
  ipv4: "Enter a valid IPv4 address, e.g. 192.0.2.10.",
  ipv6: "Enter a valid IPv6 address.",
  hostname: "Enter a valid host name, e.g. smpp.example.com.",
  date: "Enter a valid date (YYYY-MM-DD).",
  "date-time": "Enter a valid date and time.",
  time: "Enter a valid time (HH:MM).",
  uuid: "Not a valid ID.",
  regex: "Not a valid regular expression.",
};

const RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^required$/i, () => "Required."],
  [/^must have required property '[^']+'$/, () => "Required."],
  [/^must NOT have fewer than 1 characters?$/, () => "Required."],
  [/^must NOT have fewer than (\d+) characters$/, (m) => `Use at least ${m[1]} characters.`],
  [/^must NOT have more than (\d+) characters?$/, (m) => `Use at most ${m[1]} characters.`],
  [/^must NOT have fewer than 1 items?$/, () => "Add at least one."],
  [/^must NOT have fewer than (\d+) items$/, (m) => `Add at least ${m[1]}.`],
  [/^must NOT have more than (\d+) items?$/, (m) => `At most ${m[1]}.`],
  [/^must NOT have duplicate items/, () => "Each value may appear only once."],
  [/^must be >= (-?[\d.]+)$/, (m) => `Must be at least ${m[1]}.`],
  [/^must be > (-?[\d.]+)$/, (m) => `Must be more than ${m[1]}.`],
  [/^must be <= (-?[\d.]+)$/, (m) => `Must be at most ${m[1]}.`],
  [/^must be < (-?[\d.]+)$/, (m) => `Must be less than ${m[1]}.`],
  [/^must be multiple of ([\d.]+)$/, (m) => `Must be a multiple of ${m[1]}.`],
  [/^must be integer$/, () => "Enter a whole number."],
  [/^must be number$/, () => "Enter a number."],
  [/^must be (string|boolean|object|array|null)(,\w+)*$/, () => "This value does not fit here."],
  [/^must be equal to one of the allowed values$/, () => "Choose one of the offered values."],
  [/^must be equal to constant$/, () => "This value is not allowed here."],
  [/^must match format "([^"]+)"$/, (m) => FORMAT[m[1]!] ?? "Not in the expected format."],
  [/^must match pattern /, () => "Not in the expected format."],
  [/^must NOT have (additional|unevaluated) (properties|items)$/, () => "Has a field this form does not send."],
  [/^must match (exactly one|a) schema in (oneOf|anyOf)$/, () => "This value does not fit here."],
  [/^must match "(then|else)" schema$/, () => "Check this field together with the ones it depends on."],
  [/^must NOT be valid$/, () => "This value is not allowed here."],
];

/** One message in plain words: the schema checker's wording mapped, anything else as the server wrote it. */
export function friendlyMessage(message: string): string {
  const text = message.trim();
  for (const [re, say] of RULES) {
    const m = text.match(re);
    if (m) return say(m);
  }
  return text ? text[0]!.toUpperCase() + text.slice(1) : "Not valid.";
}

const WORDS: Record<string, string> = {
  id: "ID",
  ids: "IDs",
  ip: "IP",
  ips: "IPs",
  url: "URL",
  tps: "TPS",
  dlr: "DLR",
  mo: "MO",
  hlr: "HLR",
  smpp: "SMPP",
  mccmnc: "MCCMNC",
  mccmncs: "MCCMNCs",
  vat: "VAT",
  iban: "IBAN",
  swift: "SWIFT",
  ssl: "SSL",
  am: "AM",
  eur: "EUR",
};

/** The field a pointer names, as words: "/maxConnections" → "Max connections", "/contacts/0/email" → "Email". */
export function fieldLabel(path: string): string {
  const last = path
    .split("/")
    .filter((p) => p && !/^\d+$/.test(p))
    .at(-1);
  if (!last) return "";
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());
  const label = words.join(" ");
  return label[0]!.toUpperCase() + label.slice(1);
}

type ProblemLike = Partial<Problem> & { errors?: unknown };

/**
 * A problem's field errors in plain words. "must have required property 'x'" on the record moves to the field x, so
 * it can show under that field.
 */
export function problemFields(problem: ProblemLike | null | undefined): FieldProblem[] {
  const list = Array.isArray(problem?.errors) ? (problem.errors as { path?: string; message?: string }[]) : [];
  return list.map((e) => {
    const raw = String(e.message ?? "");
    const missing = /^must have required property '([^']+)'$/.exec(raw);
    const base = !e.path || e.path === "/" ? "" : e.path;
    return { path: missing ? `${base}/${missing[1]}` : base, message: friendlyMessage(raw) };
  });
}

/** The banner title: the contract checker's own title in plain words, any other title as the server wrote it. */
export function problemTitle(title: string): string {
  return title === "Request body does not match the contract" ? "Some fields need a fix" : title;
}

/** "Max connections: Must be at least 1." — or the message alone when it is about the record as a whole. */
export const fieldLine = (p: FieldProblem) => (fieldLabel(p.path) ? `${fieldLabel(p.path)}: ${p.message}` : p.message);

/** One line for a toast or a banner: the title, then each field's problem in plain words. */
export function problemSummary(problem: ProblemLike & { title: string }): string {
  const fields = problemFields(problem);
  const title = problemTitle(problem.title);
  if (fields.length) return `${title}: ${fields.map(fieldLine).join(" ")}`;
  return problem.detail ? `${title}: ${problem.detail}` : title;
}
