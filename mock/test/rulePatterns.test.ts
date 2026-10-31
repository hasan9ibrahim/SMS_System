// Rule patterns are checked and run as the switch reads them (QA 2026-10-31, §6.3, §6.4): JavaScript's Unicode mode
// plus what PCRE reads differently. No database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePattern } from "../src/routing/pattern.js";
import { compile } from "../src/routing/translate.js";
import { matchedPart } from "../src/routing/evaluate.js";

test("patterns PCRE reads otherwise are refused", () => {
  for (const p of ["[^]", "a[^]b", "[]", "x[]", "a{,3}", "\\u0041", "[\\u0041]"])
    assert.equal(compilePattern(p), null, p);
  // The same check where translation rules and HLR rules validate.
  assert.equal(compile("a{,3}"), null);
});

test("Unicode classes mean what they mean in PCRE", () => {
  assert.equal(matchedPart("\\p{L}+", "123 Ünïcode 456"), "Ünïcode");
  assert.equal(matchedPart("^\\p{L}+$", "ABC"), "ABC");
  assert.equal(matchedPart("\\p{L}+", "p{L}"), "p");
});

test("PCRE's escaped punctuation stays valid and literal", () => {
  assert.ok(compilePattern("^\\+?\\d+\\-\\_$")?.test("+12-_"));
  assert.ok(compilePattern("[\\-\\_]")?.test("_"));
  assert.ok(compilePattern("a\\'b\\ c")?.test("a'b c"));
  assert.ok(compilePattern("[\\]x]")?.test("]"));
  // Classes, groups and the sender keywords as before.
  assert.ok(compilePattern("^(234|233)[0-9]{6,}$")?.test("2348012345"));
  assert.equal(matchedPart("\\Numeric", "+2348012345"), "+2348012345");
  assert.ok(compilePattern("PROMO", "i")?.test("promo code"));
});
