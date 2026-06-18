/**
 * GraphLoupe extension host (PHASE 1 skeleton).
 *
 * activate -> pick a free port, spawn the Python sidecar (uvicorn) on it, open a
 * Webview panel, connect to /ws, and bridge: ServerEvent -> webview.postMessage,
 * webview ClientCommand -> sidecar WebSocket. dispose/deactivate kills the sidecar.
 */
import * as vscode from "vscode";
import { ChildProcess, spawn } from "node:child_process";
import { AddressInfo, createServer } from "node:net";
import WebSocket from "ws";
import { parseServerEvent } from "../../protocol";

let sidecar: ChildProcess | undefined;
let socket: WebSocket | undefined;

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

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("graphloupe.open", async () => {
      const port = await freePort();
      const entry = vscode.workspace.getConfiguration("graphloupe").get<string>("graphEntry") || "";
      const env = { ...process.env };
      if (entry) env.GRAPHLOUPE_GRAPH = entry; // your graph loads in the isolated worker
      sidecar = spawn("python", ["-m", "graphloupe_sidecar.server", "--port", String(port)], {
        cwd: context.extensionPath,
        env,
      });
      sidecar.stderr?.on("data", (d) => console.error("[sidecar]", d.toString()));

      const panel = vscode.window.createWebviewPanel(
        "graphloupe",
        "GraphLoupe",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = webviewHtml(panel.webview, context.extensionUri);

      try {
        socket = await connect(port, (ev) => panel.webview.postMessage(ev));
      } catch (err) {
        vscode.window.showErrorMessage(`GraphLoupe: ${(err as Error).message}`);
        sidecar?.kill();
        return;
      }
      panel.webview.onDidReceiveMessage((cmd) => socket?.send(JSON.stringify(cmd)));
      panel.onDidDispose(() => {
        socket?.close();
        socket = undefined;
        sidecar?.kill();
        sidecar = undefined;
      });
    }),
  );
}

export function deactivate(): void {
  socket?.close();
  sidecar?.kill();
}
