import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const opts = {
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

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log("[esbuild] watching extension...");
} else {
  await esbuild.build(opts);
}
