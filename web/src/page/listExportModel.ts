// What a list page sends to the one list export (§13.22, §13.25): the columns in view, in order, and the page's
// query without its paging (the server takes every matching row).
import type { FieldDescriptor, ListQuery } from "@sms/contract";

/** The columns the grid shows: the chosen ones in their order, else every column not hidden; never filter-only fields. */
export function exportColumns(fields: FieldDescriptor[], visible: string[] | null): string[] {
  const byName = new Map(fields.map((f) => [f.field, f]));
  return (visible ?? fields.filter((f) => !f.hidden).map((f) => f.field)).filter(
    (c) => byName.has(c) && !byName.get(c)!.filterOnly,
  );
}

/** The query's filter, quick search and sort, as the page sends them; paging is the server's. */
export function exportQuery(q: Pick<ListQuery, "filter" | "search" | "sort">): Pick<ListQuery, "filter" | "search" | "sort"> {
  return {
    ...(q.filter ? { filter: q.filter } : {}),
    ...(q.search ? { search: q.search } : {}),
    ...(q.sort?.length ? { sort: q.sort } : {}),
  };
}
