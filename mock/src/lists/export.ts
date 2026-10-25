// The field catalogues of every list as JSON for the Elixir API (backend step 9, contract/generated/lists.json).
import { fileURLToPath } from "node:url";
import { listFields } from "./fields.js";

export const LISTS_JSON = fileURLToPath(new URL("../../../contract/generated/lists.json", import.meta.url));

export function listsJson(): string {
  const sorted = Object.fromEntries(Object.entries(listFields).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(sorted, null, 1) + "\n";
}
