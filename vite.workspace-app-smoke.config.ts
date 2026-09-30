import { join, resolve } from "node:path";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  plugins: [viteSingleFile()],
  base: "./",
  build: {
    outDir: join(
      process.env.KONTROL_BUILD_OUTPUT_DIR
        ? resolve(process.env.KONTROL_BUILD_OUTPUT_DIR)
        : resolve(__dirname, "dist"),
      "ui",
    ),
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/workspace-app-smoke.html"),
    },
  },
});
