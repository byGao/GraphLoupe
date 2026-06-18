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
import { ChildProcess, spawn } from "node:child_process";
import { AddressInfo, createServer } from "node:net";
import WebSocket from "ws";
import { parseServerEvent } from "../../protocol";

let sidecar: ChildProcess | undefined;
let socket: WebSocket | undefined;
let panel: vscode.WebviewPanel | undefined;

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

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${css}">
<style>html,body,#root{height:100%;margin:0;background:#0d1117;color:#c9d1d9}</style>
</head><body><div id="root"></div><script src="${js}"></script></body></html>`;
}

function killSidecar(): void {
  socket?.close();
  socket = undefined;
  if (sidecar && sidecar.exitCode === null) sidecar.kill();
  sidecar = undefined;
}

/** (Re)start a session against the current panel: kill any old worker, reset the
 *  webview, then spawn the sidecar with the configured graphEntry + projectRoot. */
async function startSession(context: vscode.ExtensionContext): Promise<void> {
  if (!panel) return;
  killSidecar();
  panel.webview.html = webviewHtml(panel.webview, context.extensionUri); // remount -> clean state

  const cfg = vscode.workspace.getConfiguration("graphloupe");
  const entry = cfg.get<string>("graphEntry") || "";
  const projectRoot =
    cfg.get<string>("projectRoot") || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";

  const env = { ...process.env };
  if (entry) env.GRAPHLOUPE_GRAPH = entry;
  if (projectRoot) env.GRAPHLOUPE_PROJECT_ROOT = projectRoot;

  const port = await freePort();
  sidecar = spawn("python", ["-m", "graphloupe_sidecar.server", "--port", String(port)], {
    cwd: context.extensionPath,
    env,
  });
  sidecar.stderr?.on("data", (d) => console.error("[sidecar]", d.toString()));

  try {
    socket = await connect(port, (ev) => panel?.webview.postMessage(ev));
  } catch (err) {
    vscode.window.showErrorMessage(`GraphLoupe: ${(err as Error).message}`);
    killSidecar();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("graphloupe.open", async () => {
      if (panel) {
        panel.reveal();
      } else {
        panel = vscode.window.createWebviewPanel("graphloupe", "GraphLoupe", vscode.ViewColumn.One, {
          enableScripts: true,
          retainContextWhenHidden: true,
        });
        // register once; forwards to whichever socket the current session holds
        panel.webview.onDidReceiveMessage((cmd) => socket?.send(JSON.stringify(cmd)));
        panel.onDidDispose(() => {
          killSidecar();
          panel = undefined;
        });
      }
      await startSession(context);
    }),
    vscode.commands.registerCommand("graphloupe.reload", async () => {
      if (!panel) {
        vscode.window.showInformationMessage("GraphLoupe: open the graph panel first.");
        return;
      }
      await startSession(context);
    }),
  );
}

export function deactivate(): void {
  killSidecar();
}
