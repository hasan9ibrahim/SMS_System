import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
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
import "./styles/mobile.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 15_000 } },
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
