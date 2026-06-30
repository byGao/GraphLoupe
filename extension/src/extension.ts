/**
 * GraphLoupe extension host.
 *
 * "GraphLoupe: Open Graph Panel" opens a Webview and starts a session: pick a free
 * port, spawn the Python sidecar (with graphEntry + projectRoot from settings), connect
 * to /ws, and bridge ServerEvent -> webview / ClientCommand -> sidecar. The user graph
 * loads relative to projectRoot (default: the first workspace folder) in an isolated worker.
 * "GraphLoupe: Reload Graph" restarts the session in place (re-reads settings, re-spawns).
 */
import * as vscode from "vscode";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { AddressInfo, createServer } from "node:net";
import { mkdirSync } from "node:fs";
import WebSocket from "ws";
import { parseServerEvent } from "../../protocol";
import {
  initialStatus, nextStatus, statusLabel, spawnErrorMessage,
  type SidecarStatus, type SidecarEvent,
} from "./sidecarStatus";
import {
  resolvePython, fallbackCandidates, probeExists, runDoctor,
  doctorMessage, interpreterNotFoundMessage, pyLabel, type PyCommand,
} from "./python";
import { venvPython, probeVenv, needsBootstrap, SIDECAR_VENV_DEPS } from "./venv";
import * as path from "node:path";

interface GraphEntry { entry: string; file: string; line: number }

let sidecar: ChildProcess | undefined;
let socket: WebSocket | undefined;
let panel: vscode.WebviewPanel | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let status: SidecarStatus = initialStatus;
const expectedKills = new WeakSet<ChildProcess>();  // children we asked to stop
let stderrTail: string[] = [];
let interpreterLabel: string | undefined;  // resolved Python, shown in the status-bar tooltip

/** Advance the lifecycle status and reflect it in the status bar. */
function setStatus(ev: SidecarEvent): void {
  status = nextStatus(status, ev);
  if (!statusBar) return;
  const label = statusLabel(status);
  statusBar.text = label.text;
  statusBar.tooltip = interpreterLabel ? `${label.tooltip}\nPython: ${interpreterLabel}` : label.tooltip;
  statusBar.backgroundColor = label.warn
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
}

function resolveProjectRoot(): string {
  const cfg = vscode.workspace.getConfiguration("graphloupe");
  return cfg.get<string>("projectRoot") || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
}

/** ms-python.python's active interpreter path, or undefined if the extension is
 *  absent / inactive / errors — a soft dependency, never throws (R-02). */
async function msPythonInterpreter(): Promise<string | undefined> {
  try {
    const ext = vscode.extensions.getExtension("ms-python.python");
    if (!ext) return undefined;
    // ms-python's API is untyped here (no @types); treat it dynamically.
    const api: any = ext.isActive ? ext.exports : await ext.activate();  // eslint-disable-line @typescript-eslint/no-explicit-any
    const envs = api?.environments;
    if (!envs?.getActiveEnvironmentPath) return undefined;
    const active = envs.getActiveEnvironmentPath();
    if (!active) return undefined;
    const resolved = await envs.resolveEnvironment?.(active);
    return resolved?.executable?.uri?.fsPath ?? active.path;
  } catch {
    return undefined;
  }
}

/** Resolve the Python interpreter for the sidecar/discover spawns (P0-3a):
 *  graphloupe.pythonPath > ms-python active env > PATH fallback. undefined = none runs.
 *  3a is single-environment, so the worker inherits this via the sidecar's sys.executable. */
async function resolveInterpreter(): Promise<PyCommand | undefined> {
  const configPath = vscode.workspace.getConfiguration("graphloupe").get<string>("pythonPath") || "";
  const msPythonPath = await msPythonInterpreter();
  return resolvePython({
    configPath,
    msPythonPath,
    fallback: fallbackCandidates(process.platform),
    exists: probeExists,
  });
}

/** Resolve a PyCommand (possibly `py -3`) to a concrete interpreter path, so the worker
 *  can be launched by a single executable (GRAPHLOUPE_WORKER_PYTHON). Falls back to the
 *  command itself if introspection fails. */
function concreteExecutable(py: PyCommand): string {
  try {
    const r = spawnSync(py.command, [...py.args, "-c", "import sys;print(sys.executable)"],
      { encoding: "utf8", timeout: 8000 });
    const out = (r.stdout || "").trim();
    if (r.status === 0 && out) return out;
  } catch { /* fall through */ }
  return py.command;
}

/** Run a child process to completion, capturing stderr (no shell). */
function runProc(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(command, args);
    let stderr = "";
    p.stderr?.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => resolve({ code: null, stderr: e.message }));
    p.on("close", (code) => resolve({ code, stderr }));
  });
}

/** Ensure the managed sidecar venv (P0-3b): reuse it if it already imports the sidecar
 *  deps; otherwise create it with the user's interpreter and pip-install the deps, with a
 *  one-time progress notification. Returns the venv interpreter path, or undefined on
 *  failure (after surfacing an actionable error). */
async function ensureSidecarVenv(
  context: vscode.ExtensionContext, userPy: PyCommand,
): Promise<string | undefined> {
  const venvRoot = path.join(context.globalStorageUri.fsPath, "sidecar-venv");
  const platform = process.platform;
  if (!needsBootstrap(probeVenv(venvRoot, platform))) return venvPython(venvRoot, platform);

  let err: string | undefined;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, cancellable: false,
      title: "GraphLoupe: preparing the sidecar environment (one-time)…" },
    async (progress) => {
      try {
        mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
        progress.report({ message: "creating virtual environment" });
        const mk = await runProc(userPy.command, [...userPy.args, "-m", "venv", venvRoot]);
        if (mk.code !== 0) { err = `venv creation failed: ${mk.stderr.trim().slice(-300)}`; return; }
        progress.report({ message: "installing fastapi · uvicorn · starlette" });
        const pip = await runProc(venvPython(venvRoot, platform),
          ["-m", "pip", "install", "--disable-pip-version-check", ...SIDECAR_VENV_DEPS]);
        if (pip.code !== 0) { err = `pip install failed: ${pip.stderr.trim().slice(-300)}`; return; }
      } catch (e) {
        err = (e as Error).message;
      }
    },
  );
  if (err || needsBootstrap(probeVenv(venvRoot, platform))) {
    setStatus({ t: "spawnError", reason: "sidecar env setup failed" });
    void vscode.window.showErrorMessage(
      `GraphLoupe: could not set up the sidecar environment. ${err ?? "deps still missing after install."} `
      + "Check that the selected Python can create venvs and reach PyPI.");
    return undefined;
  }
  return venvPython(venvRoot, platform);
}

/** AST-scan the project for build_graph entries (no user code is executed). */
async function discoverGraphs(context: vscode.ExtensionContext, projectRoot: string): Promise<GraphEntry[]> {
  if (!projectRoot) return [];
  const py = await resolveInterpreter();
  if (!py) return [];
  return new Promise((resolve) => {
    const proc = spawn(
      py.command,
      [...py.args, "-m", "graphloupe_sidecar.discover", "--project-root", projectRoot],
      { cwd: context.extensionPath, env: process.env },
    );
    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.on("error", () => resolve([]));
    proc.on("close", () => {
      try {
        resolve(JSON.parse(out) as GraphEntry[]);
      } catch {
        resolve([]);
      }
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function connect(port: number, onEvent: (ev: unknown) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      sock.on("open", () => resolve(sock));
      sock.on("message", (data) => {
        try {
          onEvent(parseServerEvent(JSON.parse(data.toString())));
        } catch (err) {
          console.error("[graphloupe] bad server event", err);
        }
      });
      sock.on("error", () => {
        if (left <= 0) reject(new Error("sidecar connect failed"));
        else setTimeout(() => attempt(left - 1), 300);
      });
    };
    attempt(20);
  });
}

/** postMessage to the webview, swallowing the rejection that fires when the
 *  webview was disposed (e.g. on window reload) between a late sidecar event
 *  and its delivery. Without this the floating Thenable surfaces as an
 *  unhandled promise rejection with a VS-Code-internal-only stack. */
function postToWebview(message: unknown): void {
  void panel?.webview.postMessage(message).then(undefined, () => undefined);
}

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${css}">
<style>html,body,#root{height:100%;margin:0}body{background:#0e1116}</style>
</head><body><div id="root"></div><script src="${js}"></script></body></html>`;
}

/** P1-1: open a node's source file at its def line (1-based). A missing/unopenable
 *  file gives a warning rather than an unhandled rejection. */
async function openSource(file: string, line: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
  } catch {
    void vscode.window.showWarningMessage(`GraphLoupe: couldn't open source file: ${file}`);
  }
}

async function pickFolder(field: string): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Use folder",
  });
  if (picked && picked[0]) {
    postToWebview({ type: "folderPicked", field, path: picked[0].fsPath });
  }
}

function killSidecar(): void {
  socket?.close();
  socket = undefined;
  if (sidecar && sidecar.exitCode === null) {
    expectedKills.add(sidecar);  // so the exit handler reads this as "stopped", not a crash
    sidecar.kill();
  }
  sidecar = undefined;  // status is driven by the exit handler / startSession, not here
}

/** (Re)start a session against the current panel: kill any old worker, reset the
 *  webview, then spawn the sidecar with the configured graphEntry + projectRoot. */
async function startSession(context: vscode.ExtensionContext): Promise<void> {
  if (!panel) return;
  killSidecar();
  panel.webview.html = webviewHtml(panel.webview, context.extensionUri); // remount -> clean state

  const cfg = vscode.workspace.getConfiguration("graphloupe");
  const entry = cfg.get<string>("graphEntry") || "";
  const projectRoot = resolveProjectRoot();

  const env = { ...process.env };
  if (entry) env.GRAPHLOUPE_GRAPH = entry;
  if (projectRoot) env.GRAPHLOUPE_PROJECT_ROOT = projectRoot;

  setStatus({ t: "spawn" });
  stderrTail = [];
  try {
    // P0-3a: resolve the user's interpreter (runs the worker = their graph), then preflight
    // it for langgraph (P0-3b: fastapi now lives in the managed venv, not the user env).
    const py = await resolveInterpreter();
    if (!py) {
      interpreterLabel = undefined;
      setStatus({ t: "spawnError", reason: "no Python interpreter" });
      void vscode.window.showErrorMessage(interpreterNotFoundMessage());
      killSidecar();
      return;
    }
    interpreterLabel = pyLabel(py);
    const doctor = runDoctor(py);
    if (!doctor.ok) {
      const msg = doctor.missing.length ? doctorMessage(py, doctor.missing) : interpreterNotFoundMessage();
      setStatus({
        t: "spawnError",
        reason: doctor.missing.length ? `missing ${doctor.missing.join(", ")}` : "interpreter not runnable",
      });
      void vscode.window.showErrorMessage(msg);
      killSidecar();
      return;
    }

    // P0-3b: the sidecar runs in a managed venv (fastapi/uvicorn); the worker runs in the
    // user's interpreter, passed via GRAPHLOUPE_WORKER_PYTHON.
    const sidecarPy = await ensureSidecarVenv(context, py);
    if (!sidecarPy) { killSidecar(); return; }
    env.GRAPHLOUPE_WORKER_PYTHON = concreteExecutable(py);
    interpreterLabel = `${pyLabel(py)} · sidecar: managed venv`;

    const port = await freePort();
    const child = spawn(sidecarPy, ["-m", "graphloupe_sidecar.server", "--port", String(port)], {
      cwd: context.extensionPath,
      env,
    });
    sidecar = child;
    child.on("error", (err: NodeJS.ErrnoException) => {
      setStatus({ t: "spawnError", reason: err.code ?? err.message });
      void vscode.window.showErrorMessage(spawnErrorMessage(err));
    });
    child.stderr?.on("data", (d) => {
      const text = d.toString();
      console.error("[sidecar]", text);
      stderrTail.push(text);
      if (stderrTail.length > 25) stderrTail = stderrTail.slice(-25);
    });
    child.on("exit", (code, signal) => {
      if (child !== sidecar) return;               // a superseded sidecar — ignore its late exit
      if (expectedKills.has(child)) {              // we asked it to stop
        setStatus({ t: "exit", expected: true });
        return;
      }
      const reason = `sidecar exited (${signal ?? `code ${code}`})`;
      setStatus({ t: "exit", expected: false, reason });
      const tail = stderrTail.join("").trim().split("\n").slice(-3).join("\n");
      void vscode.window
        .showErrorMessage(`GraphLoupe: ${reason}.${tail ? `\n${tail}` : ""}`, "Restart Sidecar")
        .then((pick) => { if (pick === "Restart Sidecar") void startSession(context); });
    });
    socket = await connect(port, (ev) => postToWebview(ev));
    setStatus({ t: "open" });
  } catch (err) {
    setStatus({ t: "connectFail", reason: (err as Error).message });
    vscode.window.showErrorMessage(`GraphLoupe: ${(err as Error).message}`);
    killSidecar();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "graphloupe.restartSidecar";
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("graphloupe.restartSidecar", async () => {
      if (!panel) {
        await vscode.commands.executeCommand("graphloupe.open");
        return;
      }
      await startSession(context);
    }),
    vscode.commands.registerCommand("graphloupe.open", async () => {
      if (panel) {
        panel.reveal();
      } else {
        panel = vscode.window.createWebviewPanel("graphloupe", "GraphLoupe", vscode.ViewColumn.One, {
          enableScripts: true,
          retainContextWhenHidden: true,
        });
        // register once; webview UI actions are intercepted, everything else is a
        // ClientCommand forwarded to the current session's socket.
        panel.webview.onDidReceiveMessage((msg) => {
          if (msg && msg.type === "ui:selectGraph") {
            void Promise.resolve(vscode.commands.executeCommand("graphloupe.selectGraph"))
              .then(undefined, (err) => console.error("[graphloupe] selectGraph", err));
            return;
          }
          if (msg && msg.type === "ui:pickFolder") {
            void pickFolder(msg.field).catch((err) => console.error("[graphloupe] pickFolder", err));
            return;
          }
          if (msg && msg.type === "ui:restart") {  // Stop: abort the run by restarting the sidecar
            void Promise.resolve(vscode.commands.executeCommand("graphloupe.restartSidecar"))
              .then(undefined, (err) => console.error("[graphloupe] restart", err));
            return;
          }
          if (msg && msg.type === "ui:openSource") {  // P1-1: jump to a node's source
            void openSource(msg.file, msg.line).catch((err) => console.error("[graphloupe] openSource", err));
            return;
          }
          try {
            socket?.send(JSON.stringify(msg));
          } catch (err) {
            console.error("[graphloupe] socket send", err);
          }
        });
        panel.onDidDispose(() => {
          killSidecar();
          panel = undefined;
          statusBar?.hide();
        });
      }
      statusBar?.show();
      await startSession(context);
    }),
    vscode.commands.registerCommand("graphloupe.reload", async () => {
      if (!panel) {
        vscode.window.showInformationMessage("GraphLoupe: open the graph panel first.");
        return;
      }
      await startSession(context);
    }),
    vscode.commands.registerCommand("graphloupe.selectGraph", async () => {
      const projectRoot = resolveProjectRoot();
      if (!projectRoot) {
        vscode.window.showWarningMessage("GraphLoupe: open a folder first (no workspace).");
        return;
      }
      const entries = await discoverGraphs(context, projectRoot);
      if (entries.length === 0) {
        vscode.window.showWarningMessage(
          "GraphLoupe: no build_graph() found. Name your entry build_graph, or set graphloupe.graphEntry manually.",
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((e) => ({ label: e.entry, detail: e.file })),
        { placeHolder: "Select a graph (a build_graph function in your project)" },
      );
      if (!picked) return;
      await vscode.workspace
        .getConfiguration("graphloupe")
        .update("graphEntry", picked.label, vscode.ConfigurationTarget.Workspace);
      if (!panel) {
        await vscode.commands.executeCommand("graphloupe.open");
      } else {
        await startSession(context);
      }
    }),
  );
}

export function deactivate(): void {
  killSidecar();
}
