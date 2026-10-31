// Problems in plain words (functional QA round 13): the contract checker's wording never reaches the screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldLabel, friendlyMessage, problemFields, problemSummary } from "./problems";

test("schema wording becomes plain words; a person's message passes through", () => {
  assert.equal(friendlyMessage("must NOT have fewer than 1 characters"), "Required.");
  assert.equal(friendlyMessage("must NOT have more than 100 characters"), "Use at most 100 characters.");
  assert.equal(friendlyMessage('must match format "email"'), "Enter a valid e-mail address, e.g. name@example.com.");
  assert.equal(friendlyMessage("must be >= 1"), "Must be at least 1.");
  assert.equal(friendlyMessage("must be <= 10"), "Must be at most 10.");
  assert.equal(friendlyMessage("must be integer"), "Enter a whole number.");
  assert.equal(friendlyMessage("must be equal to one of the allowed values"), "Choose one of the offered values.");
  assert.equal(friendlyMessage("must be string,null"), "This value does not fit here.");
  assert.equal(
    friendlyMessage("pick at least one vendor trunk or tick Tier 1"),
    "Pick at least one vendor trunk or tick Tier 1",
  );
});

test("field names from the pointer", () => {
  assert.equal(fieldLabel("/maxConnections"), "Max connections");
  assert.equal(fieldLabel("/contacts/0/email"), "Email");
  assert.equal(fieldLabel("/hostIps/2"), "Host IPs");
  assert.equal(fieldLabel("/tps"), "TPS");
  assert.equal(fieldLabel("/"), "");
});

test("a missing property shows under its own field; the summary names each field", () => {
  const problem = {
    title: "Request body does not match the contract",
    status: 400,
    errors: [
      { path: "/name", message: "must NOT have fewer than 1 characters" },
      { path: "/", message: "must have required property 'listType'" },
      { path: "/maxConnections", message: "must be >= 1" },
    ],
  };
  assert.deepEqual(problemFields(problem), [
    { path: "/name", message: "Required." },
    { path: "/listType", message: "Required." },
    { path: "/maxConnections", message: "Must be at least 1." },
  ]);
  assert.equal(
    problemSummary(problem),
    "Some fields need a fix: Name: Required. List type: Required. Max connections: Must be at least 1.",
  );
  assert.equal(problemSummary({ title: "Not found", status: 404, detail: "No rule 5" }), "Not found: No rule 5");
});
