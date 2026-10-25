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
import { production, productionProblems } from "./mode.js";
import { whenLeader } from "./jobs/leader.js";
import { startMailer } from "./jobs/mailer.js";
import { startAutoInvoicing } from "./jobs/autoInvoices.js";
import { startImapIntake } from "./jobs/imap.js";
import { startRnReminders } from "./jobs/rnReminders.js";
import { startSwitchJobs } from "./jobs/switchJobs.js";

const host = process.env.MOCK_HOST ?? "127.0.0.1";
const port = Number(process.env.MOCK_PORT ?? 4010);

// Production (backend step 11): refuse to start without what production needs (mode.ts).
if (production) {
  const problems = productionProblems();
  if (problems.length) {
    for (const p of problems) console.error(`SMS_MODE=production: ${p}`);
    process.exit(1);
  }
}

const app = await buildServer({ logger: true });
// Schema changes of a new image are applied to a kept database before serving (team trial round 2). In production the
// release deploy applies the migrations before the services start (deploy/ansible), so a server never changes the
// schema under the other one.
if (!production) await upgradeOnStart((msg) => app.log.info(msg));
await app.listen({ host, port });

// Every server: the live screens (each server's sockets) and its own caches.
startLive();

// One server at a time (jobs/leader.ts): jobs that write shared tables or send e-mail.
whenLeader(() => {
  app.log.info(production ? "this server runs the background jobs" : "background jobs started");
  startBestBuyRefresh();
  startRouteTrafficRefresh();
  startQbrRefresh();
  startHlrRefresh();
  void resumeInvoiceRequests();
  void resumeSoaReports();
  startTrafficAlertChecks();
  startEdrDownloads();
  startReportJobs();
  // Routed vendor and cost per sell table, for Rate Manager (team trial round 2).
  startRouteCostWarmer(db());
  void checkPendingRns();
  startMarketMoves();
  startLcrChecks();
  // Cleanup Center (§13.19): the scan shortly after start, then nightly, and the weekly summary.
  startCleanupJobs();
  startSecurityJobs();
  startFxRefresh();
  // E-mail out of the outbox (jobs/mailer.ts); nothing is queued outside production.
  startMailer();
  if (production) {
    // Auto Invoicing at each billing cycle's end (§12.3); the fake data's history already has its auto invoices.
    startAutoInvoicing();
    // Incoming RNs from the Rates mailboxes (§13.13 A).
    startImapIntake();
    startRnReminders();
    // Capture status, the recording's files, Repush progress and the capture purge from the switch (step 11c).
    startSwitchJobs();
    return;
  }
  // Demo only: the fake vendor-invoice mailbox, the bind simulator, and the fake team's targets and presence (§13.18).
  startReconIntake();
  startNetworkStatus();
  void ensureTeamTargets().catch(() => undefined);
  startTeamPresence();
});
