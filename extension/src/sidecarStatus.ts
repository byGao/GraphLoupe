/**
 * Pure sidecar lifecycle state machine (no vscode import, so it's unit-tested in
 * sidecarStatus.test.ts). extension.ts feeds it lifecycle events and renders the
 * resulting status in the status bar; the key distinction is a kill we asked for
 * (-> stopped) vs the process dying on its own (-> failed, with a reason).
 */
export type SidecarState = "idle" | "starting" | "running" | "stopped" | "failed";
export interface SidecarStatus { state: SidecarState; reason?: string }

export type SidecarEvent =
  | { t: "spawn" }
  | { t: "open" }                                  // websocket connected -> running
  | { t: "kill" }                                  // we asked it to stop
  | { t: "spawnError"; reason: string }            // spawn failed (e.g. ENOENT)
  | { t: "connectFail"; reason: string }           // never connected
  | { t: "exit"; expected: boolean; reason?: string }; // process exited

export const initialStatus: SidecarStatus = { state: "idle" };

export function nextStatus(s: SidecarStatus, e: SidecarEvent): SidecarStatus {
  switch (e.t) {
    case "spawn": return { state: "starting" };
    case "open": return { state: "running" };
    case "kill": return { state: "stopped" };
    case "spawnError": return { state: "failed", reason: e.reason };
    case "connectFail": return { state: "failed", reason: e.reason };
    case "exit":
      // an exit we asked for is "stopped"; the process dying on its own is a failure
      return e.expected
        ? { state: "stopped" }
        : { state: "failed", reason: e.reason || "sidecar exited unexpectedly" };
    default:
      return s;
  }
}

export interface StatusLabel { text: string; tooltip: string; warn: boolean }

/** Status-bar presentation for a status (text uses VS Code $(icon) codicons). */
export function statusLabel(s: SidecarStatus): StatusLabel {
  switch (s.state) {
    case "running": return { text: "$(zap) GraphLoupe", tooltip: "GraphLoupe sidecar: running", warn: false };
    case "starting": return { text: "$(sync~spin) GraphLoupe", tooltip: "GraphLoupe sidecar: starting…", warn: false };
    case "stopped": return { text: "$(debug-stop) GraphLoupe", tooltip: "GraphLoupe sidecar: stopped", warn: false };
    case "failed": return { text: "$(error) GraphLoupe", tooltip: `GraphLoupe sidecar failed: ${s.reason ?? "unknown"} — click to restart`, warn: true };
    default: return { text: "$(circle-outline) GraphLoupe", tooltip: "GraphLoupe sidecar: idle", warn: false };
  }
}

/** Turn a spawn 'error' into a human message — ENOENT means Python isn't on PATH. */
export function spawnErrorMessage(err: { code?: string; message?: string }): string {
  if (err.code === "ENOENT") {
    return "Python was not found on your PATH. GraphLoupe needs Python (with the deps "
      + "in requirements.lock) to run its sidecar.";
  }
  return `Failed to start the GraphLoupe sidecar: ${err.message ?? "unknown error"}`;
}
