import { buildServer } from "./server.js";
import { startBestBuyRefresh } from "./api/bestbuy.js";
import { startRouteTrafficRefresh } from "./api/routeTraffic.js";
import { startQbrRefresh } from "./api/qbr.js";
import { startHlrRefresh } from "./api/hlr.js";
import { resumeInvoiceRequests } from "./api/invoices.js";
import { startReconIntake } from "./api/vendorInvoices.js";
import { resumeSoaReports } from "./api/soa.js";
import { startTrafficAlertChecks } from "./api/switchTools.js";
import { startEdrDownloads } from "./api/edrDownloads.js";
import { startNetworkStatus } from "./api/network.js";
import { startReportJobs } from "./api/reports.js";
import { startLive } from "./live/socket.js";
import { startRouteCostWarmer } from "./api/routeMap.js";
import { db } from "./db.js";
import { checkPendingRns } from "./api/rn.js";
import { startMarketMoves } from "./api/marketMoves.js";
import { startLcrChecks } from "./api/lcr.js";
import { ensureTeamTargets, startTeamPresence } from "./api/team.js";
import { startCleanupJobs } from "./api/cleanup.js";
import { startSecurityJobs } from "./api/security.js";
import { startFxRefresh } from "./api/fx.js";
import { upgradeOnStart } from "./upgrades.js";

const host = process.env.MOCK_HOST ?? "127.0.0.1";
const port = Number(process.env.MOCK_PORT ?? 4010);

const app = await buildServer({ logger: true });
// Schema changes of a new image are applied to a kept database before serving (team trial round 2).
await upgradeOnStart((msg) => app.log.info(msg));
await app.listen({ host, port });
startBestBuyRefresh();
startRouteTrafficRefresh();
startQbrRefresh();
startHlrRefresh();
void resumeInvoiceRequests();
startReconIntake();
void resumeSoaReports();
startTrafficAlertChecks();
startEdrDownloads();
startNetworkStatus();
startReportJobs();
startLive();
// Routed vendor and cost per sell table, for Rate Manager (team trial round 2).
startRouteCostWarmer(db());
void checkPendingRns();
startMarketMoves();
startLcrChecks();
// Team report (§13.18): fake monthly targets once, and presence for the fake team.
void ensureTeamTargets().catch(() => undefined);
startTeamPresence();
// Cleanup Center (§13.19): the scan shortly after start, then nightly, and the weekly summary.
startCleanupJobs();
startSecurityJobs();
startFxRefresh();
