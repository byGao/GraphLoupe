"""L1 contract round-trip (Python side). Same golden JSON as test/protocol.l1.test.ts.

golden -> pydantic validate -> model_dump(mode="json") must equal golden, so the
Python and TS mirrors cannot drift on the PHASE-1 event subset.
"""
from __future__ import annotations

import json
import pathlib

import protocol as P

WIRE = pathlib.Path(__file__).resolve().parent.parent / "test" / "wire"

SERVER_CASES = ["graph", "run_started", "node_start", "node_end", "run_finished",
                "branch_decisions", "state_timeline"]
CLIENT_CASES = ["start_run"]


def _roundtrip(adapter, name: str) -> None:
    golden = json.loads((WIRE / f"{name}.json").read_text(encoding="utf-8"))
    obj = adapter.validate_python(golden)
    assert obj.model_dump(mode="json") == golden


def test_server_events_roundtrip() -> None:
    for name in SERVER_CASES:
        _roundtrip(P.ServerEventAdapter, name)


def test_client_commands_roundtrip() -> None:
    for name in CLIENT_CASES:
        _roundtrip(P.ClientCommandAdapter, name)
