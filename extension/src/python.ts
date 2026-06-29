/**
 * Python interpreter resolution + preflight doctor (P0-3a).
 *
 * Pure + node-only (no vscode import) so it's unit-tested in python.test.ts — the
 * ms-python.python lookup, which IS vscode-coupled, is injected as a plain string by
 * extension.ts. Replaces the hardcoded spawn("python", …) in three places (sidecar,
 * discover; the worker inherits this interpreter via the sidecar's sys.executable).
 *
 * 3a stays single-environment. The managed .graphloupe/venv + worker-on-user-interpreter
 * split (D1) is 3b — out of scope here.
 */
import { spawnSync } from "node:child_process";

export interface PyCommand {
  command: string;
  args: string[];
}

/**
 * PATH fallback candidates, platform-ordered. Windows favours the `py -3` launcher:
 * it's often the only thing present, and a bare `python` there is frequently a
 * Microsoft Store stub that isn't a real interpreter.
 */
export function fallbackCandidates(platform: NodeJS.Platform): PyCommand[] {
  return platform === "win32"
    ? [
        { command: "py", args: ["-3"] },
        { command: "python", args: [] },
        { command: "python3", args: [] },
      ]
    : [
        { command: "python3", args: [] },
        { command: "python", args: [] },
      ];
}

export interface ResolveInputs {
  /** graphloupe.pythonPath — explicit manual override (the escape hatch). */
  configPath?: string;
  /** ms-python.python active interpreter, an absolute path (or undefined if absent). */
  msPythonPath?: string;
  /** Ordered PATH candidates (fallbackCandidates(process.platform)). */
  fallback: PyCommand[];
  /** Probe whether a candidate actually runs; injected so resolvePython stays pure. */
  exists: (cmd: PyCommand) => boolean;
}

/**
 * Resolve the interpreter to spawn. Priority: explicit config > ms-python active env
 * > first working PATH fallback. Pure given `exists`; undefined when nothing resolves
 * (caller shows interpreterNotFoundMessage).
 */
export function resolvePython(inp: ResolveInputs): PyCommand | undefined {
  const cfg = inp.configPath?.trim();
  if (cfg) return { command: cfg, args: [] };
  const ms = inp.msPythonPath?.trim();
  if (ms) return { command: ms, args: [] };
  return inp.fallback.find((c) => inp.exists(c));
}

/** Real PATH probe: the candidate runs and reports a version (status 0). node-only. */
export function probeExists(cmd: PyCommand): boolean {
  try {
    const r = spawnSync(cmd.command, [...cmd.args, "--version"], { timeout: 4000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

const MISSING_RE = /No module named '([^']+)'/g;

/**
 * Parse an `import fastapi, langgraph` probe into the list of missing modules
 * ([] = all present). Python raises ModuleNotFoundError on the first missing import,
 * so this typically names one module at a time.
 */
export function parseImportProbe(status: number | null, stderr: string): string[] {
  if (status === 0) return [];
  return [...stderr.matchAll(MISSING_RE)].map((m) => m[1]);
}

/** Human label for a command, e.g. {command:"py",args:["-3"]} -> "py -3". */
export function pyLabel(py: PyCommand): string {
  return py.args.length ? `${py.command} ${py.args.join(" ")}` : py.command;
}

/**
 * Actionable message when the user's interpreter can't import what the worker needs.
 * P0-3b: the sidecar's fastapi now lives in the managed venv, so the user interpreter
 * is only checked for langgraph — and the remedy is to select the project's own
 * environment, never `pip install -r requirements.lock` (which would clobber langgraph;
 * lesson #107). Replaces a raw ModuleNotFoundError stack (closes the P0-2 R-04 hook).
 */
export function doctorMessage(py: PyCommand, missing: string[]): string {
  return (
    `GraphLoupe's selected Python interpreter (${pyLabel(py)}) can't import: ${missing.join(", ")}. ` +
    "It needs to be the environment your LangGraph project runs in — pick it via " +
    '"Python: Select Interpreter" or set graphloupe.pythonPath.'
  );
}

/**
 * Message when no interpreter resolves at all (config empty, ms-python absent, nothing
 * on PATH) — replaces a raw ENOENT.
 */
export function interpreterNotFoundMessage(): string {
  return (
    "GraphLoupe could not find a Python interpreter. Install Python 3, select one via " +
    '"Python: Select Interpreter" (ms-python.python extension), or set graphloupe.pythonPath ' +
    "to its full path."
  );
}

export interface DoctorResult {
  ok: boolean;
  missing: string[];
}

/**
 * Preflight the USER's interpreter for what the worker needs (node-only IO wrapper; the
 * parsing/messaging it relies on is unit-tested). P0-3b: only langgraph is checked here —
 * the sidecar's fastapi lives in the managed venv (see venv.ts), not the user's env. A
 * spawn failure (ENOENT) returns ok:false with no missing list — the caller treats that
 * as "interpreter not runnable".
 */
export function runDoctor(py: PyCommand): DoctorResult {
  try {
    const r = spawnSync(py.command, [...py.args, "-c", "import langgraph"], {
      encoding: "utf8",
      timeout: 8000,
    });
    if (r.error) return { ok: false, missing: [] };
    const missing = parseImportProbe(r.status, r.stderr || "");
    return { ok: r.status === 0 && missing.length === 0, missing };
  } catch {
    return { ok: false, missing: [] };
  }
}
