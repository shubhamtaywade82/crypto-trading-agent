import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  root: resolve(here, "web"),
  resolve: {
    alias: {
      "@": resolve(here, "web/src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4101",
        changeOrigin: true,
        ws: true,
      },
      "/ws": {
        target: "ws://localhost:4101",
        ws: true,
      },
    },
  },
  build: {
    outDir: resolve(here, "dist-web"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
