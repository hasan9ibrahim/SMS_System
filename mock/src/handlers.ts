// Operation handlers, keyed by operationId from contract/openapi.yaml.
// Data comes from the PostgreSQL database seeded by the generator (npm run seed:small);
// without it, data operations answer 503 and /me falls back to a demo user.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Health, ListId, operations } from "@sms/contract";
import { contractVersion } from "./contract.js";
import { listFields } from "./lists/fields.js";
import { sendProblem } from "./problem.js";
import { getCurrentUser, getWorkspace, saveWorkspace, updatePreferences } from "./api/session.js";
import { queryList } from "./api/lists.js";
import {
  archiveEnterprise,
  createEnterprise,
  deleteEnterpriseDoc,
  downloadEnterpriseDoc,
  getAccountManagerHistory,
  getEnterprise,
  getEnterpriseBilling,
  getEnterpriseDependencies,
  handOverEnterprise,
  listEnterpriseDocs,
  restoreEnterprise,
  updateEnterprise,
  updateEnterpriseBilling,
  uploadEnterpriseDoc,
} from "./api/enterprises.js";
import {
  archiveTrunk,
  createTrunk,
  getTrunk,
  getTrunkDependencies,
  getTrunkRules,
  restoreTrunk,
  updateTrunk,
  updateTrunkRules,
} from "./api/trunks.js";
import { getReference } from "./api/reference.js";
import {
  archiveRouteRule,
  bulkRouteRules,
  cloneRouteRule,
  createRouteRule,
  exportRouteRules,
  getRouteRule,
  getRouteRuleDependencies,
  getRouteRuleTraffic,
  queryRouteRules,
  restoreRouteRule,
  simulateRoute,
  testRouteRule,
  updateRouteRule,
} from "./api/routeRules.js";
import { withEnumsFromDb } from "./lists/dynamic.js";
import {
  archiveRateTable,
  changeRateLines,
  createRateTable,
  exportRateLines,
  getRateTable,
  getRateTableDependencies,
  queryRateLines,
  queryRateTables,
  restoreRateTable,
  updateRateTable,
} from "./api/rates.js";
import {
  createSavedLookup,
  deleteSavedLookup,
  exportRateLookupMatrix,
  listSavedLookups,
  lookupRates,
  rateLookupMatrix,
  resolveLookupDestinations,
  updateSavedLookup,
  clearRoutingCostCache,
} from "./api/rateLookup.js";
import { setDestinationDlrTarget } from "./api/destinations.js";
import { clearRouteMaps, exportRouteMap, queryRouteMap } from "./api/routeMap.js";
import {
  approveReratingRequest,
  createReratingRequest,
  declineReratingRequest,
  getReratingRequest,
  previewRerating,
  updateReratingRequest,
} from "./api/rerating.js";
import { clearQbrOverride, setQbrVendorOverride } from "./api/qbr.js";
import {
  archiveDestination,
  archiveDialCodeProfile,
  archiveMoNumber,
  archiveProductCategory,
  createCountry,
  createDestination,
  createDialCode,
  createDialCodeProfile,
  createMoNumber,
  createProductCategory,
  deleteDialCodes,
  exportCountries,
  exportDestinations,
  exportDialCodes,
  exportMoNumbers,
  getDestinationDependencies,
  getProductCategoryDependencies,
  importDestinations,
  importDialCodes,
  importMoNumbers,
  queryDialCodes,
  restoreDestination,
  restoreDialCodeProfile,
  restoreMoNumber,
  restoreProductCategory,
  updateCountry,
  updateDestination,
  updateDialCode,
  updateDialCodeProfile,
  updateMoNumber,
  updateProductCategory,
} from "./api/masterData.js";
import { exportEnterpriseReport, queryEnterpriseReport } from "./api/enterpriseReport.js";
import { search } from "./api/search.js";
import { createView, deleteView, listViews, updateView } from "./api/views.js";
import { undoChange } from "./api/changes.js";

/** Routing costs and route maps are cached a minute; rate changes and undos clear them. */
const clearRouteCaches = () => {
  clearRoutingCostCache();
  clearRouteMaps();
};

/** QBR stats need the side ("QBR Stats For"): one list per side, never both mixed. */
const queryQbrStatsList: Handler = (request, reply) => {
  const q = request.body as { filter?: { logic: string; conditions: { field?: string; op?: string }[] } };
  const top = !q.filter || q.filter.logic === "and" ? (q.filter?.conditions ?? []) : [];
  if (!top.some((c) => c.field === "side" && c.op === "eq"))
    return sendProblem(reply, 400, "Invalid list query", {
      errors: [{ path: "/filter", message: "the filter needs a top-level side eq condition" }],
    });
  return queryList("qbr_stats")(request, reply);
};

export type Handler = (request: FastifyRequest, reply: FastifyReply) => unknown;
type OperationId = keyof operations;

const VERSION = "0.12.0";

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
    if (!listFields[list]) return sendProblem(reply, 404, `Unknown list "${list}"`);
    return withEnumsFromDb(list, listFields[list]);
  },

  getReference,

  // Enterprises (§5.1–5.3, §13.29, §13.30)
  queryEnterprises: queryList("enterprises"),
  createEnterprise,
  getEnterprise,
  updateEnterprise,
  getEnterpriseDependencies,
  archiveEnterprise,
  restoreEnterprise,
  getEnterpriseBilling,
  updateEnterpriseBilling,
  getAccountManagerHistory,
  handOverEnterprise,
  listEnterpriseDocs,
  uploadEnterpriseDoc,
  deleteEnterpriseDoc,
  downloadEnterpriseDoc,

  // Trunks (§5.4, §5.5, §13.1, §13.2, §13.26)
  queryCustomerTrunks: queryList("customer_trunks"),
  createCustomerTrunk: createTrunk("customer"),
  getCustomerTrunk: getTrunk("customer"),
  updateCustomerTrunk: updateTrunk("customer"),
  getCustomerTrunkDependencies: getTrunkDependencies("customer"),
  archiveCustomerTrunk: archiveTrunk("customer"),
  restoreCustomerTrunk: restoreTrunk("customer"),
  getCustomerTrunkRules: getTrunkRules("customer"),
  updateCustomerTrunkRules: updateTrunkRules("customer"),
  queryVendorTrunks: queryList("vendor_trunks"),
  createVendorTrunk: createTrunk("vendor"),
  getVendorTrunk: getTrunk("vendor"),
  updateVendorTrunk: updateTrunk("vendor"),
  getVendorTrunkDependencies: getTrunkDependencies("vendor"),
  archiveVendorTrunk: archiveTrunk("vendor"),
  restoreVendorTrunk: restoreTrunk("vendor"),
  getVendorTrunkRules: getTrunkRules("vendor"),
  updateVendorTrunkRules: updateTrunkRules("vendor"),

  // Rate Manager (§13.12)
  queryRateTables,
  createRateTable,
  getRateTable,
  updateRateTable,
  getRateTableDependencies,
  archiveRateTable,
  restoreRateTable,
  exportRateLines,
  queryRateLines,
  // Routing costs are cached a minute; a rate change or an undo clears them (api/rateLookup.ts).
  changeRateLines: (request, reply) => Promise.resolve(changeRateLines(request, reply)).finally(clearRouteCaches),
  queryDestinations: queryList("destinations"),

  // Route rules (§6.3, §13.8–13.11, §13.27, §15.4)
  queryRouteRules,
  exportRouteRules,
  createRouteRule,
  getRouteRule,
  updateRouteRule,
  getRouteRuleDependencies,
  archiveRouteRule,
  restoreRouteRule,
  cloneRouteRule,
  bulkRouteRules,
  getRouteRuleTraffic,
  testRouteRule,
  simulateRoute,
  setDestinationDlrTarget,
  queryEnterpriseReport,
  exportEnterpriseReport,
  resolveLookupDestinations,
  lookupRates,
  rateLookupMatrix,
  exportRateLookupMatrix,
  listSavedLookups,
  createSavedLookup,
  updateSavedLookup,
  deleteSavedLookup,
  // Route map, Re-rating, QBR stats (§6.3)
  queryRouteMap,
  exportRouteMap,
  queryReratingRequests: queryList("rerating_requests"),
  previewRerating,
  createReratingRequest,
  getReratingRequest,
  updateReratingRequest,
  approveReratingRequest,
  declineReratingRequest,
  queryQbrStats: queryQbrStatsList,
  setQbrVendorOverride,
  clearQbrOverride,

  // Product reference data (§6.1)
  queryProductCategories: queryList("product_categories"),
  createProductCategory,
  updateProductCategory,
  getProductCategoryDependencies,
  archiveProductCategory,
  restoreProductCategory,
  queryCountries: queryList("countries"),
  createCountry,
  updateCountry,
  exportCountries,
  createDestination,
  updateDestination,
  getDestinationDependencies,
  archiveDestination,
  restoreDestination,
  importDestinations,
  exportDestinations,
  queryDialCodeProfiles: queryList("dial_code_profiles"),
  createDialCodeProfile,
  updateDialCodeProfile,
  archiveDialCodeProfile,
  restoreDialCodeProfile,
  importDialCodes,
  exportDialCodes,
  queryDialCodes,
  createDialCode,
  updateDialCode,
  deleteDialCodes,
  queryMoNumbers: queryList("mo_numbers"),
  createMoNumber,
  updateMoNumber,
  archiveMoNumber,
  restoreMoNumber,
  importMoNumbers,
  exportMoNumbers,

  queryUsers: queryList("users"),
  queryChanges: queryList("changes"),
  undoChange: (request, reply) => Promise.resolve(undoChange(request, reply)).finally(clearRouteCaches),

  listViews,
  createView,
  updateView,
  deleteView,
};
