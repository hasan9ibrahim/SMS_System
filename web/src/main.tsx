import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
// Inter, bundled and served from our own origin (§15; no font CDN, so the Content-Security-Policy keeps font-src
// 'self'). Roboto is only for the Live analytics figures (team request, §13.7): regular and bold.
import "@fontsource-variable/inter/wght.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/700.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/grid.css";
import "./styles/record.css";
import "./styles/rates.css";
import "./styles/routing.css";
import "./styles/lookup.css";
import "./styles/reports.css";
import "./styles/admin.css";
import "./styles/monitoring.css";
import "./styles/dashboard.css";
import "./styles/help.css";
import "./styles/calm.css";
import "./styles/brand.css";
import "./styles/mobile.css";

// Figures derived from rates, rules and trunks are read again after any change (team trial round 12): an open Rate
// lookup, Route rules cost column or LCR tab showed what was there before a rate or rule was saved.
const DERIVED: string[][] = [["lookup", "rates"], ["route-vendor-costs"], ["lcr"]];
const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 15_000 } },
  mutationCache: new MutationCache({
    onSuccess: () => {
      for (const queryKey of DERIVED) void queryClient.invalidateQueries({ queryKey });
    },
  }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
