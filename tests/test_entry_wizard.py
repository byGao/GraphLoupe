"""P0-4 graph entry wizard (headless):
- discover.list_symbols enumerates top-level functions + module-level variables (AST only).
- the worker loads a generated .graphloupe/entry.py adapter that wraps either a factory
  (callable) or an already-compiled graph exposed as a module variable (non-callable).
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
from graphloupe_sidecar import discover

APP_DIR = Path(__file__).resolve().parent.parent

# A user module that exposes BOTH a factory (make) and an already-compiled graph (app).
USERGRAPH = """\
from typing import TypedDict
from langgraph.graph import START, END, StateGraph


class S(TypedDict):
    n: int


def _node(state):
    return {"n": 1}


def make():
    g = StateGraph(S)
    g.add_node("only_node", _node)
    g.add_edge(START, "only_node")
    g.add_edge("only_node", END)
    return g.compile()


app = make()  # module-level compiled graph (variable, not callable as a factory)
"""

# The adapter the wizard would generate — tolerates factory (callable) or graph (variable).
ADAPTER = """\
from usergraph import {symbol} as _target


def build_graph():
    return _target() if callable(_target) else _target
"""


def test_list_symbols_functions_and_variables(tmp_path: Path) -> None:
    f = tmp_path / "usergraph.py"
    f.write_text(USERGRAPH, encoding="utf-8")
    syms = {s["name"]: s["kind"] for s in discover.list_symbols(str(f))}
    assert syms["make"] == "function"
    assert syms["app"] == "variable"
    # every entry carries a positive line number
    assert all(s["line"] > 0 for s in discover.list_symbols(str(f)))


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


def _load_via_adapter(tmp_path: Path, symbol: str) -> P.ServerEvent:
    (tmp_path / "usergraph.py").write_text(USERGRAPH, encoding="utf-8")
    gl = tmp_path / ".graphloupe"
    gl.mkdir()
    (gl / "entry.py").write_text(ADAPTER.format(symbol=symbol), encoding="utf-8")
    with _worker("entry:build_graph", tmp_path) as proc:
        return P.ServerEventAdapter.validate_python(json.loads(proc.stdout.readline()))


def test_adapter_loads_compiled_graph_variable(tmp_path: Path) -> None:
    msg = _load_via_adapter(tmp_path, "app")  # non-callable variable
    assert isinstance(msg, P.GraphTopology)
    assert "only_node" in msg.nodes


def test_adapter_loads_factory_function(tmp_path: Path) -> None:
    msg = _load_via_adapter(tmp_path, "make")  # callable factory
    assert isinstance(msg, P.GraphTopology)
    assert "only_node" in msg.nodes
