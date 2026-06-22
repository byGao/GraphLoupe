# GraphLoupe

A LangGraph execution-visualization / step-debugging IDE, hosted as a VS Code
Extension with a Python FastAPI sidecar. Point it at a LangGraph graph in your
project and watch it render and run; pause LLM nodes for manual ("paste into any
chat") inference. Design docs live in the monorepo at `workflow/stages/graphloupe/`;
this repo holds the code + this guide.

## Layout

| Path | What |
|------|------|
| `protocol.py` / `protocol.ts` | the single cross-process contract (mirrors; L1 round-trip keeps them in sync) |
| `graphloupe_sidecar/` | Python sidecar — `server.py` (FastAPI `/ws`), `worker.py` (isolated graph runner), `discover.py` (graph scan), `graph.py` (built-in demos) |
| `extension/src/extension.ts` | VS Code extension host — spawns the sidecar, bridges WebSocket ↔ webview, commands |
| `webview/src/` | React + React Flow canvas + manual-inference panel |
| `scripts/quality_gate.py` | L0 (flake8 + mypy + bandit + PIN pytest) + L1 (vitest round-trip) |

## Setup (once)

Needs **Node 18+** and **Python** with the deps in `requirements.lock`.

```bash
npm install
npm run build          # bundles extension + webview into dist/
```

## Quick start (built-in demo)

1. Open this folder (`apps/GraphLoupe`) in VS Code.
2. Press **F5** → "Run GraphLoupe Extension" (an Extension Development Host opens).
3. In the dev window: **Ctrl/Cmd+Shift+P → "GraphLoupe: Open Graph Panel"**.
4. Click **"Select Graph…"** → pick `graphloupe_sidecar.graph:build_graph`.
5. Click **▶ Run** (leave the input box as `{}`). The nodes light up as it runs.

## Use it on YOUR graph

GraphLoupe runs *your* compiled LangGraph — you never edit `settings.json` by hand.

1. **Open your project folder in VS Code** (it becomes the project root; the picker
   scans it). To point elsewhere, set `graphloupe.projectRoot`.
2. **Ctrl/Cmd+Shift+P → "GraphLoupe: Select Graph"**. It AST-scans your project (no
   code is executed) for a graph factory — a top-level function named
   `build_graph` / `build_app` / `make_graph` / `create_graph`, **or** any function
   that imports langgraph and calls `.compile()`. Pick one.
   - The choice is saved to **your project's** `.vscode/settings.json`
     (`graphloupe.graphEntry`, e.g. `pipeline.graph:build_app`) — per-workspace.
3. **Enter the run input** (the JSON box next to ▶ Run) = your graph's initial state,
   then **▶ Run**.
4. Edit your graph, then **"GraphLoupe: Reload Graph"** to re-load and re-run.

### Example — a real graph that needs input

Say your project's `pipeline/graph.py` has `def build_app(): ... return g.compile()`
and its first node reads `state["repo_path"]`. After Select Graph picks
`pipeline.graph:build_app`, set the input box to your graph's initial state:

```json
{
  "repo_path": "c:/path/to/some/repo",
  "target": "demo",
  "out_dir": "c:/path/to/output",
  "worklist": [], "nodes": {}, "edges": [], "review_queue": [], "notes": []
}
```

Then ▶ Run. If a node needs a key you didn't provide, the error banner names it
(e.g. `run failed: KeyError: 'repo_path'`) — add it and Run again.

## Manual inference (the differentiator)

If a node pauses with `interrupt()` (a "ManualChatModel"), GraphLoupe turns the run
into: **export the prompt → paste it into any chat (Copilot/ChatGPT/…) → paste the
answer back → resume**, with zero state loss. Try the built-in
`graphloupe_sidecar.graph:manual_demo`:

1. Select Graph → `graphloupe_sidecar.graph:manual_demo` → ▶ Run.
2. The **Manual inference** panel appears with the rendered prompt → **Copy prompt**.
3. Paste it into any chat, get a response, paste it into the panel → **Send resume**.
4. The graph continues from where it paused.

`tool_call` nodes accept a JSON args paste; a bad paste is rejected
(`tool_schema_validation` / `resume_kind_mismatch`) and the run stays paused so you
can fix it.

## Troubleshooting

| Symptom | Meaning / fix |
|---------|---------------|
| "Select Graph" finds nothing | Your factory isn't named build_graph/build_app/… and doesn't call `.compile()` in a file importing langgraph. Rename it, or set `graphloupe.graphEntry` manually. |
| Banner: `graph_load_failed: ...` | The entry couldn't import / has no such callable. The message names the cause. |
| Banner: `run failed: KeyError: 'x'` | Your graph needs input key `x` — add it to the run-input JSON box. |
| `No checkpointer set` (fixed) | A graph compiled without a checkpointer runs to completion but **cannot pause / manual-infer / time-travel** (those need `compile(checkpointer=…)`). |
| Run looks stuck / too long | There's no breakpoint/Stop yet (debugging is a later phase). Use **"GraphLoupe: Reload Graph"** to abort and restart. |

## What works today

- ✅ **Graph visualization** — topology renders, active node highlights during a run.
- ✅ **Manual inference** — interrupt → paste → resume (text + tool_call).
- ⬜ **Step debugging** (breakpoints / state / diff / time-travel) — roadmap.
- ⬜ **Token economy panel** — roadmap.
- Copilot auto-path (`vscode.lm`) and a security sandbox for untrusted graphs are
  on the backlog (`workflow/stages/graphloupe/backlog.html`).

## CLI checks (no VS Code needed)

```bash
python pin_dump.py                                   # framework-truth dump (== pin_dump.golden.txt)
python -m graphloupe_sidecar.discover --project-root .  # what "Select Graph" would list
python scripts/quality_gate.py                       # flake8 + mypy + bandit + pytest, then vitest
npm run check                                        # typecheck + vitest + build
```
