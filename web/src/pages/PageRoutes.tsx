// The route tree each tab renders from its own path (§13.5).
import { Route, Routes } from "react-router";
import { PAGES } from "../nav/registry";
import { ChangeHistoryPage } from "./ChangeHistoryPage";
import { EnterprisePage } from "./enterprise/EnterprisePage";
import { EnterprisesPage } from "./EnterprisesPage";
import { HomePage } from "./HomePage";
import { NotFoundPage, PlaceholderPage } from "./PlaceholderPage";
import { TrunkPage } from "./trunk/TrunkPage";
import { TrunksPage } from "./TrunksPage";

const BUILT = new Set(["/enterprises", "/enterprises/customer-trunks", "/enterprises/vendor-trunks", "/admin/changes"]);

export function PageRoutes({ path }: { path: string }) {
  return (
    <Routes location={path}>
      <Route path="/" element={<HomePage />} />
      <Route path="/enterprises" element={<EnterprisesPage />} />
      <Route path="/enterprises/new" element={<EnterprisePage />} />
      <Route path="/enterprises/customer-trunks" element={<TrunksPage kind="customer" />} />
      <Route path="/enterprises/vendor-trunks" element={<TrunksPage kind="vendor" />} />
      <Route path="/enterprises/customer-trunks/:id" element={<TrunkPage key="customer" kind="customer" />} />
      <Route path="/enterprises/vendor-trunks/:id" element={<TrunkPage key="vendor" kind="vendor" />} />
      <Route path="/enterprises/:id" element={<EnterprisePage />} />
      <Route path="/admin/changes" element={<ChangeHistoryPage />} />
      {PAGES.filter((p) => !BUILT.has(p.path)).map((p) => (
        <Route key={p.key} path={p.path} element={<PlaceholderPage page={p} />} />
      ))}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
