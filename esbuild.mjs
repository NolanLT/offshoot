import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

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
