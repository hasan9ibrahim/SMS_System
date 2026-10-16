// Operation handlers, keyed by operationId from contract/openapi.yaml.
// Data comes from the fake data generator (build-order step 2); until then lists are empty.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { CurrentUser, EnterprisePage, Health, ListId, ListQuery, operations } from "@sms/contract";
import { contractVersion } from "./contract.js";
import { listFields } from "./lists/fields.js";
import { checkListQuery } from "./lists/validate.js";
import { sendProblem } from "./problem.js";

export type Handler = (request: FastifyRequest, reply: FastifyReply) => unknown;
type OperationId = keyof operations;

const VERSION = "0.1.0";

// Fake signed-in user (CLAUDE.md rule 1: no real names). Auth arrives with §13.28.
const demoUser: CurrentUser = {
  id: 1,
  username: "demo.admin",
  displayName: "Demo Admin",
  initials: "DA",
  role: "Admin",
  businessCompany: "Demo Carrier Ltd (fake)",
  preferences: { theme: "light", openInNewTab: true, animations: true },
  permissions: ["*"],
};

export const handlers: Partial<Record<OperationId, Handler>> = {
  getHealth: (): Health => ({
    status: "ok",
    version: VERSION,
    contractVersion,
    serverTime: new Date().toISOString(),
    backend: "mock",
  }),

  getCurrentUser: (): CurrentUser => demoUser,

  getListFields: (request, reply) => {
    const { list } = request.params as { list: ListId };
    return listFields[list] ?? sendProblem(reply, 404, `Unknown list "${list}"`);
  },

  queryEnterprises: (request, reply): EnterprisePage | FastifyReply => {
    const query = request.body as ListQuery;
    const errors = checkListQuery(query, listFields.enterprises);
    if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
    return { rows: [], total: 0, totalIsEstimate: false, nextCursor: null };
  },

  getEnterprise: (request, reply) => {
    const { id } = request.params as { id: number };
    return sendProblem(reply, 404, `Enterprise ${id} not found`);
  },
};
