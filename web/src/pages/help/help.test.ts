// Help center: every page has a topic, links resolve, search finds the right place (§15.1 help).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOME, PAGES } from "../../nav/registry";
import { GROUPS, TOPICS, TOPIC_BY_ID } from "./content";
import { buildIndex, plain, search, tokens } from "./search";

test("topic ids are unique and every group is known", () => {
  assert.equal(TOPIC_BY_ID.size, TOPICS.length);
  for (const t of TOPICS) assert.ok(GROUPS.includes(t.group), `${t.id}: unknown group ${t.group}`);
});

test("every page except the help center has its own topic", () => {
  const covered = new Set(TOPICS.map((t) => t.pageKey).filter(Boolean));
  const missing = [HOME, ...PAGES].filter((p) => p.key !== "help" && !covered.has(p.key)).map((p) => p.key);
  assert.deepEqual(missing, []);
});

test("page keys exist and section ids are unique per topic", () => {
  const keys = new Set([HOME, ...PAGES].map((p) => p.key));
  for (const t of TOPICS) {
    if (t.pageKey) assert.ok(keys.has(t.pageKey), `${t.id}: unknown page ${t.pageKey}`);
    const ids = t.sections.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${t.id}: duplicate section id`);
    assert.ok(t.sections.length > 0, `${t.id}: no sections`);
  }
});

test("record screens have their topics", () => {
  assert.ok(TOPIC_BY_ID.has("enterprise-record"));
  assert.ok(TOPIC_BY_ID.has("trunk-record"));
});

test("every [[link]] points at an existing topic and section", () => {
  const bad: string[] = [];
  const json = (o: unknown) => JSON.stringify(o);
  for (const t of TOPICS) {
    for (const m of json(t).matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const [id, sec] = m[1]!.split("#");
      const target = TOPIC_BY_ID.get(id!);
      if (!target || (sec && !target.sections.some((s) => s.id === sec))) bad.push(`${t.id} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("plain() strips inline markup", () => {
  assert.equal(
    plain("Press **Save** to keep `5%` — see [[tabs|Tabs]] and [[layout]]."),
    "Press Save to keep 5% — see Tabs and layout.",
  );
});

test("tokens() lower-cases words and keeps quoted phrases", () => {
  assert.deepEqual(tokens('Route "minimum margin" TPS,'), ["route", "minimum margin", "tps"]);
});

test("search ranks the page topic first for its own name", () => {
  const index = buildIndex(TOPICS);
  for (const [q, id] of [
    ["route rules", "route-rules"],
    ["rate manager", "rate-manager"],
    ["translation rules", "translation-rules"],
    ["live analytics", "live-analytics"],
  ] as const) {
    const hits = search(index, q);
    assert.equal(hits[0]?.topic.id, id, `${q} → ${hits[0]?.topic.id}`);
  }
});

test("search needs every word and matches word starts", () => {
  const index = buildIndex(TOPICS);
  assert.ok(search(index, "marg").length > 0);
  assert.equal(search(index, "zzqx nothing").length, 0);
});
