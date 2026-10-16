// Placeholder page for build-order step 1: proves the web -> contract -> mock path works.
// The app shell (menu, tabs, grid, Ctrl K) is build-order step 3.
import { useEffect, useState } from "react";
import type { Health } from "@sms/contract";
import { api } from "./api/client";

type Theme = "light" | "dark";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    api.GET("/health").then(({ data, error: problem }) => {
      if (data) setHealth(data);
      else setError(problem ? "Mock server returned an error" : "Mock server not reachable");
    }, () => setError("Mock server not reachable (run npm run dev:mock)"));
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header
        style={{
          height: "var(--menu-bar-height)",
          background: "var(--color-menu-bar)",
          color: "#dfe4ec",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          fontWeight: 600,
        }}
      >
        <span>SMS Platform</span>
        <button
          type="button"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          style={{
            background: "transparent",
            color: "inherit",
            border: "var(--border-width) solid #4b5568",
            borderRadius: "var(--radius-sm)",
            padding: "4px 10px",
            font: "inherit",
            cursor: "pointer",
          }}
        >
          {theme === "light" ? "Dark" : "Light"} theme
        </button>
      </header>
      <main style={{ flex: 1, padding: 16 }}>
        <section
          style={{
            background: "var(--color-panel)",
            border: "var(--border-width) solid var(--color-border)",
            borderRadius: "var(--radius-lg)",
            padding: 16,
            maxWidth: 520,
          }}
        >
          <h1 style={{ fontSize: "var(--font-size-title)", margin: "0 0 8px" }}>Repository skeleton</h1>
          <p style={{ color: "var(--color-text-secondary)", margin: "0 0 12px" }}>
            Build-order step 1: contract, type generation and mock server are wired up.
          </p>
          {health ? (
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
              <dt>Status</dt>
              <dd style={{ margin: 0, color: "var(--color-good)" }}>{health.status}</dd>
              <dt>Backend</dt>
              <dd style={{ margin: 0 }}>{health.backend}</dd>
              <dt>Contract</dt>
              <dd style={{ margin: 0 }}>{health.contractVersion}</dd>
              <dt>Server time</dt>
              <dd className="num" style={{ margin: 0, textAlign: "left" }}>{health.serverTime} UTC</dd>
            </dl>
          ) : (
            <p style={{ margin: 0, color: error ? "var(--color-error)" : "var(--color-text-secondary)" }}>
              {error ?? "Connecting to the mock server…"}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
