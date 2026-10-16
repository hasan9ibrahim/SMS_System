import { test } from "node:test";
import assert from "node:assert/strict";
import { getAt, pointerToPath, setAt } from "./paths";

test("getAt reads nested values and stops at missing parts", () => {
  const v = { address: { city: "X" }, contacts: { rates: { emails: ["a@b.c"] } } };
  assert.equal(getAt(v, "address.city"), "X");
  assert.deepEqual(getAt(v, "contacts.rates.emails"), ["a@b.c"]);
  assert.equal(getAt(v, "address.zip.code"), undefined);
});

test("setAt copies only the objects on the path", () => {
  const v = { address: { city: "X", zip: "1" }, contacts: { rates: { emails: [] } } };
  const next = setAt(v, "address.city", "Y");
  assert.equal(next.address.city, "Y");
  assert.equal(v.address.city, "X", "the original is untouched");
  assert.equal(next.contacts, v.contacts, "untouched branches are shared");
  assert.deepEqual(setAt({}, "http.url", "u"), { http: { url: "u" } });
});

test("problem pointers map to form paths", () => {
  assert.equal(pointerToPath("/address/city"), "address.city");
  assert.equal(pointerToPath("/hostIps/0"), "hostIps.0");
});
