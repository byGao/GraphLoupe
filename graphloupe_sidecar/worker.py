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


def _pending_interrupt(graph: Any, cfg: dict[str, Any]) -> tuple[str, str, dict[str, Any]] | None:
    """If the graph is paused at an interrupt, return (node, interrupt_id, payload)."""
    state = graph.get_state(cfg)
    if state.next and state.tasks and state.tasks[0].interrupts:
        intr = state.tasks[0].interrupts[0]
        node = state.next[0]
        return node, intr.id, dict(intr.value)
    return None


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


async def _stream(graph: Any, nodes: set[str], source: Any, thread_id: str) -> None:
    cfg = {"configurable": {"thread_id": thread_id}}
    async for ev in graph.astream_events(source, version="v2", config=cfg):
        name, node = ev["event"], ev.get("name")
        if node not in nodes:
            continue
        if name == "on_chain_start":
            _emit(P.NodeStart(threadId=thread_id, runId=thread_id, node=node,
                              checkpointId="-", ts=0.0).model_dump_json())
        elif name == "on_chain_end":
            _emit(P.NodeEnd(threadId=thread_id, runId=thread_id, node=node,
                            checkpointId="-", durationMs=0.0).model_dump_json())


async def _run(graph: Any, nodes: set[str], thread_id: str, run_input: Any,
               cmd_q: "asyncio.Queue[str | None]") -> None:
    _emit(P.RunStarted(threadId=thread_id, runId=thread_id).model_dump_json())
    cfg = {"configurable": {"thread_id": thread_id}}
    # interrupt/pause/time-travel need a checkpointer; a graph compiled without one
    # (e.g. plain g.compile()) simply can't pause, so don't probe get_state on it.
    has_checkpointer = getattr(graph, "checkpointer", None) is not None
    source: Any = run_input
    while True:
        await _stream(graph, nodes, source, thread_id)
        pending = _pending_interrupt(graph, cfg) if has_checkpointer else None
        if pending is None:
            _emit(P.RunFinished(threadId=thread_id, runId=thread_id, status="completed").model_dump_json())
            return
        node, intr_id, val = pending
        _emit(_manual_required(thread_id, node, intr_id, val))
        resumed = False
        while not resumed:  # await a valid resume; invalid ones keep the run paused
            raw = await cmd_q.get()
            if raw is None:
                return
            cmd = json.loads(raw)
            if cmd.get("cmd") != "resume":
                continue
            resume_value, err = _validate_resume(val, cmd.get("payload") or {})
            if err:
                _emit(P.ErrorEvent(code=err, message=f"resume rejected: {err}", node=node).model_dump_json())
                continue
            source = Command(resume=resume_value)
            resumed = True


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
    while True:
        raw = await cmd_q.get()
        if raw is None:
            return
        cmd = json.loads(raw)
        if cmd.get("cmd") == "run":
            try:
                await _run(graph, nodes, cmd.get("threadId") or "run",
                           cmd.get("input") or {"messages": [], "steps": 0}, cmd_q)
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
