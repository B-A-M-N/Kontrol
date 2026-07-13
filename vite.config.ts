import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig } from "vite";

// Single-file build: the review WebUI (workspace-app.html) is inlined with its
// CSS + JS so it can be served verbatim as an MCP App resource. The ChatGPT
// iframe cannot reach localhost, so no external `/mcp-app-assets/*` fetches are
// allowed — everything must live inside the one HTML document.
export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  plugins: [react(), viteSingleFile()],
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/workspace-app.html"),
    },
  },
});
