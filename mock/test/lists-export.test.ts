// contract/generated/lists.json is the mock's field catalogues as they are now (backend step 9: the Elixir API
// validates list queries against it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listsJson, LISTS_JSON } from "../src/lists/export.js";

test("contract/generated/lists.json is up to date (npm run gen:lists -w mock)", () => {
  assert.equal(readFileSync(LISTS_JSON, "utf8"), listsJson());
});
