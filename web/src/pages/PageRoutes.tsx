// The route tree each tab renders from its own path (§13.5).
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
import { QbrStatsPage } from "./switch/QbrStatsPage";
import { RateManagerPage } from "./rates/RateManagerPage";
import { EnterpriseReportPage } from "./reports/EnterpriseReportPage";
import { TrunkPage } from "./trunk/TrunkPage";
import { TrunksPage } from "./TrunksPage";

// Pages with charts load on first use, so ECharts stays out of the main bundle.
const RouteRulesPage = lazy(() => import("./routing/RouteRulesPage").then((m) => ({ default: m.RouteRulesPage })));
const DashboardPage = lazy(() => import("./dashboard/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const RateLookupPage = lazy(() => import("./lookup/RateLookupPage").then((m) => ({ default: m.RateLookupPage })));

const BUILT = new Set([
  "/dashboard",
  "/enterprises",
  "/enterprises/customer-trunks",
  "/enterprises/vendor-trunks",
  "/rates/manager",
  "/rates/mccmnc",
  "/rates/categories",
  "/rates/countries",
  "/rates/master-table",
  "/rates/mo-book",
  "/routing/map",
  "/routing/re-rating",
  "/switch/qbr-stats",
  "/reports/enterprise",
  "/routing/rules",
  "/routing/rate-lookup",
  "/admin/changes",
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
      {PAGES.filter((p) => !BUILT.has(p.path)).map((p) => (
        <Route key={p.key} path={p.path} element={<PlaceholderPage page={p} />} />
      ))}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
