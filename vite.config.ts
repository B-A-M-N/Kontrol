import { join, resolve } from "node:path";
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
  // @pierre/diffs defaults to Shiki's JavaScript regex engine. Its optional
  // Oniguruma branch imports an embedded ~8 MB WASM payload even though the
  // Workspace App never selects it. Keep the app's default engine and replace
  // that unused branch with an explicit runtime failure if a future caller
  // tries to opt into WASM.
  resolve: {
    alias: [{
      find: /^shiki$/,
      replacement: resolve(__dirname, "src/ui/shiki-workspace-adapter.js"),
    }, {
      find: /^shiki\/wasm$/,
      replacement: resolve(__dirname, "src/ui/shiki-wasm-unavailable.ts"),
    }],
  },
  base: "./",
  build: {
    outDir: join(
      process.env.KONTROL_BUILD_OUTPUT_DIR
        ? resolve(process.env.KONTROL_BUILD_OUTPUT_DIR)
        : resolve(__dirname, "dist"),
      "ui",
    ),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/workspace-app.html"),
    },
  },
});
