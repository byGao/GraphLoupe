/**
 * Run History record (P1-4) — the persisted summary of one graph run.
 * ===========================================================================
 * This is NOT part of the frozen sidecar wire contract (protocol.ts/py). It is a
 * persisted artifact the EXTENSION writes to `<projectRoot>/.graphloupe/runs.jsonl`
 * (one RunRecord per line) and reads back to feed the webview's History panel.
 * Deliberately kept out of the ServerEvent union so protocol.py/ts stay in sync and
 * the L1 golden / pin_dump are unaffected. zod is used to validate lines on read-back
 * (the jsonl is user-visible and could be hand-edited or left over from an older schema).
 */
import { z } from "zod";

export const RunStatus = z.enum(["completed", "interrupted", "error", "aborted", "running"]);
export type RunStatus = z.infer<typeof RunStatus>;

// One router decision taken in the run (subset of the wire BranchDecision — just the shape
// the History summary shows; the live Branch panel keeps the full record).
export const RunBranch = z.object({
  source: z.string(),
  key: z.string().nullable(),
  target: z.string(),
});
export type RunBranch = z.infer<typeof RunBranch>;

export const RunTokens = z.object({
  prompt: z.number().int(),
  completion: z.number().int(),
});
export type RunTokens = z.infer<typeof RunTokens>;

export const RunRecord = z.object({
  runId: z.string(),
  threadId: z.string(),
  entry: z.string(),                 // the graphEntry that produced this run
  input: z.record(z.any()),          // the start_run input
  startedAt: z.number(),             // epoch ms
  endedAt: z.number().nullable(),    // epoch ms; null if never finished (crash)
  status: RunStatus,
  nodePath: z.array(z.string()),     // nodes in run order (consecutive repeats collapsed)
  branches: z.array(RunBranch),
  tokens: RunTokens,
  error: z.string().nullable(),
});
export type RunRecord = z.infer<typeof RunRecord>;

/** Parse one jsonl line into a RunRecord, or null if it's malformed / an old schema.
 *  Read-back must never throw on a bad line — skip it and keep the rest. */
export function parseRunRecord(line: string): RunRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return RunRecord.parse(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Parse a whole runs.jsonl into the most recent `cap` records, newest first. Malformed
 *  lines are skipped. The file is append-only (oldest→newest), so we take the tail. Pure. */
export function parseRunsFile(content: string, cap: number): RunRecord[] {
  const recs = content.split("\n").map(parseRunRecord).filter((r): r is RunRecord => r !== null);
  return recs.slice(-cap).reverse();
}

// ---- run comparison (P1-5) -------------------------------------------------
/** One position where two runs' router decisions differ (aligned by index). */
export interface BranchDiff { index: number; a: RunBranch | null; b: RunBranch | null }

export interface RunComparison {
  firstDivergenceIndex: number | null;  // first nodePath index where a and b differ (or where one ends); null if identical
  pathIdentical: boolean;                // same nodes in the same order and length
  tokensDelta: number;                   // b total − a total
  durationDelta: number | null;          // b duration − a duration (ms); null if either run is unfinished
  statusChanged: boolean;
  inputChanged: boolean;
  branchDiffs: BranchDiff[];             // positions where the branch decision differs
}

function sameBranch(a: RunBranch | null, b: RunBranch | null): boolean {
  if (a === null || b === null) return a === b;
  return a.source === b.source && a.key === b.key && a.target === b.target;
}

/** Compare two runs (P1-5): where their node paths first diverge, which branch decisions
 *  differ, and the token / duration / status / input deltas. Pure; the UI renders it. */
export function compareRuns(a: RunRecord, b: RunRecord): RunComparison {
  const n = Math.min(a.nodePath.length, b.nodePath.length);
  let div: number | null = null;
  for (let i = 0; i < n; i++) {
    if (a.nodePath[i] !== b.nodePath[i]) { div = i; break; }
  }
  if (div === null && a.nodePath.length !== b.nodePath.length) div = n;  // one path is a prefix of the other

  const branchDiffs: BranchDiff[] = [];
  const bn = Math.max(a.branches.length, b.branches.length);
  for (let i = 0; i < bn; i++) {
    const ba = a.branches[i] ?? null;
    const bb = b.branches[i] ?? null;
    if (!sameBranch(ba, bb)) branchDiffs.push({ index: i, a: ba, b: bb });
  }

  const dur = (r: RunRecord) => (r.endedAt === null ? null : r.endedAt - r.startedAt);
  const da = dur(a), db = dur(b);
  const total = (r: RunRecord) => r.tokens.prompt + r.tokens.completion;
  return {
    firstDivergenceIndex: div,
    pathIdentical: div === null,
    tokensDelta: total(b) - total(a),
    durationDelta: da === null || db === null ? null : db - da,
    statusChanged: a.status !== b.status,
    inputChanged: JSON.stringify(a.input) !== JSON.stringify(b.input),
    branchDiffs,
  };
}
