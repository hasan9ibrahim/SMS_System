// Access to the generic list calls under /lists/{list} (§13.22 export, §13.29 bulk delete and restore). Their page is
// the list's, not the path's, so contract/access.json leaves them open and they are checked here (and by the Elixir
// API, Sms.Api.Access.check_list) from contract/generated/operations.json:
//
// * export: the page of the list's own POST /{list}/query with its Export action (a page without one: its Edit,
//   else its View, as scripts/generate.mjs falls back), and the page's View;
// * bulk delete / restore: the access of the list's own POST /{list}/{id}/archive and /restore.
import { readFileSync } from "node:fs";
import { contractFile } from "../contract.js";
import { allows } from "./access.js";

export interface OperationAccess {
  method: string;
  path: string;
  operationId: string;
  module: string | null;
  action: string | null;
}

const operations = JSON.parse(readFileSync(contractFile("generated/operations.json"), "utf8")) as OperationAccess[];
const pages = (JSON.parse(readFileSync(contractFile("access.json"), "utf8")) as { pages: Record<string, string[]> })
  .pages;

/** Lists whose query is not at POST /{list}/query. */
const QUERY_OPS: Record<string, string> = { billing_report: "queryBillingReport" };

const byPath = (method: string, path: string) => operations.find((o) => o.method === method && o.path === path) ?? null;
const dashed = (list: string) => list.replaceAll("_", "-");

/** The list's own query operation, or null for a list without one. */
export function listQueryOp(list: string): OperationAccess | null {
  const id = QUERY_OPS[list];
  if (id) return operations.find((o) => o.operationId === id) ?? null;
  return byPath("POST", `/${dashed(list)}/query`);
}

/** The single delete (archive) of the list's records, or null when its rows have no Delete. */
export const listArchiveOp = (list: string) => byPath("POST", `/${dashed(list)}/{id}/archive`);
/** The single restore of the list's records, or null. */
export const listRestoreOp = (list: string) => byPath("POST", `/${dashed(list)}/{id}/restore`);

/** The action an export needs on a page: Export, else the page's Edit, else its View (as generate.mjs falls back). */
export function exportAction(page: string): string {
  const offered = pages[page] ?? [];
  return offered.includes("export") ? "export" : offered.includes("edit") ? "edit" : "view";
}

/** Whether the permissions (as /me sends them) allow the operation; an open operation (no page) is allowed. */
export function mayRun(permissions: readonly string[], op: OperationAccess): boolean {
  if (!op.module) return true;
  return allows(permissions, op.module, op.action ?? "view");
}

/**
 * Whether the permissions allow exporting the list: the list's page View and its export action. Null when the list
 * has no query of its own (nothing to export).
 */
export function mayExport(permissions: readonly string[], list: string): boolean | null {
  const op = listQueryOp(list);
  if (!op) return null;
  if (!op.module) return true;
  return allows(permissions, op.module, "view") && allows(permissions, op.module, exportAction(op.module));
}
