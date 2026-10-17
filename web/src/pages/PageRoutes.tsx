// The route tree each tab renders from its own path (§13.5).
import { AccessGroupsPage } from "./admin/AccessGroupsPage";
import { AuditTrailPage } from "./admin/AuditTrailPage";
import { BusinessCompaniesPage } from "./admin/BusinessCompaniesPage";
import { CustomerPortalPage } from "./admin/CustomerPortalPage";
import { DepartmentsPage } from "./admin/DepartmentsPage";
import { EmailTemplatesPage } from "./admin/EmailTemplatesPage";
import { LoggedInUsersPage } from "./admin/LoggedInUsersPage";
import { UsersPage } from "./admin/UsersPage";
import { AlertRulesPage } from "./monitoring/alerts/AlertRulesPage";
import { IncidentsPage } from "./monitoring/alerts/IncidentsPage";
import { LiveAnalyticsPage } from "./live/LiveAnalyticsPage";
import { BulkRatingPage } from "./rates/BulkRatingPage";
import { IncomingRnsPage } from "./rates/incoming/IncomingRnsPage";
import { MarketMovesPage } from "./rates/market/MarketMovesPage";
import { LcrPage } from "./routing/lcr/LcrPage";
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { PAGES } from "../nav/registry";
import { ChangeHistoryPage } from "./ChangeHistoryPage";
import { EnterprisePage } from "./enterprise/EnterprisePage";
import { EnterprisesPage } from "./EnterprisesPage";
import { HomePage } from "./HomePage";
import { NotFoundPage, PlaceholderPage } from "./PlaceholderPage";
import { MccmncPage } from "./destinations/MccmncPage";
import { CountriesPage } from "./reference/CountriesPage";
import { MasterTablePage } from "./reference/MasterTablePage";
import { MoBookPage } from "./reference/MoBookPage";
import { ProductCategoriesPage } from "./reference/ProductCategoriesPage";
import { RouteMapPage } from "./routing/RouteMapPage";
import { ReratingPage } from "./routing/ReratingPage";
import { BalancesPage } from "./finance/BalancesPage";
import { BillingCyclesPage } from "./finance/BillingCyclesPage";
import { ChargesPage } from "./finance/ChargesPage";
import { CurrenciesPage } from "./finance/CurrenciesPage";
import { InvoicesPage } from "./finance/InvoicesPage";
import { SoaPage } from "./finance/SoaPage";
import { SoaReportPage } from "./finance/SoaReportPage";
import { VendorInvoicesPage } from "./finance/VendorInvoicesPage";
import { TransactionsPage } from "./finance/TransactionsPage";
import { HlrPage } from "./switch/hlr/HlrPage";
import { NumberListsPage } from "./switch/NumberListsPage";
import { QbrStatsPage } from "./switch/QbrStatsPage";
import { TranslationRulesPage } from "./switch/TranslationRulesPage";
import { BroadcastPage } from "./switch/tools/BroadcastPage";
import { EmailLogsPage } from "./switch/tools/EmailLogsPage";
import { FirewallPage } from "./switch/tools/FirewallPage";
import { NotificationsPage } from "./switch/tools/NotificationsPage";
import { SmsToVoicePage } from "./switch/tools/SmsToVoicePage";
import { TrafficAlertsPage } from "./switch/tools/TrafficAlertsPage";
import { EdrDownloadPage } from "./monitoring/EdrDownloadPage";
import { EdrSearchPage } from "./monitoring/EdrSearchPage";
import { EdrTemplatesPage } from "./monitoring/EdrTemplatesPage";
import { FailedEdrPage } from "./monitoring/FailedEdrPage";
import { NetworkDiagnosisPage } from "./monitoring/NetworkDiagnosisPage";
import { NetworkStatusPage } from "./monitoring/NetworkStatusPage";
import { RepushRequestsPage } from "./monitoring/RepushRequestsPage";
import { RouteSimulatorPage } from "./monitoring/RouteSimulatorPage";
import { SignalingPage } from "./monitoring/SignalingPage";
import { BillingReportPage } from "./reports/BillingReportPage";
import { DailyTrafficAlertsPage } from "./reports/DailyTrafficAlertsPage";
import { ScheduledReportsPage } from "./reports/ScheduledReportsPage";
import { RateManagerPage } from "./rates/RateManagerPage";
import { EnterpriseReportPage } from "./reports/EnterpriseReportPage";
import { TrunkPage } from "./trunk/TrunkPage";
import { TrunksPage } from "./TrunksPage";

// Pages with charts load on first use, so ECharts stays out of the main bundle.
const RouteRulesPage = lazy(() => import("./routing/RouteRulesPage").then((m) => ({ default: m.RouteRulesPage })));
const DashboardPage = lazy(() => import("./dashboard/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const MasterReportPage = lazy(() =>
  import("./reports/MasterReportPage").then((m) => ({ default: m.MasterReportPage })),
);
const SalesReportPage = lazy(() => import("./reports/SalesReportPage").then((m) => ({ default: m.SalesReportPage })));
const NocReportPage = lazy(() => import("./reports/NocReportPage").then((m) => ({ default: m.NocReportPage })));
const RateLookupPage = lazy(() => import("./lookup/RateLookupPage").then((m) => ({ default: m.RateLookupPage })));

const BUILT = new Set([
  "/dashboard",
  "/enterprises",
  "/enterprises/customer-trunks",
  "/enterprises/vendor-trunks",
  "/rates/manager",
  "/rates/bulk",
  "/rates/incoming",
  "/rates/market-moves",
  "/routing/lcr",
  "/rates/mccmnc",
  "/rates/categories",
  "/rates/countries",
  "/rates/master-table",
  "/rates/mo-book",
  "/routing/map",
  "/routing/re-rating",
  "/switch/qbr-stats",
  "/switch/number-lists",
  "/switch/translation-rules",
  "/switch/hlr",
  "/switch/notifications",
  "/switch/email-logs",
  "/switch/firewall",
  "/switch/traffic-alerts",
  "/switch/sms-to-voice",
  "/switch/broadcast",
  "/monitoring/edr",
  "/monitoring/edr-download",
  "/monitoring/edr-templates",
  "/monitoring/failed-edr",
  "/monitoring/network-status",
  "/monitoring/signaling",
  "/monitoring/diagnosis",
  "/monitoring/repush",
  "/routing/simulator",
  "/reports/master",
  "/reports/sales",
  "/reports/billing",
  "/reports/noc",
  "/reports/scheduled",
  "/reports/daily-traffic",
  "/finance/transactions",
  "/finance/invoices",
  "/finance/vendor-invoices",
  "/finance/soa",
  "/finance/soa-report",
  "/finance/currencies",
  "/finance/billing-cycles",
  "/finance/balances",
  "/finance/charges",
  "/reports/enterprise",
  "/routing/rules",
  "/routing/rate-lookup",
  "/admin/changes",
  "/admin/users",
  "/admin/access-groups",
  "/admin/departments",
  "/admin/business-companies",
  "/admin/logged-in",
  "/admin/audit",
  "/admin/email-templates",
  "/admin/customer-portal",
  "/live/analytics",
  "/monitoring/alert-rules",
  "/monitoring/incidents",
]);

export function PageRoutes({ path }: { path: string }) {
  return (
    <Routes location={path}>
      <Route path="/" element={<HomePage />} />
      <Route
        path="/dashboard"
        element={
          <Suspense fallback={<div className="grid-message muted">Loading…</div>}>
            <DashboardPage />
          </Suspense>
        }
      />
      <Route path="/enterprises" element={<EnterprisesPage />} />
      <Route path="/enterprises/new" element={<EnterprisePage />} />
      <Route path="/enterprises/customer-trunks" element={<TrunksPage kind="customer" />} />
      <Route path="/enterprises/vendor-trunks" element={<TrunksPage kind="vendor" />} />
      <Route path="/enterprises/customer-trunks/:id" element={<TrunkPage key="customer" kind="customer" />} />
      <Route path="/enterprises/vendor-trunks/:id" element={<TrunkPage key="vendor" kind="vendor" />} />
      <Route path="/enterprises/:id" element={<EnterprisePage />} />
      <Route path="/rates/manager" element={<RateManagerPage />} />
      <Route path="/rates/mccmnc" element={<MccmncPage />} />
      <Route path="/rates/categories" element={<ProductCategoriesPage />} />
      <Route path="/rates/countries" element={<CountriesPage />} />
      <Route path="/rates/master-table" element={<MasterTablePage />} />
      <Route path="/rates/mo-book" element={<MoBookPage />} />
      <Route path="/routing/map" element={<RouteMapPage />} />
      <Route path="/routing/re-rating" element={<ReratingPage />} />
      <Route path="/switch/qbr-stats" element={<QbrStatsPage />} />
      <Route path="/switch/number-lists" element={<NumberListsPage />} />
      <Route path="/switch/translation-rules" element={<TranslationRulesPage />} />
      <Route path="/switch/hlr" element={<HlrPage />} />
      <Route path="/switch/notifications" element={<NotificationsPage />} />
      <Route path="/switch/email-logs" element={<EmailLogsPage />} />
      <Route path="/switch/firewall" element={<FirewallPage />} />
      <Route path="/switch/traffic-alerts" element={<TrafficAlertsPage />} />
      <Route path="/switch/sms-to-voice" element={<SmsToVoicePage />} />
      <Route path="/switch/broadcast" element={<BroadcastPage />} />
      <Route path="/monitoring/edr" element={<EdrSearchPage />} />
      <Route path="/monitoring/edr-download" element={<EdrDownloadPage />} />
      <Route path="/monitoring/edr-templates" element={<EdrTemplatesPage />} />
      <Route path="/monitoring/failed-edr" element={<FailedEdrPage />} />
      <Route path="/monitoring/network-status" element={<NetworkStatusPage />} />
      <Route path="/monitoring/signaling" element={<SignalingPage />} />
      <Route path="/monitoring/diagnosis" element={<NetworkDiagnosisPage />} />
      <Route path="/monitoring/repush" element={<RepushRequestsPage />} />
      <Route path="/routing/simulator" element={<RouteSimulatorPage />} />
      <Route
        path="/reports/master"
        element={
          <Suspense fallback={<div className="grid-message muted">Loading…</div>}>
            <MasterReportPage />
          </Suspense>
        }
      />
      <Route
        path="/reports/sales"
        element={
          <Suspense fallback={<div className="grid-message muted">Loading…</div>}>
            <SalesReportPage />
          </Suspense>
        }
      />
      <Route
        path="/reports/noc"
        element={
          <Suspense fallback={<div className="grid-message muted">Loading…</div>}>
            <NocReportPage />
          </Suspense>
        }
      />
      <Route path="/reports/billing" element={<BillingReportPage />} />
      <Route path="/reports/scheduled" element={<ScheduledReportsPage />} />
      <Route path="/reports/daily-traffic" element={<DailyTrafficAlertsPage />} />
      <Route path="/finance/transactions" element={<TransactionsPage />} />
      <Route path="/finance/invoices" element={<InvoicesPage />} />
      <Route path="/finance/vendor-invoices" element={<VendorInvoicesPage />} />
      <Route path="/finance/soa" element={<SoaPage />} />
      <Route path="/finance/soa-report" element={<SoaReportPage />} />
      <Route path="/finance/currencies" element={<CurrenciesPage />} />
      <Route path="/finance/billing-cycles" element={<BillingCyclesPage />} />
      <Route path="/finance/balances" element={<BalancesPage />} />
      <Route path="/finance/charges" element={<ChargesPage />} />
      <Route path="/reports/enterprise" element={<EnterpriseReportPage />} />
      <Route
        path="/routing/rate-lookup"
        element={
          <Suspense fallback={<div className="grid-message muted">Loading…</div>}>
            <RateLookupPage />
          </Suspense>
        }
      />
      <Route
        path="/routing/rules"
        element={
          <Suspense fallback={<div className="grid-message muted">Loading…</div>}>
            <RouteRulesPage />
          </Suspense>
        }
      />
      <Route path="/admin/changes" element={<ChangeHistoryPage />} />
      <Route path="/admin/users" element={<UsersPage />} />
      <Route path="/admin/access-groups" element={<AccessGroupsPage />} />
      <Route path="/admin/departments" element={<DepartmentsPage />} />
      <Route path="/admin/business-companies" element={<BusinessCompaniesPage />} />
      <Route path="/admin/logged-in" element={<LoggedInUsersPage />} />
      <Route path="/admin/audit" element={<AuditTrailPage />} />
      <Route path="/admin/email-templates" element={<EmailTemplatesPage />} />
      <Route path="/admin/customer-portal" element={<CustomerPortalPage />} />
      <Route path="/live/analytics" element={<LiveAnalyticsPage />} />
      <Route path="/rates/bulk" element={<BulkRatingPage />} />
      <Route path="/rates/incoming" element={<IncomingRnsPage />} />
      <Route path="/rates/market-moves" element={<MarketMovesPage />} />
      <Route path="/routing/lcr" element={<LcrPage />} />
      <Route path="/monitoring/alert-rules" element={<AlertRulesPage />} />
      <Route path="/monitoring/incidents" element={<IncidentsPage />} />
      {PAGES.filter((p) => !BUILT.has(p.path)).map((p) => (
        <Route key={p.key} path={p.path} element={<PlaceholderPage page={p} />} />
      ))}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
