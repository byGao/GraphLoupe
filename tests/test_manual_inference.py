"""phase2 manual-inference AC-01/02 (headless).

Graph-level: interrupt -> resume round-trip + idempotent pre-interrupt effect (P1/P2).
Worker-level: manual_inference_required -> resume(text|tool_call) protocol, with
tool_schema_validation / resume_kind_mismatch on bad pastes.
"""
from __future__ import annotations

import contextlib
import json
import os
import subprocess  # nosec B404 - spawning the worker under test
import sys
from collections.abc import Iterator
from pathlib import Path

from langgraph.types import Command

import protocol as P
from graphloupe_sidecar.graph import build_manual_graph

APP_DIR = Path(__file__).resolve().parent.parent


# ---- graph-level (in-process): idempotency + round-trip --------------------
def test_ac01_manual_roundtrip_idempotent() -> None:
    calls: list[int] = []
    app = build_manual_graph(spy=lambda: calls.append(1))
    cfg = {"configurable": {"thread_id": "m1"}}

    res = app.invoke({"messages": [], "steps": 0}, cfg)
    assert "__interrupt__" in res          # paused at manual inference
    assert len(calls) == 1

    res2 = app.invoke(Command(resume="42"), cfg)
    assert len(calls) == 1                  # P2 @task: pre-interrupt effect replays once
    assert any("42" in str(getattr(m, "content", "")) for m in res2["messages"])


# ---- worker-level (subprocess): manual_inference_required protocol ---------
@contextlib.contextmanager
def _worker(entry: str) -> Iterator[subprocess.Popen]:
    proc = subprocess.Popen(  # nosec B603
        [sys.executable, "-m", "graphloupe_sidecar.worker", "--entry", entry],
        cwd=APP_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
        env={**os.environ},
    )
    try:
        proc.stdout.readline()  # consume the startup graph topology line
        yield proc
    finally:
        proc.kill()
        proc.wait()


def _send(proc: subprocess.Popen, obj: dict) -> None:
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def _read_until(proc: subprocess.Popen, type_: str):
    for _ in range(50):
        line = proc.stdout.readline()
        if not line:
            break
        ev = P.ServerEventAdapter.validate_python(json.loads(line))
        if ev.type == type_:
            return ev
    raise AssertionError(f"did not see {type_}")


def test_worker_text_paste_resumes_and_finishes() -> None:
    with _worker("graphloupe_sidecar.graph:manual_demo") as proc:
        _send(proc, {"cmd": "run", "input": {"messages": [], "steps": 0}})
        req = _read_until(proc, "manual_inference_required")
        assert req.renderedText and req.promptTokens.prompt > 0 and req.expects == "text"
        _send(proc, {"cmd": "resume", "payload": {"kind": "text", "text": "42"}})
        assert _read_until(proc, "run_finished").status == "completed"


def test_worker_tool_call_valid_resumes() -> None:
    with _worker("tests.user_graphs:manual_tool") as proc:
        _send(proc, {"cmd": "run", "input": {"messages": [], "steps": 0}})
        req = _read_until(proc, "manual_inference_required")
        assert req.expects == "tool_call" and req.toolSchema is not None
        payload = {"kind": "tool_call", "name": "search", "args": {"query": "x"}}
        _send(proc, {"cmd": "resume", "payload": payload})
        assert _read_until(proc, "run_finished").status == "completed"


def test_worker_tool_call_missing_required_then_recovers() -> None:
    with _worker("tests.user_graphs:manual_tool") as proc:
        _send(proc, {"cmd": "run", "input": {"messages": [], "steps": 0}})
        _read_until(proc, "manual_inference_required")
        _send(proc, {"cmd": "resume", "payload": {"kind": "tool_call", "name": "search", "args": {}}})
        err = _read_until(proc, "error")
        assert err.code == "tool_schema_validation"
        # still paused -> a valid resume now finishes
        payload = {"kind": "tool_call", "name": "search", "args": {"query": "x"}}
        _send(proc, {"cmd": "resume", "payload": payload})
        assert _read_until(proc, "run_finished").status == "completed"


def test_worker_resume_kind_mismatch() -> None:
    with _worker("tests.user_graphs:manual_tool") as proc:
        _send(proc, {"cmd": "run", "input": {"messages": [], "steps": 0}})
        _read_until(proc, "manual_inference_required")
        _send(proc, {"cmd": "resume", "payload": {"kind": "text", "text": "x"}})
        assert _read_until(proc, "error").code == "resume_kind_mismatch"
