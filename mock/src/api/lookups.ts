// Names-only picks of another page's records (backend step 10, POST /lookups/{list}/query). Product owner
// 2026-10-25: a page the user may not open is not reached from another page either. Forms and filters on other
// pages pick its records here: the list's own filter grammar (§13.25) over its lookup fields only
// (contract/access.json lookups), for users who may open the list's page or a page that picks from it. AM
// visibility (§13.17) applies as in the list itself.
import { readFileSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FilterCondition, FilterGroup, ListQuery } from "@sms/contract";
import { withDb } from "../db.js";
import { listDefs } from "../lists/defs.js";
import { listFields } from "../lists/fields.js";
import { runList, type ListDef } from "../lists/engine.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { viewer } from "../auth/access.js";
import { isBadRegex } from "./lists.js";

const root = new URL("../../../contract/", import.meta.url);
const access = JSON.parse(readFileSync(new URL("access.json", root), "utf8")) as {
  lookups: Record<string, { pages: string[]; fields: string[] }>;
};
const operations = JSON.parse(readFileSync(new URL("generated/operations.json", root), "utf8")) as {
  path: string;
  method: string;
  module: string | null;
}[];

/** The list's own page: the page of its POST /{list}/query. */
export function ownPage(list: string): string | null {
  const path = `/${list.replaceAll("_", "-")}/query`;
  return operations.find((o) => o.method === "POST" && o.path === path)?.module ?? null;
}

/** Fields a filter group uses, at any depth. */
function filterFields(group: FilterGroup | undefined, out: string[] = []): string[] {
  for (const c of group?.conditions ?? []) {
    if ("conditions" in c) filterFields(c as FilterGroup, out);
    else out.push((c as FilterCondition).field);
  }
  return out;
}

export function queryLookup(request: FastifyRequest, reply: FastifyReply) {
  const { list } = request.params as { list: string };
  const lookup = access.lookups[list];
  const def = (listDefs as Record<string, ListDef<Record<string, unknown>> | undefined>)[list];
  if (!lookup || !def) return sendProblem(reply, 404, "No such lookup", { detail: `${list} has no lookup.` });
  return withDb(reply, async (pool) => {
    const { canView } = await viewer();
    const own = ownPage(list);
    const pages = own ? [own, ...lookup.pages] : lookup.pages;
    if (!pages.includes("*") && !pages.some(canView))
      return sendProblem(reply, 403, "Your access group does not allow this", {
        detail: `Picking from ${list} is not given to your user. Ask an administrator.`,
        code: "not_allowed",
      });
    const query = request.body as ListQuery;
    const errors = checkListQuery(query, listFields[list as keyof typeof listFields]);
    // Only the lookup fields may be filtered or sorted on, so the other fields cannot be probed.
    const allowed = new Set(lookup.fields);
    filterFields(query.filter).forEach((field, i) => {
      if (!allowed.has(field)) errors.push({ path: `/filter/${i}`, message: `${field} is not a lookup field` });
    });
    (query.sort ?? []).forEach((s, i) => {
      if (!allowed.has(s.field)) errors.push({ path: `/sort/${i}`, message: `${s.field} is not a lookup field` });
    });
    if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
    const scoped: ListDef<Record<string, unknown>> = {
      ...def,
      // Quick search over the lookup fields only.
      search: (def.search ?? []).filter((f) => allowed.has(f)),
    };
    try {
      const page = await runList(pool, scoped, query);
      const rows = page.rows.map((row) => Object.fromEntries(lookup.fields.filter((f) => f in row).map((f) => [f, row[f]])));
      return { ...page, rows };
    } catch (err) {
      if (isBadRegex(err))
        return sendProblem(reply, 400, "Invalid list query", {
          errors: [{ path: "/filter", message: "invalid regular expression" }],
        });
      throw err;
    }
  });
}
