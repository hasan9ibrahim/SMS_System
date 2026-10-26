// Loads contract/openapi.yaml and exposes its operations and JSON Schema validators.
// The mock registers a route for EVERY operation in the contract, so the GUI can rely on
// each path existing; operations without a handler yet answer 501 (CLAUDE.md rule 2).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const require = createRequire(import.meta.url);
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

type JsonObject = Record<string, unknown>;

export interface ContractOperation {
  operationId: string;
  /** First tag, e.g. routing (the Audit Trail's Module Name, §11). */
  tag: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** OpenAPI path, e.g. /enterprises/{id} */
  path: string;
  /** Fastify path, e.g. /enterprises/:id */
  routePath: string;
  /** Validator for the JSON request body, when the operation has one. */
  validateBody?: ValidateFunction;
  /** Path parameter validators by name. */
  pathParams: Record<string, ValidateFunction>;
  /** Query parameters: validator, whether required, and whether the value is numeric. */
  queryParams: Record<string, { validate: ValidateFunction; required: boolean; numeric: boolean; boolean: boolean }>;
  /** Response body validators by status code, for tests and dev-mode checks. */
  responses: Record<string, ValidateFunction | undefined>;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const DOC_ID = "openapi";

// SMS_CONTRACT_FILE: the contract in the bundled server image (deploy/Dockerfile.mock).
export const openapiPath = process.env.SMS_CONTRACT_FILE ?? require.resolve("@sms/contract/openapi.yaml");
/** Another file of the contract folder (e.g. access.json), found next to openapi.yaml in the repository, the trial
 *  image and the production release alike: a path relative to the source file breaks once the server is bundled. */
export const contractFile = (name: string): string => join(dirname(openapiPath), name);
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
      tags?: string[];
      parameters?: JsonObject[];
      requestBody?: { content?: Record<string, unknown> };
      responses: Record<string, JsonObject>;
    };
    const pathParams: Record<string, ValidateFunction> = {};
    const queryParams: ContractOperation["queryParams"] = {};
    (op.parameters ?? []).forEach((param, i) => {
      const resolved = resolveRef(param) as {
        name: string;
        in: string;
        required?: boolean;
        schema?: { type?: unknown };
      };
      const base = (param as { $ref?: string }).$ref
        ? (param as { $ref: string }).$ref.slice(2).split("/")
        : ["paths", path, m, "parameters", String(i)];
      if (resolved.in === "path") pathParams[resolved.name] = compile(...base, "schema");
      if (resolved.in === "query") {
        const type = (resolveRef(resolved.schema) as { type?: unknown } | undefined)?.type;
        queryParams[resolved.name] = {
          validate: compile(...base, "schema"),
          required: resolved.required === true,
          numeric: type === "integer" || type === "number",
          boolean: type === "boolean",
        };
      }
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
      tag: op.tags?.[0] ?? "",
      method: m.toUpperCase() as ContractOperation["method"],
      path,
      routePath: path.replace(/\{([^}]+)\}/g, ":$1"),
      validateBody: op.requestBody?.content?.["application/json"]
        ? compile("paths", path, m, "requestBody", "content", "application/json", "schema")
        : undefined,
      pathParams,
      queryParams,
      responses,
    };
  }),
);

export const contractVersion = document.info.version;
