// Client checks before Save (functional QA round 13): limits, e-mails, host IPs and websites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkValue, isEmail, isHostEntry, normalizeWebsite } from "./checks";

test("numbers: required, whole, within the field's limits", () => {
  assert.deepEqual(checkValue("maxConnections", null, { required: true }), { maxConnections: "Required." });
  assert.deepEqual(checkValue("maxConnections", 0, { min: 1, max: 10, integer: true }), {
    maxConnections: "Must be at least 1.",
  });
  assert.deepEqual(checkValue("tps", -5, { min: 1 }), { tps: "Must be at least 1." });
  assert.deepEqual(checkValue("tps", 2.5, { min: 1, integer: true }), { tps: "Enter a whole number." });
  assert.deepEqual(checkValue("tps", 5, { min: 1, max: 10, integer: true }), {});
});

test("text: required and e-mail", () => {
  assert.deepEqual(checkValue("name", "   ", { required: true }), { name: "Required." });
  assert.deepEqual(checkValue("email", "bad-email", { format: "email" }), {
    email: "Enter a valid e-mail address, e.g. name@example.com.",
  });
  assert.deepEqual(checkValue("email", "", { format: "email" }), {}, "an optional empty e-mail is fine");
  assert.ok(isEmail("noc@fake-carrier.example"));
  assert.ok(!isEmail("noc@fake"));
});

test("lists: each value checked, keyed by its place", () => {
  const errors = checkValue("hostIps", ["192.0.2.10", "999.1.1.1", "10.0.0.0/33", "abc"], { item: "ip" });
  assert.deepEqual(Object.keys(errors), ["hostIps.1", "hostIps.2", "hostIps.3"]);
  assert.match(errors["hostIps.1"]!, /^999\.1\.1\.1: Not an IP address/);
});

test("host IPs: addresses, networks and ranges as the server takes them", () => {
  for (const ok of [
    "192.0.2.10",
    "2001:db8::1",
    "192.0.2.0/24",
    "192.0.2.0/255.255.255.0",
    "2001:db8::/32",
    "192.0.2.10-192.0.2.50",
    "192.0.2.10-50",
  ])
    assert.ok(isHostEntry(ok), ok);
  for (const bad of ["999.1.1.1", "10.0.0.0/33", "abc", "192.0.2.0/255.0.255.0", "192.0.2.10-300", "1.2.3"])
    assert.ok(!isHostEntry(bad), bad);
});

test("website: http(s) addresses kept, bare domains get https://, anything else refused", () => {
  assert.equal(normalizeWebsite("example.com"), "https://example.com");
  assert.equal(normalizeWebsite("www.fake-carrier.example/about"), "https://www.fake-carrier.example/about");
  assert.equal(normalizeWebsite("http://example.com"), "http://example.com");
  assert.equal(normalizeWebsite("https://example.com/x?y=1"), "https://example.com/x?y=1");
  assert.equal(normalizeWebsite(""), "");
  assert.equal(normalizeWebsite("not a website"), null);
  assert.equal(normalizeWebsite("ftp://example.com"), null);
  assert.equal(normalizeWebsite("localhost"), null);
  assert.equal(normalizeWebsite("javascript:alert(1)"), null);
});
