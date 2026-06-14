# CLAUDE.md — GraphLoupe

GraphLoupe is an app under the `ai-workflow-2d3dstudio` monorepo (`apps/GraphLoupe`): a **LangGraph execution-visualization / debugging IDE hosted as a VS Code Extension**. This file is the agent's working discipline; violating any rule counts as a mistake.

## 0. Top principle: write against the contract and the PINs, not against memory

The behavior of LangGraph / `vscode.lm` **drifts across versions**, and your training data may be stale. **Anything marked `# PIN` must follow the spec in `workflow/stages/graphloupe/` plus a real `pin_dump.golden.txt` run — never fill fields from memory, never invent fields.** When unsure, run and check first, then write.

## 1. Read these first (mandatory before starting)

> **Design/development docs do NOT live in this app repo.** They are studio-workflow process artifacts, kept in the monorepo at `workflow/stages/graphloupe/` (HTML, relative to the repo root). This repo holds **code + functional docs only**. Read these there before starting:

- `workflow/stages/graphloupe/spec.html` — requirements & the four capabilities, architecture decisions, roadmap
- `workflow/stages/graphloupe/mapping.html` — Problem Frames, shared phenomena → frozen contract, PIN registry
- `workflow/stages/graphloupe/views.html` — each panel's state ↔ ServerEvent/ClientCommand binding
- `workflow/stages/graphloupe/engineering-design.html` — DFD / classes / sequence / state machine / per-node data blueprint / idempotency ledger
- `workflow/stages/graphloupe/test-plan.html` — test pyramid L0→L3, task-card template
- `workflow/stages/graphloupe/hybrid-routing-scenario.html` — target use case (per-node bottleneck localization)
- `protocol.py` (and the upcoming `protocol.ts`) — **the single source of truth for the cross-process contract** (this is code, kept in this repo)

## 2. Non-negotiable architecture invariants (decided; do not reopen the debate)

- Host = VS Code Extension; the Webview loads the React Flow canvas as a **one-way read-only execution view** (no canvas→code two-way editing).
- Sidecar = Option B: a self-built FastAPI that holds the compiled graph in-process; schema follows `langgraph-sdk`.
- The Copilot path **must go through extension → `vscode.lm` bridge**; the sidecar never receives Copilot credentials (consent boundary P7).
- Event lock `astream_events(version="v2")` (mind the P5 naming trap: do not confuse it with the type-safe streaming "v2").
- `protocol.ts` and `protocol.py` are mirrors; changing one **must synchronize the other + the L1 golden**.

## 3. Two framework semantics that bite (remember on every LLM node)

- **P1: `resume` re-runs the entire node function**, not from the `interrupt()` line onward. → Side effects before the interrupt must be idempotent (see `engineering-design.html` §10 ledger: pure functions / `@task` / idempotency keys / deferral).
- **P3: parallel `interrupt()` calls collide on ids** (langgraph #6626, still unfixed as of 2026; related: #6533 / #6792). → Dedup `InterruptId` with `node+seq`; align with the official "resume multiple interrupts at once" interface.

## 4. Test order (only build upward once the foundation is green)

L0 PINs (P1–P9 + PIN dump comparison) → L1 contract round-trip (TS↔Py) → L2 BDD scenarios → L3 `langgraph dev` integration consistency. **Every task card delivers a fixed four**: contract types + 2 Gherkin scenarios (at least one biting a PIN) + 1 golden fixture + DoD.

## 5. First task (do this first)

1. Lock the environment; write `pip freeze` into the `engineering-design.html` §2 version-lock table. **Note langgraph is already 1.x**; verify P4's 0.4.0/v3 assumptions and the `SqliteSaver` import path on the spot.
2. Drop a minimal real graph (convention: every user graph exports `build_graph()`).
3. Run `pin_dump.py`, save its output as `pin_dump.golden.txt` and commit it; calibrate all `# PIN` fields in `protocol.py` against it.

## 6. monorepo / shared-layer rules

- **Consume the shared layer; do not rebuild it.** If the shared layer already provides extension scaffolding, IPC/WebSocket, sidecar spawn management, or build/test config, use its interface. Inventory what `../../` (the shared layer) provides before starting.
- Do not stuff GraphLoupe-specific logic into the shared layer; conversely, if the shared layer lacks a capability, **propose before changing** and explain the blast radius.

## 7. Security / boundaries

- **User graph loading (OQ#3) has no isolation design yet.** Until isolation (subprocess + import allowlist + timeout) is ready, do not automatically run any flow that loads arbitrary user code; on failure go through `graph_load_failed` and do not contaminate the IDE.
- Do not create accounts, enter credentials, or change system/security settings. When such actions are needed, stop and ask a human.
