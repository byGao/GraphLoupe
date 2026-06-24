"""graph-worker — isolated subprocess that imports and runs the user graph.

User code (import + build_graph + astream_events) runs ONLY here, never in the
sidecar main process; a crash / hang / exception is contained to this process.
Speaks line-delimited JSON: one startup line, then an async command loop.

  startup  -> {"type":"graph", nodes, edges}                       (success)
           or {"type":"error","code":"graph_load_failed", message}  (any failure)
  stdin    <- {"cmd":"run","threadId":..,"input":{..}}
           <- {"cmd":"resume","payload":{kind:"text",text} | {kind:"tool_call",name,args}}
           <- {"cmd":"shutdown"}
  stdout   -> run_started / node_start* / node_end* / manual_inference_required /
              run_finished / error  (protocol ServerEvents)

manual_inference_required pauses the run (interrupt); the matching resume validates
against the pending interrupt and continues via Command(resume=...). PHASE 2.

Entry format: "package.module:callable" (callable returns a compiled graph).
"""
from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import sys
import threading
from typing import Any

from langgraph.types import Command

import protocol as P


def _add_project_root(root: str) -> None:
    """Put the user's project on sys.path so `entry` resolves against THEIR repo,
    not the sidecar's own folder (workspace-load)."""
    if root and root not in sys.path:
        sys.path.insert(0, root)


def _load(entry: str) -> Any:
    module_name, _, attr = entry.partition(":")
    builder = getattr(importlib.import_module(module_name), attr or "build_graph")
    return builder()


def _emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _interrupt_from_state(state: Any) -> tuple[str, str, dict[str, Any]] | None:
    """If paused at a manual interrupt() (not a breakpoint), return (node, id, payload)."""
    if state.next and state.tasks and state.tasks[0].interrupts:
        intr = state.tasks[0].interrupts[0]
        return state.next[0], intr.id, dict(intr.value)
    return None


def _bp_lists(breakpoints: set[tuple[str, str]]) -> tuple[list[str], list[str]]:
    before = sorted({n for n, w in breakpoints if w == "before"})
    after = sorted({n for n, w in breakpoints if w == "after"})
    return before, after


def _jsonsafe(value: Any) -> Any:
    """Coerce arbitrary graph state to JSON-safe values (objects -> str)."""
    return json.loads(json.dumps(value, default=str))


def _diff(prev: dict[str, Any], cur: dict[str, Any]) -> list[P.StateDiffEntry]:
    entries: list[P.StateDiffEntry] = []
    for key, val in cur.items():
        if key not in prev:
            entries.append(P.StateDiffEntry(channel=key, before=None, after=_jsonsafe(val), op="add"))
        elif prev[key] != val:
            entries.append(P.StateDiffEntry(
                channel=key, before=_jsonsafe(prev[key]), after=_jsonsafe(val), op="update"))
    for key, val in prev.items():
        if key not in cur:
            entries.append(P.StateDiffEntry(channel=key, before=_jsonsafe(val), after=None, op="remove"))
    return entries


def _snapshot(thread_id: str, checkpoint_id: str, values: dict[str, Any],
              prev: dict[str, Any]) -> str:
    snap = P.StateSnapshot(values=_jsonsafe(values), diff=_diff(prev, values))
    return P.StateSnapshotEvent(
        threadId=thread_id, checkpointId=checkpoint_id, snapshot=snap).model_dump_json()


def _manual_required(thread_id: str, node: str, intr_id: str, val: dict[str, Any]) -> str:
    schema = val.get("toolSchema")
    event = P.ManualInferenceRequired(
        threadId=thread_id, runId=thread_id, node=node, interruptId=intr_id,
        renderedText=val.get("renderedText", ""),
        messages=[P.ChatMessage(**m) for m in val.get("messages", [])],
        expects=val.get("expects", "text"),
        toolSchema=P.JsonSchema(**schema) if schema else None,
        promptTokens=P.TokenCount(**val["promptTokens"]),
    )
    return event.model_dump_json()


def _validate_resume(
    intr_value: dict[str, Any], payload: dict[str, Any],
) -> tuple[Any, "P.ErrorCode | None"]:
    """Validate a resume payload against the pending interrupt (B-domain boundary).
    Returns (resume_value, None) on success, or (None, error_code)."""
    expects = intr_value.get("expects", "text")
    kind = payload.get("kind")
    if expects == "text":
        if kind != "text":
            return None, "resume_kind_mismatch"
        return payload.get("text", ""), None
    # expects == "tool_call"
    if kind != "tool_call":
        return None, "resume_kind_mismatch"
    required = (intr_value.get("toolSchema") or {}).get("required") or []
    args = payload.get("args") or {}
    if [r for r in required if r not in args]:
        return None, "tool_schema_validation"
    return {"name": payload.get("name"), "args": args}, None


_SHUTDOWN = object()


async def _stream(graph: Any, nodes: set[str], source: Any, thread_id: str,
                  before: list[str] | None = None, after: list[str] | None = None) -> None:
    cfg = {"configurable": {"thread_id": thread_id}}
    kwargs: dict[str, Any] = {}
    if before is not None:
        kwargs["interrupt_before"] = before
    if after:
        kwargs["interrupt_after"] = after
    async for ev in graph.astream_events(source, version="v2", config=cfg, **kwargs):
        name, node = ev["event"], ev.get("name")
        if node not in nodes:
            continue
        if name == "on_chain_start":
            _emit(P.NodeStart(threadId=thread_id, runId=thread_id, node=node,
                              checkpointId="-", ts=0.0).model_dump_json())
        elif name == "on_chain_end":
            _emit(P.NodeEnd(threadId=thread_id, runId=thread_id, node=node,
                            checkpointId="-", durationMs=0.0).model_dump_json())


async def _next_cmd(cmd_q: "asyncio.Queue[str | None]",
                    breakpoints: set[tuple[str, str]]) -> dict[str, Any] | None:
    """Next stdin command; breakpoint set/clear are applied transparently (any time)."""
    while True:
        raw = await cmd_q.get()
        if raw is None:
            return None
        cmd = json.loads(raw)
        kind = cmd.get("cmd")
        if kind == "set_breakpoint":
            breakpoints.add((cmd["node"], cmd.get("when", "before")))
            continue
        if kind == "clear_breakpoint":
            breakpoints.discard((cmd["node"], cmd.get("when", "before")))
            continue
        return cmd


async def _await_resume(cmd_q: "asyncio.Queue[str | None]", intr_value: dict[str, Any],
                        node: str, breakpoints: set[tuple[str, str]]) -> Any:
    while True:
        cmd = await _next_cmd(cmd_q, breakpoints)
        if cmd is None:
            return _SHUTDOWN
        if cmd.get("cmd") != "resume":
            continue
        resume_value, err = _validate_resume(intr_value, cmd.get("payload") or {})
        if err:
            _emit(P.ErrorEvent(code=err, message=f"resume rejected: {err}", node=node).model_dump_json())
            continue
        return Command(resume=resume_value)


async def _await_debug(cmd_q: "asyncio.Queue[str | None]", graph: Any, thread_id: str,
                       cfg: dict[str, Any], breakpoints: set[tuple[str, str]],
                       prev: dict[str, Any]) -> str:
    """At a breakpoint pause: step / continue / inspect, until an advance is chosen."""
    while True:
        cmd = await _next_cmd(cmd_q, breakpoints)
        if cmd is None:
            return "shutdown"
        kind = cmd.get("cmd")
        if kind == "step":
            return "step"
        if kind in ("run", "resume"):  # ▶ Run / resume while paused = continue to next bp
            return "continue"
        if kind == "get_state":
            state = graph.get_state(cfg)
            ckpt = state.config["configurable"]["checkpoint_id"] if state.config else "-"
            _emit(_snapshot(thread_id, ckpt, state.values, prev))


async def _run(graph: Any, nodes: set[str], thread_id: str, run_input: Any,
               cmd_q: "asyncio.Queue[str | None]", breakpoints: set[tuple[str, str]]) -> None:
    _emit(P.RunStarted(threadId=thread_id, runId=thread_id).model_dump_json())
    cfg = {"configurable": {"thread_id": thread_id}}
    # interrupt/breakpoints/time-travel need a checkpointer; a graph compiled without one
    # can't pause, so just stream it to completion.
    has_checkpointer = getattr(graph, "checkpointer", None) is not None
    prev: dict[str, Any] = {}
    source: Any = run_input
    step_mode = False
    while True:
        before: list[str] | None = None
        after: list[str] | None = None
        if has_checkpointer:
            bp_before, after = _bp_lists(breakpoints)
            before = sorted(nodes) if step_mode else bp_before
        await _stream(graph, nodes, source, thread_id, before, after)
        step_mode = False
        state = graph.get_state(cfg) if has_checkpointer else None
        if state is None or not state.next:
            _emit(P.RunFinished(threadId=thread_id, runId=thread_id, status="completed").model_dump_json())
            return
        intr = _interrupt_from_state(state)
        if intr is not None:  # manual inference (PHASE 2)
            node, intr_id, val = intr
            _emit(_manual_required(thread_id, node, intr_id, val))
            outcome = await _await_resume(cmd_q, val, node, breakpoints)
            if outcome is _SHUTDOWN:
                return
            source = outcome
            continue
        # breakpoint / step pause (PHASE 3)
        node = state.next[0]
        ckpt = state.config["configurable"]["checkpoint_id"]
        _emit(P.BreakpointHit(threadId=thread_id, runId=thread_id, node=node,
                              when="before", checkpointId=ckpt).model_dump_json())
        _emit(_snapshot(thread_id, ckpt, state.values, prev))
        prev = dict(state.values)
        action = await _await_debug(cmd_q, graph, thread_id, cfg, breakpoints, prev)
        if action == "shutdown":
            return
        step_mode = action == "step"
        source = None


async def _amain(graph: Any, nodes: set[str]) -> None:
    loop = asyncio.get_running_loop()
    cmd_q: "asyncio.Queue[str | None]" = asyncio.Queue()

    def reader() -> None:
        for line in sys.stdin:
            stripped = line.strip()
            if stripped:
                loop.call_soon_threadsafe(cmd_q.put_nowait, stripped)
        loop.call_soon_threadsafe(cmd_q.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()
    breakpoints: set[tuple[str, str]] = set()
    while True:
        cmd = await _next_cmd(cmd_q, breakpoints)  # set/clear breakpoints apply while idle too
        if cmd is None:
            return
        if cmd.get("cmd") == "run":
            try:
                await _run(graph, nodes, cmd.get("threadId") or "run",
                           cmd.get("input") or {"messages": [], "steps": 0}, cmd_q, breakpoints)
            except Exception as exc:  # a user-graph node raised: surface it, stay alive
                _emit(P.ErrorEvent(
                    code="internal",
                    message=f"run failed: {type(exc).__name__}: {exc}",
                ).model_dump_json())
        elif cmd.get("cmd") == "shutdown":
            return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--entry", default="graphloupe_sidecar.graph:demo_graph")
    parser.add_argument("--project-root", default="")
    args = parser.parse_args()
    _add_project_root(args.project_root)

    try:
        graph = _load(args.entry)
        g = graph.get_graph()
        nodes = set(g.nodes) - {"__start__", "__end__"}
        _emit(P.GraphTopology(
            nodes=sorted(g.nodes),
            edges=sorted((e.source, e.target) for e in g.edges),
        ).model_dump_json())
    except Exception as exc:  # import error / missing attr / build raises
        _emit(P.ErrorEvent(code="graph_load_failed",
                           message=f"{type(exc).__name__}: {exc}").model_dump_json())
        return

    asyncio.run(_amain(graph, nodes))


if __name__ == "__main__":
    main()
