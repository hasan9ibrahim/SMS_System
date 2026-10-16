// The route tree each tab renders from its own path (§13.5).
import { Route, Routes } from "react-router";
import { PAGES } from "../nav/registry";
import { ChangeHistoryPage } from "./ChangeHistoryPage";
import { EnterpriseDetailPage } from "./EnterpriseDetailPage";
import { EnterprisesPage } from "./EnterprisesPage";
import { HomePage } from "./HomePage";
import { NotFoundPage, PlaceholderPage, TrunkPlaceholder } from "./PlaceholderPage";

const BUILT = new Set(["/enterprises", "/admin/changes"]);

export function PageRoutes({ path }: { path: string }) {
  return (
    <Routes location={path}>
      <Route path="/" element={<HomePage />} />
      <Route path="/enterprises" element={<EnterprisesPage />} />
      <Route path="/enterprises/:kind/:id" element={<TrunkPlaceholder />} />
      <Route path="/enterprises/:id" element={<EnterpriseDetailPage />} />
      <Route path="/admin/changes" element={<ChangeHistoryPage />} />
      {PAGES.filter((p) => !BUILT.has(p.path)).map((p) => (
        <Route key={p.key} path={p.path} element={<PlaceholderPage page={p} />} />
      ))}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
