// Field catalogue values that come from configuration data, e.g. the product categories in
// the Route Rules Category filter (§15.4). Cached for five minutes; without a database the
// catalogue is served as written.
import type { ListFields, ListId } from "@sms/contract";
import { db } from "../db.js";

const SOURCES: Partial<Record<ListId, Record<string, string>>> = {
  countries: { region: "SELECT DISTINCT region AS value, region AS label FROM countries ORDER BY 1" },
  route_rules: {
    category: "SELECT id::text AS value, name AS label FROM product_categories WHERE deleted_at IS NULL ORDER BY name",
  },
};

const cache = new Map<string, { at: number; values: { value: string; label: string }[] }>();

export async function withEnumsFromDb(list: ListId, fields: ListFields): Promise<ListFields> {
  const sources = SOURCES[list];
  if (!sources) return fields;
  const out: ListFields = { ...fields, fields: fields.fields.map((f) => ({ ...f })) };
  for (const [field, sql] of Object.entries(sources)) {
    const key = `${list}.${field}`;
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > 300_000) {
      try {
        const { rows } = await db().query(sql);
        hit = { at: Date.now(), values: rows as { value: string; label: string }[] };
        cache.set(key, hit);
      } catch {
        continue;
      }
    }
    const f = out.fields.find((x) => x.field === field);
    if (f) f.enumValues = [...(f.enumValues ?? []), ...hit.values];
  }
  return out;
}
