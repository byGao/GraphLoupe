// Bundles the extension (node/cjs) and the webview (browser/iife) into dist/.
import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

// GraphLoupe's own version (package.json → GitHub Release / .vsix), baked in for the
// health panel; distinct from the langgraph version the worker reports.
const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

const shared = {
  bundle: true, sourcemap: true, logLevel: "info",
  define: { __GL_VERSION__: JSON.stringify(version) },
};

await esbuild.build({
  ...shared,
  entryPoints: ["extension/src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
});

await esbuild.build({
  ...shared,
  entryPoints: ["webview/src/main.tsx"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  loader: { ".css": "css" },
});

console.log("esbuild: extension + webview bundled to dist/");
