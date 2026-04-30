import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiUrl = env.VITE_SLASHTALK_API_URL || "http://localhost:10000";
  const wsUrl = apiUrl.replace(/^http/, "ws");

  return {
    base: "/app/",
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": apiUrl,
        "/auth": apiUrl,
        "/ws": {
          target: wsUrl,
          ws: true,
        },
      },
    },
  };
});
