"""R-02 / AC-02: sidecar WebSocket protocol (headless, via starlette TestClient).

No real server/port: TestClient drives /ws in-process.
"""
from __future__ import annotations

import json

from starlette.testclient import TestClient

import protocol as P
from graphloupe_sidecar.server import app


def test_on_connect_sends_graph_topology_matching_get_graph() -> None:
    from graphloupe_sidecar.graph import build_graph

    expected = build_graph().get_graph()
    with TestClient(app).websocket_connect("/ws") as ws:
        msg = P.ServerEventAdapter.validate_python(json.loads(ws.receive_text()))
        assert isinstance(msg, P.GraphTopology)
        assert msg.nodes == sorted(expected.nodes)
        assert msg.edges == sorted((e.source, e.target) for e in expected.edges)


def test_start_run_streams_node_events_then_finished() -> None:
    with TestClient(app).websocket_connect("/ws") as ws:
        ws.receive_text()  # drop the initial graph topology
        ws.send_text(P.StartRun(input={"messages": [], "steps": 0}, providerMode="manual").model_dump_json())

        types: list[str] = []
        started: list[str] = []
        ended: list[str] = []
        while True:
            ev = P.ServerEventAdapter.validate_python(json.loads(ws.receive_text()))
            types.append(ev.type)
            if isinstance(ev, P.NodeStart):
                started.append(ev.node)
            elif isinstance(ev, P.NodeEnd):
                ended.append(ev.node)
            elif isinstance(ev, P.RunFinished):
                assert ev.status == "completed"
                break

        assert types[0] == "run_started"
        assert types[-1] == "run_finished"
        # prepare and llm each start and end, in dependency order
        assert started == ["prepare", "llm"]
        assert ended == ["prepare", "llm"]
