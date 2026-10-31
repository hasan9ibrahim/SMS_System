// Content-Security-Policy reports (§14): both report formats are taken without a sign-in, each violation becomes one
// clean log line, and the endpoint is size- and rate-limited. Needs no database.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX, PUBLIC_OPS } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb } from "../src/db.js";
import { isAudited } from "../src/api/audit.js";
import { resetCspLimits, violationLine, violations } from "../src/api/cspReports.js";

const app = await buildServer({ socket: false });
after(async () => {
  await app.close();
  await closeDb();
});
beforeEach(() => resetCspLimits());

const op = operations.find((o) => o.operationId === "reportCspViolation")!;
function assertListed(res: LightMyRequestResponse) {
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `answered ${status}, which the contract does not list`);
  const validate = op.responses[status];
  if (validate) assert.ok(validate(res.json()), JSON.stringify(validate.errors));
}
const post = (contentType: string, payload: string, remoteAddress = "198.51.100.7") =>
  app.inject({
    method: "POST",
    url: `${API_PREFIX}/csp-reports`,
    headers: { "content-type": contentType },
    payload,
    remoteAddress,
  });

const legacy = {
  "csp-report": {
    "document-uri": "https://sms.example.test/rates/manager?table=168#x",
    referrer: "",
    "violated-directive": "style-src-attr",
    "effective-directive": "style-src-attr",
    "original-policy": "default-src 'self'; report-uri /api/v1/csp-reports",
    disposition: "report" as const,
    "blocked-uri": "inline",
    "line-number": 12,
    "column-number": 3,
    "source-file": "https://sms.example.test/assets/index-abc.js",
    "status-code": 200,
    "script-sample": "color: red",
  },
};
const modern = [
  {
    type: "csp-violation",
    age: 10,
    url: "https://sms.example.test/dashboard",
    user_agent: "Test",
    body: {
      documentURL: "https://sms.example.test/dashboard",
      blockedURL: "https://cdn.example.test/x.js?k=secret",
      effectiveDirective: "script-src-elem",
      originalPolicy: "default-src 'self'",
      disposition: "report" as const,
      statusCode: 200,
      sample: "",
      lineNumber: null,
      columnNumber: null,
      sourceFile: null,
      referrer: null,
    },
  },
  { type: "deprecation", body: { id: "x" } },
];

test("the operation is public, never audited", () => {
  assert.ok(PUBLIC_OPS.has("reportCspViolation"));
  assert.equal(isAudited(op), false);
});

test("report-uri format, Reporting API list and plain JSON are taken without a sign-in", async () => {
  for (const [type, body] of [
    ["application/csp-report", legacy],
    ["application/reports+json", modern],
    ["application/json", legacy],
    ["application/json", modern],
  ] as const) {
    const res = await post(type, JSON.stringify(body));
    assert.equal(res.statusCode, 204, `${type}: ${res.body}`);
    assertListed(res);
  }
});

test("bad bodies are refused: not JSON, wrong shape, wrong type, over 64 KB", async () => {
  const notJson = await post("application/csp-report", "{nope");
  assert.equal(notJson.statusCode, 400);
  assertListed(notJson);
  const shape = await post("application/csp-report", JSON.stringify({ hello: 1 }));
  assert.equal(shape.statusCode, 400);
  assertListed(shape);
  const type = await post("application/xml", "<a/>");
  assert.equal(type.statusCode, 415);
  assertListed(type);
  const big = { "csp-report": { ...legacy["csp-report"], "script-sample": "x".repeat(70_000) } };
  for (const ct of ["application/csp-report", "application/json"]) {
    const res = await post(ct, JSON.stringify(big));
    assert.equal(res.statusCode, 413, ct);
    assertListed(res);
  }
});

test("60 requests a minute per address, then 429; another address still gets through", async () => {
  for (let i = 0; i < 60; i++) assert.equal((await post("application/csp-report", JSON.stringify(legacy))).statusCode, 204);
  const over = await post("application/csp-report", JSON.stringify(legacy));
  assert.equal(over.statusCode, 429);
  assertListed(over);
  assert.equal((await post("application/csp-report", JSON.stringify(legacy), "198.51.100.8")).statusCode, 204);
});

test("one compact line per violation, with no query strings or control characters", () => {
  const [a] = violations(legacy);
  assert.equal(
    violationLine(a!),
    'csp report: style-src-attr blocked inline on https://sms.example.test/rates/manager at https://sms.example.test/assets/index-abc.js:12:3 sample "color: red"',
  );
  const lines = violations(modern).map(violationLine);
  assert.deepEqual(lines, [
    "csp report: script-src-elem blocked https://cdn.example.test/x.js on https://sms.example.test/dashboard",
  ]);
  const forged = violationLine(
    violations({ "csp-report": { "effective-directive": "img-src\ncsp report: fake", "blocked-uri": "data" } })[0]!,
  );
  assert.ok(!forged.includes("\n"), forged);
});
