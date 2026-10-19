import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies the API and the WebSocket to the mock server now, and to the
// Phoenix backend later; the screens only ever see same-origin /api/v1 and /socket.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", "");
  const target = env.VITE_API_TARGET || "http://127.0.0.1:4010";
  return {
    plugins: [react()],
    envDir: "..",
    server: {
      port: 5173,
      proxy: {
        "/api": { target, changeOrigin: true },
        "/socket": { target: target.replace(/^http/, "ws"), ws: true },
      },
    },
  };
});
