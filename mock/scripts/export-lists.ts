// Writes every list's field catalogue (GET /meta/lists/{list}/fields, §13.25) to contract/generated/lists.json, so the
// Elixir API validates filters and sorts against the same fields, types and operators (backend step 9). With --check,
// fails when the committed file is out of date (mock/test/lists-export.test.ts runs the same comparison).
import { readFileSync, writeFileSync } from "node:fs";
import { listsJson, LISTS_JSON } from "../src/lists/export.js";

const current = (() => {
  try {
    return readFileSync(LISTS_JSON, "utf8");
  } catch {
    return "";
  }
})();
const next = listsJson();
if (process.argv.includes("--check")) {
  if (current !== next) {
    console.error("contract/generated/lists.json is out of date: run `npm run gen:lists -w mock`");
    process.exit(1);
  }
  console.log("contract/generated/lists.json is up to date");
} else {
  writeFileSync(LISTS_JSON, next);
  console.log("wrote contract/generated/lists.json");
}
