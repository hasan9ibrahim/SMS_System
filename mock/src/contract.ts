// Loads contract/openapi.yaml and exposes its operations and JSON Schema validators.
// The mock registers a route for EVERY operation in the contract, so the GUI can rely on
// each path existing; operations without a handler yet answer 501 (CLAUDE.md rule 2).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const require = createRequire(import.meta.url);
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

type JsonObject = Record<string, unknown>;

export interface ContractOperation {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** OpenAPI path, e.g. /enterprises/{id} */
  path: string;
  /** Fastify path, e.g. /enterprises/:id */
  routePath: string;
  /** Validator for the JSON request body, when the operation has one. */
  validateBody?: ValidateFunction;
  /** Path parameter validators by name. */
  pathParams: Record<string, ValidateFunction>;
  /** Response body validators by status code, for tests and dev-mode checks. */
  responses: Record<string, ValidateFunction | undefined>;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const DOC_ID = "openapi";

export const openapiPath = require.resolve("@sms/contract/openapi.yaml");
export const document = parse(readFileSync(openapiPath, "utf8")) as JsonObject & {
  info: { version: string };
  paths: Record<string, Record<string, JsonObject>>;
  components: JsonObject;
};

const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, useDefaults: true });
addFormats(ajv);
ajv.addSchema(document, DOC_ID);

const pointer = (...parts: string[]) =>
  `${DOC_ID}#/${parts.map((p) => p.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

function resolveRef<T>(node: T): T {
  const ref = (node as { $ref?: string } | undefined)?.$ref;
  if (!ref?.startsWith("#/")) return node;
  return ref
    .slice(2)
    .split("/")
    .reduce<unknown>((acc, key) => (acc as JsonObject)[key.replaceAll("~1", "/").replaceAll("~0", "~")], document) as T;
}

function compile(...parts: string[]): ValidateFunction {
  const validate = ajv.getSchema(pointer(...parts));
  if (!validate) throw new Error(`cannot compile schema at ${parts.join("/")}`);
  return validate;
}

export const operations: ContractOperation[] = Object.entries(document.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => {
    const op = item[m] as JsonObject & {
      operationId: string;
      parameters?: JsonObject[];
      requestBody?: { content?: Record<string, unknown> };
      responses: Record<string, JsonObject>;
    };
    const pathParams: Record<string, ValidateFunction> = {};
    (op.parameters ?? []).forEach((param, i) => {
      const resolved = resolveRef(param) as { name: string; in: string };
      if (resolved.in !== "path") return;
      const base = (param as { $ref?: string }).$ref
        ? (param as { $ref: string }).$ref.slice(2).split("/")
        : ["paths", path, m, "parameters", String(i)];
      pathParams[resolved.name] = compile(...base, "schema");
    });
    const responses: Record<string, ValidateFunction | undefined> = {};
    for (const [status, response] of Object.entries(op.responses)) {
      const base = (response as { $ref?: string }).$ref
        ? (response as { $ref: string }).$ref.slice(2).split("/")
        : ["paths", path, m, "responses", status];
      const content = (resolveRef(response) as { content?: Record<string, unknown> }).content ?? {};
      const mediaType = Object.keys(content)[0];
      responses[status] = mediaType ? compile(...base, "content", mediaType, "schema") : undefined;
    }
    return {
      operationId: op.operationId,
      method: m.toUpperCase() as ContractOperation["method"],
      path,
      routePath: path.replace(/\{([^}]+)\}/g, ":$1"),
      validateBody: op.requestBody?.content?.["application/json"]
        ? compile("paths", path, m, "requestBody", "content", "application/json", "schema")
        : undefined,
      pathParams,
      responses,
    };
  }),
);

export const contractVersion = document.info.version;
