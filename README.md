# GraphLoupe

A LangGraph execution-visualization / step-debugging IDE hosted as a VS Code
Extension (with a Python FastAPI sidecar). Design docs live in the monorepo at
`workflow/stages/graphloupe/`; this repo holds code + this functional guide.

## Layout

| Path | What |
|------|------|
| `protocol.py` / `protocol.ts` | the single cross-process contract (mirrors; L1 round-trip keeps them in sync) |
| `graphloupe_sidecar/` | Python sidecar — `build_graph()` + FastAPI `/ws` (`server.py`) |
| `extension/src/extension.ts` | VS Code extension host — spawns the sidecar, bridges WebSocket ↔ webview |
| `webview/src/` | React + React Flow canvas (execution view, read-only) |
| `pin_dump.py` / `pin_dump.golden.txt` | framework-truth dump locked for the installed versions |
| `scripts/quality_gate.py` | L0 (flake8 + PIN pytest) + L1 (vitest round-trip); L2/L3 pending |

## Try it (PHASE 1 — "a moving graph")

Needs Python (with `requirements.lock` deps) + Node 18+.

```bash
npm install          # once
npm run build        # bundle extension + webview into dist/
```

Then in VS Code:

1. Open this folder (`apps/GraphLoupe`) in VS Code.
2. Press **F5** → "Run GraphLoupe Extension" (builds, then opens an Extension Development Host).
3. In the dev window: run the command **"GraphLoupe: Open Graph Panel"** (Ctrl/Cmd+Shift+P).
4. The panel renders `prepare → llm` from `get_graph()`. Click **▶ Run** — the active node highlights as the run streams.

## CLI checks (no VS Code needed)

```bash
python pin_dump.py              # framework-truth dump (== pin_dump.golden.txt)
python scripts/quality_gate.py  # L0 (flake8 + pytest) + L1 (vitest); L2/L3 pending
npm run check                   # typecheck + vitest + build
```
