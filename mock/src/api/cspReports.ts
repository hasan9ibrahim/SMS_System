// Content-Security-Policy reports (§14): browsers post here when a page breaks the web server's policy
// (deploy/nginx.conf, deploy/ansible/roles/web/templates/sms.conf.j2: report-uri and report-to). No sign-in, so the
// body is capped at 64 KB and each client address may send 60 reports a minute (600 for everyone together); each
// violation becomes one compact line in the service log and nothing is stored.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CspReportBody, CspReportList, CspViolation } from "@sms/contract";
import { sendProblem } from "../problem.js";

export const CSP_REPORT_MAX_BYTES = 64 * 1024;
export const CSP_REPORT_TYPES = ["application/csp-report", "application/reports+json"];
const PER_ADDRESS = 60;
const OVERALL = 600;

/** Report counts in the current minute, per client address and for everyone. */
const counts = new Map<string, number>();
let minute = -1;
let overall = 0;

/** Counts one report request from `ip`; true when that address, or everyone together, is over the minute's limit. */
export function overLimit(ip: string, now = Date.now()): boolean {
  const m = Math.floor(now / 60_000);
  if (m !== minute) {
    minute = m;
    overall = 0;
    counts.clear();
  }
  overall += 1;
  const n = (counts.get(ip) ?? 0) + 1;
  // A flood of made-up addresses cannot grow the map without bound: the overall cap stops it first.
  if (counts.size < 10_000 || counts.has(ip)) counts.set(ip, n);
  return n > PER_ADDRESS || overall > OVERALL;
}

/** For tests: forget the counts. */
export function resetCspLimits(): void {
  counts.clear();
  minute = -1;
  overall = 0;
}

/** Printable, short: control characters dropped (no forged log lines), cut to `max` characters. */
const clean = (v: unknown, max = 160): string => {
  if (v === undefined || v === null || v === "") return "-";
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s || "-";
};

/** A URL without its query and fragment (they can carry IDs or tokens); keywords such as "inline" stay. */
const place = (v: unknown): string => {
  if (typeof v !== "string" || !v) return "-";
  try {
    const u = new URL(v);
    return clean(u.protocol === "data:" || u.protocol === "blob:" ? u.protocol : `${u.origin}${u.pathname}`);
  } catch {
    return clean(v.split(/[?#]/)[0]);
  }
};

interface Violation {
  directive: unknown;
  blocked: unknown;
  document: unknown;
  source: unknown;
  line: unknown;
  column: unknown;
  sample: unknown;
  disposition: unknown;
}

/** The violations of a report body, in one shape for both formats; other Reporting API types are left out. */
export function violations(body: CspReportBody | CspReportList): Violation[] {
  if (Array.isArray(body)) {
    return body
      .filter((r) => r.type === "csp-violation" && r.body)
      .map(({ body: b }) => ({
        directive: b.effectiveDirective,
        blocked: b.blockedURL,
        document: b.documentURL,
        source: b.sourceFile,
        line: b.lineNumber,
        column: b.columnNumber,
        sample: b.sample,
        disposition: b.disposition,
      }));
  }
  const r: CspViolation = body["csp-report"];
  return [
    {
      directive: r["effective-directive"] ?? r["violated-directive"],
      blocked: r["blocked-uri"],
      document: r["document-uri"],
      source: r["source-file"],
      line: r["line-number"],
      column: r["column-number"],
      sample: r["script-sample"],
      disposition: r.disposition,
    },
  ];
}

/** One log line per violation, e.g. `csp report: style-src-attr blocked inline on https://x/rates/manager …`. */
export function violationLine(v: Violation): string {
  const at = v.source ? ` at ${place(v.source)}:${clean(v.line, 10)}:${clean(v.column, 10)}` : "";
  const sample = v.sample ? ` sample "${clean(v.sample, 40)}"` : "";
  return `csp ${clean(v.disposition, 10)}: ${clean(v.directive, 40)} blocked ${place(v.blocked)} on ${place(v.document)}${at}${sample}`;
}

export function reportCspViolation(request: FastifyRequest, reply: FastifyReply) {
  if (overLimit(request.ip || "unknown"))
    return sendProblem(reply, 429, "Too many reports", { detail: "Try again in a minute." });
  const list = violations(request.body as CspReportBody | CspReportList);
  for (const v of list.slice(0, 20)) request.log.warn(violationLine(v));
  return reply.code(204).send();
}

/** The two report content types, read as JSON with the 64 KB cap (other routes keep the usual JSON parser). */
export function registerCspReportParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    CSP_REPORT_TYPES,
    { parseAs: "string", bodyLimit: CSP_REPORT_MAX_BYTES },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(Object.assign(new Error("The report is not JSON"), { statusCode: 400 }), undefined);
      }
    },
  );
}
