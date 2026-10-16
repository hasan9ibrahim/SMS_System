// Operation handlers, keyed by operationId from contract/openapi.yaml.
// Data comes from the PostgreSQL database seeded by the generator (npm run seed:small);
// without it, data operations answer 503 and /me falls back to a demo user.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Health, ListId, operations } from "@sms/contract";
import { contractVersion } from "./contract.js";
import { listFields } from "./lists/fields.js";
import { sendProblem } from "./problem.js";
import { getCurrentUser, getWorkspace, saveWorkspace, updatePreferences } from "./api/session.js";
import { getEnterprise, queryList } from "./api/lists.js";
import { search } from "./api/search.js";
import { createView, deleteView, listViews, updateView } from "./api/views.js";
import { undoChange } from "./api/changes.js";

export type Handler = (request: FastifyRequest, reply: FastifyReply) => unknown;
type OperationId = keyof operations;

const VERSION = "0.2.0";

export const handlers: Partial<Record<OperationId, Handler>> = {
  getHealth: (): Health => ({
    status: "ok",
    version: VERSION,
    contractVersion,
    serverTime: new Date().toISOString(),
    backend: "mock",
  }),

  getCurrentUser: () => getCurrentUser(),
  updatePreferences,
  getWorkspace,
  saveWorkspace,
  search,

  getListFields: (request, reply) => {
    const { list } = request.params as { list: ListId };
    return listFields[list] ?? sendProblem(reply, 404, `Unknown list "${list}"`);
  },

  queryEnterprises: queryList("enterprises"),
  getEnterprise,
  queryUsers: queryList("users"),
  queryChanges: queryList("changes"),
  undoChange,

  listViews,
  createView,
  updateView,
  deleteView,
};
