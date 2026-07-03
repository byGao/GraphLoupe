/**
 * RunRecorder (P1-4) — accumulate one graph run from the command + event stream into a
 * RunRecord. Pure (no vscode / no fs), so extension.ts wires it to the sockets and this
 * stays unit-testable. A clock is injected so tests can assert timestamps.
 */
import type { ClientCommand, ServerEvent } from "../../protocol";
import type { RunBranch, RunRecord, RunStatus } from "../../runhistory";

interface InProgress {
  runId: string;
  threadId: string;
  entry: string;
  input: Record<string, unknown>;
  startedAt: number;
  nodePath: string[];
  branches: RunBranch[];
  prompt: number;
  completion: number;
  error: string | null;
}

export class RunRecorder {
  private pendingInput: Record<string, unknown> = {};
  private cur: InProgress | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Observe a command the webview sent to the sidecar; captures the start_run input so the
   *  record can show what the run was launched with (the run_started event doesn't carry it). */
  onCommand(cmd: ClientCommand): void {
    if (cmd.type === "start_run") this.pendingInput = cmd.input ?? {};
  }

  /** Observe a server event. Opens a record on run_started, accumulates node path / branches /
   *  tokens / error, and returns a finalized RunRecord on run_finished (null otherwise). */
  onEvent(ev: ServerEvent, entry: string): RunRecord | null {
    switch (ev.type) {
      case "run_started":
        this.cur = {
          runId: ev.runId, threadId: ev.threadId, entry, input: this.pendingInput,
          startedAt: this.now(), nodePath: [], branches: [], prompt: 0, completion: 0, error: null,
        };
        this.pendingInput = {};
        return null;
      case "node_start":
        // collapse consecutive repeats (guards against double-emit; a real loop puts other
        // nodes in between, so it still shows plan…gate…plan)
        if (this.cur && this.cur.nodePath[this.cur.nodePath.length - 1] !== ev.node) {
          this.cur.nodePath.push(ev.node);
        }
        return null;
      case "branch_decisions":
        // the worker sends the full cumulative list each time — replace, don't append
        if (this.cur) {
          this.cur.branches = ev.decisions.map((d) => ({ source: d.source, key: d.key, target: d.target }));
        }
        return null;
      case "llm_end":
        if (this.cur && ev.tokens) {
          this.cur.prompt += ev.tokens.prompt;
          this.cur.completion += ev.tokens.completion ?? 0;
        }
        return null;
      case "error":
        if (this.cur) this.cur.error = `${ev.code}: ${ev.message}`;
        return null;
      case "run_finished":
        return this.finish(ev.status);
      default:
        return null;
    }
  }

  private finish(status: RunStatus): RunRecord | null {
    const c = this.cur;
    if (!c) return null;
    this.cur = null;
    return {
      runId: c.runId, threadId: c.threadId, entry: c.entry, input: c.input,
      startedAt: c.startedAt, endedAt: this.now(), status,
      nodePath: c.nodePath, branches: c.branches,
      tokens: { prompt: c.prompt, completion: c.completion }, error: c.error,
    };
  }
}
