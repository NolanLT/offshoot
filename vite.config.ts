import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Builds the React sidebar into dist/webview/ as predictable filenames so the
// WebviewViewProvider can reference them without parsing a manifest.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "webview"),
  build: {
    outDir: resolve(__dirname, "dist/webview"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, "webview/index.html"),
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "[name].js",
        assetFileNames: "main.[ext]"
      }
    }
  }
});
