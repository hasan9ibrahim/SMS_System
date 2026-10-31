// Client checks before Save (functional QA round 13): what a field on screen asks for (its required mark, limits, an
// e-mail, a web address, an IP address), in the same plain words as api/problems.ts, so a form says what is wrong
// before the server has to. The server's checks stay the authority; these only spare a round trip.

export interface FieldRule {
  required?: boolean | undefined;
  min?: number | undefined;
  max?: number | undefined;
  /** A whole number. */
  integer?: boolean | undefined;
  maxLength?: number | undefined;
  format?: "email" | undefined;
  /** Each value of a list: a known kind or a check of its own. */
  item?: "email" | "ip" | ((value: string) => string | null) | undefined;
}

export const MSG = {
  required: "Required.",
  email: "Enter a valid e-mail address, e.g. name@example.com.",
  website: "Enter a web address such as example.com or https://www.example.com.",
  ip: "Not an IP address, network or range (e.g. 192.0.2.10, 192.0.2.0/24 or 192.0.2.10-50).",
  integer: "Enter a whole number.",
  number: "Enter a number.",
  atLeast: (n: number) => `Must be at least ${n}.`,
  atMost: (n: number) => `Must be at most ${n}.`,
  maxLength: (n: number) => `Use at most ${n} characters.`,
};

export const isEmail = (s: string) => /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/.test(s.trim());

const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
export const isIPv4 = (s: string) => IPV4.test(s.trim());
export function isIPv6(s: string): boolean {
  const t = s.trim();
  if (!t.includes(":") || !/^[0-9a-fA-F:.]+$/.test(t)) return false;
  try {
    new URL(`http://[${t}]/`);
    return true;
  } catch {
    return false;
  }
}

/** A dotted IPv4 mask (255.255.255.0) with its ones together. */
function isMask(s: string): boolean {
  if (!isIPv4(s)) return false;
  const bits = s
    .split(".")
    .map((p) => Number(p).toString(2).padStart(8, "0"))
    .join("");
  return /^1*0*$/.test(bits);
}

/**
 * A trunk's allowed host: an address (192.0.2.10, 2001:db8::1), a network (192.0.2.0/24, 192.0.2.0/255.255.255.0) or
 * a range (192.0.2.10-192.0.2.50, 192.0.2.10-50), as the server takes them (§5.4).
 */
export function isHostEntry(text: string): boolean {
  const t = text.trim();
  const slash = t.split("/");
  if (slash.length === 2) {
    const [a, p] = [slash[0]!.trim(), slash[1]!.trim()];
    if (isIPv4(a)) return (/^\d{1,2}$/.test(p) && Number(p) <= 32) || isMask(p);
    return isIPv6(a) && /^\d{1,3}$/.test(p) && Number(p) <= 128;
  }
  const dash = t.split("-");
  if (dash.length === 2) {
    const [lo, hi] = [dash[0]!.trim(), dash[1]!.trim()];
    if (isIPv4(lo)) return isIPv4(hi) || (/^\d{1,3}$/.test(hi) && Number(hi) <= 255);
    return isIPv6(lo) && isIPv6(hi);
  }
  return isIPv4(t) || isIPv6(t);
}

/**
 * A website as typed (F17, functional QA round 13): an http(s) address, or a bare domain that gets https:// in front.
 * Returns the address to save, or null when it is not a web address. Empty stays empty.
 */
export function normalizeWebsite(text: string): string | null {
  const t = text.trim();
  if (!t) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A real host name: labels of letters, digits and dashes, with a dot and a top-level part of letters.
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) && !isIPv4(url.hostname)) return null;
  if (/\s/.test(t)) return null;
  return withScheme;
}

const itemProblem = (rule: FieldRule["item"], v: string): string | null =>
  !rule
    ? null
    : typeof rule === "function"
      ? rule(v)
      : rule === "email"
        ? isEmail(v)
          ? null
          : MSG.email
        : isHostEntry(v)
          ? null
          : MSG.ip;

/** The errors of one field's value against its rule, keyed like the form's errors ("hostIps.2" for a list value). */
export function checkValue(path: string, value: unknown, rule: FieldRule): Record<string, string> {
  const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) return rule.required ? { [path]: MSG.required } : {};
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { [path]: MSG.number };
    if (rule.integer && !Number.isInteger(value)) return { [path]: MSG.integer };
    if (rule.min !== undefined && value < rule.min) return { [path]: MSG.atLeast(rule.min) };
    if (rule.max !== undefined && value > rule.max) return { [path]: MSG.atMost(rule.max) };
    return {};
  }
  if (typeof value === "string") {
    if (rule.required && !value.trim()) return { [path]: MSG.required };
    if (rule.maxLength !== undefined && value.length > rule.maxLength) return { [path]: MSG.maxLength(rule.maxLength) };
    if (rule.format === "email" && !isEmail(value)) return { [path]: MSG.email };
    return {};
  }
  if (Array.isArray(value) && rule.item) {
    const out: Record<string, string> = {};
    value.forEach((v, i) => {
      const problem = typeof v === "string" ? itemProblem(rule.item, v) : null;
      if (problem) out[`${path}.${i}`] = `${v}: ${problem}`;
    });
    return out;
  }
  return {};
}
