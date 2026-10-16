// Contract self-checks: the OpenAPI document and every event schema compile as
// JSON Schema 2020-12, event examples match their schemas, and catalog.json is complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const eventsDir = path.join(root, "events");

function newAjv() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv;
}

const doc = parse(await readFile(path.join(root, "openapi.yaml"), "utf8"));
const catalog = JSON.parse(await readFile(path.join(eventsDir, "catalog.json"), "utf8"));
const schemaFiles = (await readdir(eventsDir)).filter((f) => f.endsWith(".json") && f !== "catalog.json");

test("operationIds are present and unique", () => {
  const ids = [];
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      assert.ok(op.operationId, `${method.toUpperCase()} ${p} has no operationId`);
      ids.push(op.operationId);
    }
  }
  assert.equal(new Set(ids).size, ids.length, "duplicate operationId");
});

test("every component schema compiles", () => {
  const ajv = newAjv();
  ajv.addSchema(doc, "openapi");
  for (const name of Object.keys(doc.components.schemas)) {
    assert.doesNotThrow(() => ajv.getSchema(`openapi#/components/schemas/${name}`), name);
  }
});

test("ListQuery accepts nested AND/OR filters and rejects unknown operators (§13.25)", () => {
  const ajv = newAjv();
  ajv.addSchema(doc, "openapi");
  const validate = ajv.getSchema("openapi#/components/schemas/ListQuery");
  const ok = {
    filter: {
      logic: "and",
      conditions: [
        { field: "name", op: "like", value: "acme%" },
        {
          logic: "or",
          conditions: [
            { field: "type", op: "in", values: ["customer", "reciprocal"] },
            { field: "id", op: "between", values: [100, 200] },
          ],
        },
      ],
    },
    sort: [{ field: "name", dir: "asc" }],
    limit: 500,
  };
  assert.ok(validate(ok), JSON.stringify(validate.errors));
  const bad = { filter: { logic: "and", conditions: [{ field: "name", op: "contains", value: "x" }] } };
  assert.equal(validate(bad), false);
  assert.equal(validate({ limit: 5000 }), false, "limit above 4000");
});

test("event catalog lists every payload schema and only existing files", () => {
  const listed = new Set(catalog.events.map((e) => e.schema));
  for (const f of listed) assert.ok(schemaFiles.includes(f), `catalog.json lists missing ${f}`);
  for (const f of schemaFiles) {
    if (f === "common.json" || f === "phoenix-message.json") continue;
    assert.ok(listed.has(f), `${f} is not listed in catalog.json`);
  }
});

test("every event schema compiles and its examples validate", async () => {
  const ajv = newAjv();
  const schemas = {};
  for (const f of schemaFiles) {
    schemas[f] = JSON.parse(await readFile(path.join(eventsDir, f), "utf8"));
    ajv.addSchema(schemas[f]);
  }
  for (const [f, schema] of Object.entries(schemas)) {
    const validate = ajv.getSchema(schema.$id);
    assert.ok(validate, `${f} did not compile`);
    for (const example of schema.examples ?? []) {
      assert.ok(validate(example), `${f} example: ${JSON.stringify(validate.errors)}`);
    }
  }
});
