/**
 * Run History persistence (P1-4) — the thin fs layer over `<projectRoot>/.graphloupe/runs.jsonl`.
 * The parsing / selection logic lives in ../../runhistory (pure, unit-tested); this only does
 * the append and read-back. Establishes the `.graphloupe/` project convention.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parseRunsFile, type RunRecord } from "../../runhistory";

const RUNS_CAP = 100;

function runsFile(projectRoot: string): string {
  return path.join(projectRoot, ".graphloupe", "runs.jsonl");
}

/** Append one finished run as a jsonl line. Best-effort: a failed write must never break the
 *  run (history is a convenience, not core), so callers log and move on. */
export function appendRun(projectRoot: string, rec: RunRecord): void {
  const dir = path.join(projectRoot, ".graphloupe");
  mkdirSync(dir, { recursive: true });
  appendFileSync(runsFile(projectRoot), JSON.stringify(rec) + "\n", "utf8");
}

/** The most recent runs (newest first), or [] if the file is absent / unreadable. */
export function readRuns(projectRoot: string): RunRecord[] {
  try {
    return parseRunsFile(readFileSync(runsFile(projectRoot), "utf8"), RUNS_CAP);
  } catch {
    return [];  // no file yet (first run) or unreadable — an empty history, not an error
  }
}
