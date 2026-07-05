/**
 * Render the inspector panels (webview/src/panel-harness.tsx) to a PNG for self-review —
 * the VS Code webview can't be driven headlessly, but a pre-bundled static page can.
 * Usage: node tools/render-panels.mjs [outDir]   (default: a temp dir it prints)
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const out = process.argv[2] || mkdtempSync(join(tmpdir(), "gl-panels-"));

await build({
  entryPoints: ["webview/src/panel-harness.tsx"],
  bundle: true,
  outfile: join(out, "harness.js"),
  format: "iife",
  loader: { ".css": "css" },
  // the panels' module reads acquireVsCodeApi() + __GL_VERSION__ at load — stub both
  banner: { js: "globalThis.acquireVsCodeApi = () => ({ postMessage() {} });" },
  define: { __GL_VERSION__: '"harness"' },
  logLevel: "info",
});

writeFileSync(join(out, "harness.html"), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="harness.css"><style>html,body,#root{margin:0}body{background:#010409}</style>
</head><body><div id="root"></div><script src="harness.js"></script></body></html>`);

const png = join(out, "panels.png");
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
execFileSync(edge, [
  "--headless=new", `--screenshot=${png}`, "--window-size=1500,900",
  "--hide-scrollbars", "--force-device-scale-factor=1", "--virtual-time-budget=8000",
  "file:///" + join(out, "harness.html").replace(/\\/g, "/"),
], { stdio: "ignore" });

console.log(png);
