"""graph-worker — isolated subprocess that imports and runs the user graph.

User code (import + build_graph + astream_events) runs ONLY here, never in the
sidecar main process; a crash / hang / exception is contained to this process.
Speaks line-delimited JSON: one startup line, then a command loop.

  startup  -> {"type":"graph", nodes, edges}                       (success)
           or {"type":"error","code":"graph_load_failed", message}  (any failure)
  stdin    <- {"cmd":"run","threadId":..,"input":{..}}  ->  run_started / node_start*
              / node_end* / run_finished lines
           <- {"cmd":"shutdown"}  -> exit

Entry format: "package.module:callable" (callable returns a compiled graph).
"""
from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import sys

import protocol as P


def _load(entry: str):
    module_name, _, attr = entry.partition(":")
    builder = getattr(importlib.import_module(module_name), attr or "build_graph")
    return builder()


def _emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


async def _run(graph, nodes: set[str], thread_id: str, payload: dict) -> None:
    _emit(P.RunStarted(threadId=thread_id, runId=thread_id).model_dump_json())
    cfg = {"configurable": {"thread_id": thread_id}}
    async for ev in graph.astream_events(payload, version="v2", config=cfg):
        name, node = ev["event"], ev.get("name")
        if node not in nodes:
            continue
        if name == "on_chain_start":
            _emit(P.NodeStart(threadId=thread_id, runId=thread_id, node=node,
                              checkpointId="-", ts=0.0).model_dump_json())
        elif name == "on_chain_end":
            _emit(P.NodeEnd(threadId=thread_id, runId=thread_id, node=node,
                            checkpointId="-", durationMs=0.0).model_dump_json())
    _emit(P.RunFinished(threadId=thread_id, runId=thread_id, status="completed").model_dump_json())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--entry", default="graphloupe_sidecar.graph:demo_graph")
    args = parser.parse_args()

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

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            cmd = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if cmd.get("cmd") == "run":
            asyncio.run(_run(graph, nodes, cmd.get("threadId") or "run",
                             cmd.get("input") or {"messages": [], "steps": 0}))
        elif cmd.get("cmd") == "shutdown":
            break


if __name__ == "__main__":
    main()
