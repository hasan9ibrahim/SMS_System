import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies the API and the WebSocket to the mock server now, and to the
// Phoenix backend later; the screens only ever see same-origin /api/v1 and /socket.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", "");
  const target = env.VITE_API_TARGET || "http://127.0.0.1:4010";
  // The live WebSocket stays on the mock until Phoenix Channels carry it (backend step 9: the Elixir API in front).
  const socketTarget = env.VITE_SOCKET_TARGET || target;
  return {
    plugins: [react()],
    envDir: "..",
    build: {
      // Fonts are always files, never inlined as data: URIs (Vite inlines files under 4 KB, e.g. small Roboto
      // subsets), so the Content-Security-Policy needs no data: in font-src (§14, deploy/ansible README).
      assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    },
    server: {
      port: 5173,
      proxy: {
        "/api": { target, changeOrigin: true },
        "/socket": { target: socketTarget.replace(/^http/, "ws"), ws: true },
      },
    },
  };
});
