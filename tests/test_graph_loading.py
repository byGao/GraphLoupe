"""graph-loading AC-01..04 (headless).

Worker-direct tests drive graphloupe_sidecar.worker as a real subprocess; sidecar
tests drive the relay via starlette TestClient. The user graph runs only in the worker.
"""
from __future__ import annotations

import contextlib
import json
import os
import subprocess  # nosec B404 - spawning the worker under test
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import protocol as P
from graphloupe_sidecar.server import app
from tests._worker_io import readline_timeout

APP_DIR = Path(__file__).resolve().parent.parent


@contextlib.contextmanager
def _worker(entry: str, env_extra: dict[str, str] | None = None) -> Iterator[subprocess.Popen]:
    env = {**os.environ, **(env_extra or {})}
    proc = subprocess.Popen(  # nosec B603
        [sys.executable, "-m", "graphloupe_sidecar.worker", "--entry", entry],
        cwd=APP_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1, env=env,
    )
    try:
        yield proc
    finally:
        proc.kill()
        proc.wait()  # reap so filterwarnings=error doesn't trip ResourceWarning


def _first(proc: subprocess.Popen):
    return P.ServerEventAdapter.validate_python(json.loads(readline_timeout(proc)))


def test_ac01_custom_entry_topology() -> None:
    with _worker("tests.user_graphs:custom") as proc:
        msg = _first(proc)
        assert isinstance(msg, P.GraphTopology)
        assert msg.nodes == ["__end__", "__start__", "ingest", "output", "transform"]


@pytest.mark.parametrize("entry", [
    "nope.does_not_exist:build_graph",   # module not found
    "tests.user_graphs:missing",         # attr not found
    "tests.user_graphs:raises",          # build raises
])
def test_ac02_worker_emits_graph_load_failed(entry: str) -> None:
    with _worker(entry) as proc:
        msg = _first(proc)
        assert isinstance(msg, P.ErrorEvent)
        assert msg.code == "graph_load_failed"


def test_topology_carries_input_schema() -> None:
    with _worker("tests.user_graphs:custom") as proc:
        msg = _first(proc)
        assert isinstance(msg, P.GraphTopology)
        assert msg.inputSchema is not None and "properties" in msg.inputSchema


def test_ac04_user_graph_built_in_worker_process(tmp_path: Path) -> None:
    pidfile = tmp_path / "pid.txt"
    with _worker("tests.user_graphs:custom", {"GRAPHLOUPE_PIDFILE": str(pidfile)}) as proc:
        _first(proc)  # startup -> build done -> pid recorded
        worker_pid = int(pidfile.read_text(encoding="utf-8"))
        assert worker_pid == proc.pid       # built in the worker subprocess
        assert worker_pid != os.getpid()    # not the sidecar/test process


def test_ac02_sidecar_forwards_failure_and_stays_alive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRAPHLOUPE_GRAPH", "tests.user_graphs:raises")
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        msg = P.ServerEventAdapter.validate_python(json.loads(ws.receive_text()))
        assert isinstance(msg, P.ErrorEvent) and msg.code == "graph_load_failed"
    with client.websocket_connect("/ws") as ws2:  # sidecar still alive
        msg2 = P.ServerEventAdapter.validate_python(json.loads(ws2.receive_text()))
        assert isinstance(msg2, P.ErrorEvent)


def test_ac03_load_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRAPHLOUPE_GRAPH", "tests.user_graphs:slow")
    monkeypatch.setenv("GRAPHLOUPE_LOAD_TIMEOUT", "1")
    with TestClient(app).websocket_connect("/ws") as ws:
        msg = P.ServerEventAdapter.validate_python(json.loads(ws.receive_text()))
        assert isinstance(msg, P.ErrorEvent)
        assert msg.code == "graph_load_failed"
        assert "timed out" in msg.message
