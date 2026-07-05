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
  finalState: z.record(z.any()).default({}),  // the run's final state values (P1-5d); {} for pre-P1-5d records
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
/** One aligned branch-decision difference (P1-5b). The two runs' decision sequences are
 *  aligned by LCS (not by index), so a loop that adds an extra decision shows as one
 *  `b-only` entry rather than mis-pairing every later decision:
 *    a-only  = a made this decision, b didn't        (a set, b null)
 *    b-only  = b made this decision, a didn't        (a null, b set)
 *    changed = same aligned point, different decision (both set) */
export type BranchDiffKind = "a-only" | "b-only" | "changed";
export interface BranchDiff { kind: BranchDiffKind; a: RunBranch | null; b: RunBranch | null }

// One channel where the two runs' FINAL state differs (P1-5d): a-only / b-only / changed.
export interface StateKeyDiff { channel: string; kind: BranchDiffKind; a: unknown; b: unknown }

export interface RunComparison {
  firstDivergenceIndex: number | null;  // first nodePath index where a and b differ (or where one ends); null if identical
  pathIdentical: boolean;                // same nodes in the same order and length
  tokensDelta: number;                   // b total − a total
  durationDelta: number | null;          // b duration − a duration (ms); null if either run is unfinished
  statusChanged: boolean;
  inputChanged: boolean;
  branchDiffs: BranchDiff[];             // branch decisions that differ, aligned by sequence (LCS)
  stateDiffs: StateKeyDiff[];            // final-state channels that differ (P1-5d)
}

/** Diff two runs' final state by channel (P1-5d): a channel is `changed` when both have it
 *  with different values (JSON-compared), else `a-only` / `b-only`; equal channels omitted.
 *  Sorted by channel for stable rendering/tests. Pure. */
function diffState(a: Record<string, unknown>, b: Record<string, unknown>): StateKeyDiff[] {
  const out: StateKeyDiff[] = [];
  for (const ch of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const inA = ch in a, inB = ch in b;
    if (inA && !inB) out.push({ channel: ch, kind: "a-only", a: a[ch], b: undefined });
    else if (!inA && inB) out.push({ channel: ch, kind: "b-only", a: undefined, b: b[ch] });
    else if (JSON.stringify(a[ch]) !== JSON.stringify(b[ch])) out.push({ channel: ch, kind: "changed", a: a[ch], b: b[ch] });
  }
  return out;
}

function sameBranch(a: RunBranch, b: RunBranch): boolean {
  return a.source === b.source && a.key === b.key && a.target === b.target;
}

/** Sequence-diff two branch-decision lists (P1-5b): LCS-align by `sameBranch`, then report
 *  the non-matching entries — adjacent delete+insert coalesced into a `changed`. Pure. */
function branchesDiff(as: RunBranch[], bs: RunBranch[]): BranchDiff[] {
  const n = as.length, m = bs.length;
  // dp[i][j] = LCS length of as[i..] and bs[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = sameBranch(as[i], bs[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  type Op = { t: "same" | "del" | "ins"; a?: RunBranch; b?: RunBranch };
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (sameBranch(as[i], bs[j])) { ops.push({ t: "same" }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", a: as[i++] }); }
    else { ops.push({ t: "ins", b: bs[j++] }); }
  }
  while (i < n) ops.push({ t: "del", a: as[i++] });
  while (j < m) ops.push({ t: "ins", b: bs[j++] });

  const out: BranchDiff[] = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k], next = ops[k + 1];
    if (o.t === "same") continue;
    if (o.t === "del" && next?.t === "ins") { out.push({ kind: "changed", a: o.a!, b: next.b! }); k++; }
    else if (o.t === "ins" && next?.t === "del") { out.push({ kind: "changed", a: next.a!, b: o.b! }); k++; }
    else if (o.t === "del") out.push({ kind: "a-only", a: o.a!, b: null });
    else out.push({ kind: "b-only", a: null, b: o.b! });
  }
  return out;
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
    branchDiffs: branchesDiff(a.branches, b.branches),
    stateDiffs: diffState(a.finalState, b.finalState),
  };
}
