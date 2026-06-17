"""FastAPI sidecar — speaks protocol.py over a WebSocket at /ws.

PHASE 1 transport (engineering-design §2):
- on connect      -> send GraphTopology(get_graph())   (R1 execution view)
- on start_run    -> astream_events(version="v2") translated to
                     run_started -> node_start*/node_end* -> run_finished

Node boundaries are taken from on_chain_start/on_chain_end events whose name is
a graph node (verified via pin_dump probe: exactly one start+end per node, in order).
Run headless in tests via starlette TestClient; run for real with
`python -m graphloupe_sidecar.server` (uvicorn).
"""
from __future__ import annotations

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from langchain_core.messages import HumanMessage

import protocol as P
from graphloupe_sidecar.graph import build_graph

app = FastAPI()
_graph = build_graph()
_NODES = set(_graph.get_graph().nodes) - {"__start__", "__end__"}


def topology(thread_id: str | None = None) -> P.GraphTopology:
    g = _graph.get_graph()
    return P.GraphTopology(
        threadId=thread_id,
        nodes=sorted(g.nodes),
        edges=sorted((e.source, e.target) for e in g.edges),
    )


async def _stream_run(ws: WebSocket, thread_id: str, payload: dict) -> None:
    """Translate astream_events(v2) into protocol ServerEvents over the socket."""
    await ws.send_text(P.RunStarted(threadId=thread_id, runId=thread_id).model_dump_json())
    cfg = {"configurable": {"thread_id": thread_id}}
    graph_input = payload or {"messages": [HumanMessage(content="ping")], "steps": 0}
    async for ev in _graph.astream_events(graph_input, version="v2", config=cfg):
        name, node = ev["event"], ev.get("name")
        if node not in _NODES:
            continue
        if name == "on_chain_start":
            await ws.send_text(
                P.NodeStart(
                    threadId=thread_id, runId=thread_id, node=node, checkpointId="-", ts=0.0
                ).model_dump_json()
            )
        elif name == "on_chain_end":
            await ws.send_text(
                P.NodeEnd(
                    threadId=thread_id, runId=thread_id, node=node, checkpointId="-", durationMs=0.0
                ).model_dump_json()
            )
    await ws.send_text(
        P.RunFinished(threadId=thread_id, runId=thread_id, status="completed").model_dump_json()
    )


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await ws.send_text(topology().model_dump_json())
    try:
        while True:
            raw = await ws.receive_text()
            cmd = P.ClientCommandAdapter.validate_json(raw)
            if isinstance(cmd, P.StartRun):
                thread_id = cmd.threadId or "run"
                await _stream_run(ws, thread_id, cmd.input)
            # other commands (resume/step/fork/...) arrive in later phases
    except WebSocketDisconnect:
        return


def main() -> None:  # pragma: no cover - real run path
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=0)


if __name__ == "__main__":  # pragma: no cover
    main()
