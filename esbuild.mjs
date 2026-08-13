import esbuild from "esbuild";
import { readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

/** @type {import('esbuild').BuildOptions} */
const extOpts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info"
};

// Standalone MCP server — no vscode dependency; bundles the SDK + engine.
/** @type {import('esbuild').BuildOptions} */
const mcpOpts = {
  entryPoints: ["src/mcp/server.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/mcp/server.cjs",
  banner: { js: "#!/usr/bin/env node" },
  // report the real package version over MCP instead of a hardcoded literal
  define: { __OFFSHOOT_VERSION__: JSON.stringify(version) },
  sourcemap: true,
  minify: !watch,
  logLevel: "info"
};

if (watch) {
  const a = await esbuild.context(extOpts);
  const b = await esbuild.context(mcpOpts);
  await a.watch();
  await b.watch();
  console.log("[esbuild] watching extension + mcp...");
} else {
  await Promise.all([esbuild.build(extOpts), esbuild.build(mcpOpts)]);
}
