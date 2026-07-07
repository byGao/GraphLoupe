"""workspace-load AC-01/02 (headless): load a graph from an arbitrary project root.

A user graph module is written to a tmp dir that is NOT on the default path; the
worker must find it via --project-root (sys.path). AC-03 regression (default demo
unchanged) is covered by the rest of the suite.
"""
from __future__ import annotations

import contextlib
import json
import os
import subprocess  # nosec B404 - spawning the worker under test
import sys
from collections.abc import Iterator
from pathlib import Path

import protocol as P
from tests._worker_io import readline_timeout

APP_DIR = Path(__file__).resolve().parent.parent

USERGRAPH = """\
from typing import TypedDict
from langgraph.graph import START, END, StateGraph


class S(TypedDict):
    n: int


def build_graph():
    def only_node(state):
        return {"n": 1}
    g = StateGraph(S)
    g.add_node("only_node", only_node)
    g.add_edge(START, "only_node")
    g.add_edge("only_node", END)
    return g.compile()
"""


@contextlib.contextmanager
def _worker(entry: str, root: Path) -> Iterator[subprocess.Popen]:
    proc = subprocess.Popen(  # nosec B603
        [sys.executable, "-m", "graphloupe_sidecar.worker",
         "--entry", entry, "--project-root", str(root)],
        cwd=APP_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
        env={**os.environ},
    )
    try:
        yield proc
    finally:
        proc.kill()
        proc.wait()


def _first(proc: subprocess.Popen):
    return P.ServerEventAdapter.validate_python(json.loads(readline_timeout(proc)))


def test_ac01_loads_graph_from_project_root(tmp_path: Path) -> None:
    (tmp_path / "usergraph.py").write_text(USERGRAPH, encoding="utf-8")
    with _worker("usergraph:build_graph", tmp_path) as proc:
        msg = _first(proc)
        assert isinstance(msg, P.GraphTopology)
        assert "only_node" in msg.nodes


def test_ac02_module_without_build_graph_reports_cause(tmp_path: Path) -> None:
    (tmp_path / "nograph.py").write_text("x = 1\n", encoding="utf-8")
    with _worker("nograph:build_graph", tmp_path) as proc:
        msg = _first(proc)
        assert isinstance(msg, P.ErrorEvent)
        assert msg.code == "graph_load_failed"
        assert "build_graph" in msg.message  # AttributeError names the missing attr
