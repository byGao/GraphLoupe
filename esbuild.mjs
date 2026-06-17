// Bundles the extension (node/cjs) and the webview (browser/iife) into dist/.
import * as esbuild from "esbuild";

const shared = { bundle: true, sourcemap: true, logLevel: "info" };

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
