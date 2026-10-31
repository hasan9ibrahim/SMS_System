import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeCode } from "./UsernameHint";

test("a username of digits only looks like a saved sign-in code (§13.28)", () => {
  for (const code of ["123456", " 482913 ", "1234", "12345678"]) assert.equal(looksLikeCode(code), true, code);
  for (const name of ["", "anna.k", "noc2", "123", "123456789", "12 34 56", "user123456"])
    assert.equal(looksLikeCode(name), false, name);
});
