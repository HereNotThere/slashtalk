import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/app/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:10000",
      "/auth": "http://localhost:10000",
      "/ws": {
        target: "ws://localhost:10000",
        ws: true,
      },
    },
  },
});
