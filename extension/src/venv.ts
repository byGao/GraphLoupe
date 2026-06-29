/**
 * Managed sidecar venv (P0-3b, D1 dual-environment).
 *
 * The sidecar (FastAPI server) runs in a GraphLoupe-managed venv so the user's project
 * interpreter never needs fastapi/uvicorn — only langgraph (which it already has). The
 * worker still runs in the user's interpreter (P0-3a). Pure path/decision logic lives
 * here (unit-tested in venv.test.ts); the create+pip-install orchestration with progress
 * UI is in extension.ts.
 *
 * The venv lives in the extension's globalStorage (machine-level, reused across projects),
 * not the user's project — sidecar deps are project-independent. A venv is not subject to
 * PEP 668 "externally-managed", so this also sidesteps that bootstrap risk.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

/**
 * The sidecar's runtime deps (mirrors the HTTP/WebSocket section of requirements.lock).
 * No langgraph — the sidecar never imports it; only the worker (user interpreter) does.
 */
export const SIDECAR_VENV_DEPS = [
  "fastapi==0.115.0",
  "uvicorn==0.30.6",
  "starlette==0.38.6",
  "websockets==16.0",
] as const;

/** The interpreter inside a venv, by platform layout. Uses the target platform's path
 *  flavour (not the host's) so the layout is correct regardless of where it's computed. */
export function venvPython(venvRoot: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.win32.join(venvRoot, "Scripts", "python.exe")
    : path.posix.join(venvRoot, "bin", "python");
}

export interface VenvProbe {
  /** the venv interpreter file is present */
  pythonExists: boolean;
  /** it can import the sidecar deps (false => half-built / interrupted install) */
  importsDeps: boolean;
}

/**
 * Whether the managed venv must be (re)bootstrapped: missing interpreter, or present but
 * unable to import the sidecar deps. Pure — given a probe.
 */
export function needsBootstrap(probe: VenvProbe): boolean {
  return !probe.pythonExists || !probe.importsDeps;
}

/** Real probe of a managed venv (node-only IO; the decision it feeds is unit-tested). */
export function probeVenv(venvRoot: string, platform: NodeJS.Platform): VenvProbe {
  const py = venvPython(venvRoot, platform);
  if (!existsSync(py)) return { pythonExists: false, importsDeps: false };
  const r = spawnSync(py, ["-c", "import fastapi, uvicorn, starlette"], { timeout: 8000 });
  return { pythonExists: true, importsDeps: r.status === 0 };
}
