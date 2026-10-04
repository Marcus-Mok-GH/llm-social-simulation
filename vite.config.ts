import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Freebuff requires HMR disabled and the dev server bound to 0.0.0.0.
export default defineConfig({
  // The game reads its model credentials straight from the environment so the
  // key never has to be written to a file. `BERGET_API_KEY` is the deployment
  // variable; `VITE_LLM_*` lets you override endpoint/model per developer.
  envPrefix: ["VITE_", "BERGET_"],
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
    hmr: false,
  },
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 4173,
  },
});
