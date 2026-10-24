// Builds the Fastify app: one route per contract operation, validated against the contract.
import Fastify, { type FastifyInstance } from "fastify";
import { operations, type ContractOperation } from "./contract.js";
import { handlers as defaultHandlers, type Handler } from "./handlers.js";
import { ajvErrors, sendProblem } from "./problem.js";
import { registerSocket } from "./live/socket.js";
import { auditCall } from "./api/audit.js";
import { GATE_OPEN, isBlocked } from "./admin/gate.js";
import { contextOf, currentViewer, runWithVisibility, type VisibilityContext } from "./visibility/context.js";
import { restricts } from "./visibility/policy.js";
import { maskPayload } from "./visibility/walk.js";
import { isPortalOperation } from "./api/portal.js";

export const API_PREFIX = "/api/v1";

export interface ServerOptions {
  logger?: boolean;
  /** Serve the Phoenix-protocol WebSocket at /socket/websocket (default true). */
  socket?: boolean;
  handlers?: Partial<Record<string, Handler>>;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  // Document uploads carry up to 10 MB as base64 (§5.2), so the body limit is raised.
  // Behind the trial instance's nginx, the client IP (audit trail, sessions) comes from X-Forwarded-For.
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === "1",
  });
  const handlers: Partial<Record<string, Handler>> = options.handlers ?? defaultHandlers;
  if (options.socket !== false) await registerSocket(app);

  await app.register(
    async (api) => {
      for (const op of operations) {
        api.route({
          method: op.method,
          url: op.routePath,
          config: { op },
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
              const value =
                param.numeric && typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw)
                  ? Number(raw)
                  : param.boolean && (raw === "true" || raw === "false")
                    ? raw === "true"
                    : raw;
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
            // The customer portal has its own sign-in and sees only its own data: no staff gate or visibility.
            if (isPortalOperation(op.operationId)) return handler(request, reply);
            // An expired, temporary or must-change password opens only the Change Password screen (§13.28).
            if (!GATE_OPEN.has(op.operationId) && (await isBlocked()))
              return sendProblem(reply, 403, "Change your password to continue", {
                detail: "Your password expired or must be changed. Only the Change Password screen works until then.",
                code: "password_change_required",
              });
            // The viewer and their visibility policy follow the request (§13.17).
            const ctx = contextOf(request);
            (request as unknown as { vis?: VisibilityContext }).vis = ctx;
            return runWithVisibility(ctx, () => handler(request, reply));
          },
        });
      }
    },
    { prefix: API_PREFIX },
  );

  // Masked names in JSON answers outside the list engine (§13.17).
  app.addHook("preSerialization", async (request, reply, payload) => {
    const ctx = (request as unknown as { vis?: VisibilityContext }).vis;
    if (!ctx || reply.statusCode >= 300 || payload === null || typeof payload !== "object") return payload;
    const v = await currentViewer(ctx);
    return restricts(v) && v.policy.maskOthers ? maskPayload(payload, v) : payload;
  });

  // Audit Trail (§11): every call that changes something, after its answer is sent.
  app.addHook("onResponse", async (request, reply) => {
    const op = (request.routeOptions.config as { op?: ContractOperation }).op;
    if (op && !isPortalOperation(op.operationId)) auditCall(op, request, reply);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, 404, `No contract operation for ${request.method} ${request.url}`),
  );
  return app;
}
