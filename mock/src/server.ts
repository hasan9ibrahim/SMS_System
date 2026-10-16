// Builds the Fastify app: one route per contract operation, validated against the contract.
import Fastify, { type FastifyInstance } from "fastify";
import { operations } from "./contract.js";
import { handlers as defaultHandlers, type Handler } from "./handlers.js";
import { ajvErrors, sendProblem } from "./problem.js";
import { registerSocket } from "./live/socket.js";

export const API_PREFIX = "/api/v1";

export interface ServerOptions {
  logger?: boolean;
  /** Serve the Phoenix-protocol WebSocket at /socket/websocket (default true). */
  socket?: boolean;
  handlers?: Partial<Record<string, Handler>>;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  // Document uploads carry up to 10 MB as base64 (§5.2), so the body limit is raised.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024 * 1024 });
  const handlers: Partial<Record<string, Handler>> = options.handlers ?? defaultHandlers;
  if (options.socket !== false) await registerSocket(app);

  await app.register(
    async (api) => {
      for (const op of operations) {
        api.route({
          method: op.method,
          url: op.routePath,
          handler: async (request, reply) => {
            // Path parameters arrive as strings; numeric ones are checked as numbers.
            const params = (request.params ?? {}) as Record<string, unknown>;
            for (const [name, validate] of Object.entries(op.pathParams)) {
              const raw = params[name];
              const value = typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : raw;
              // An invalid ID or list name names no record, so it is a 404 (as the contract lists).
              if (!validate(value)) {
                return sendProblem(reply, 404, `No ${name} "${String(raw)}"`, {
                  errors: ajvErrors(validate.errors, `/${name}`),
                });
              }
              params[name] = value;
            }
            const query = (request.query ?? {}) as Record<string, unknown>;
            for (const [name, param] of Object.entries(op.queryParams)) {
              const raw = query[name];
              if (raw === undefined) {
                if (param.required) {
                  return sendProblem(reply, 400, `Missing query parameter "${name}"`, {
                    errors: [{ path: `/${name}`, message: "required" }],
                  });
                }
                continue;
              }
              const value = param.numeric && typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
              if (!param.validate(value)) {
                return sendProblem(reply, 400, `Invalid query parameter "${name}"`, {
                  errors: ajvErrors(param.validate.errors, `/${name}`),
                });
              }
              query[name] = value;
            }
            if (op.validateBody && !op.validateBody(request.body ?? {})) {
              return sendProblem(reply, 400, "Request body does not match the contract", {
                errors: ajvErrors(op.validateBody.errors),
              });
            }
            const handler = handlers[op.operationId];
            if (!handler) {
              return sendProblem(
                reply,
                501,
                `${op.operationId} is in the contract but not implemented by the mock yet`,
              );
            }
            return handler(request, reply);
          },
        });
      }
    },
    { prefix: API_PREFIX },
  );

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, 404, `No contract operation for ${request.method} ${request.url}`),
  );
  return app;
}
