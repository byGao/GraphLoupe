"""P0-5 R-01 (headless): the worker reports checkpointer presence + langgraph version
in the GraphTopology, so the health panel can tell the user what's available."""
from __future__ import annotations

import contextlib
import json
import os
import subprocess  # nosec B404 - spawning the worker under test
import sys
from collections.abc import Iterator
from pathlib import Path

import protocol as P

APP_DIR = Path(__file__).resolve().parent.parent

WITH_CKPT = """\
from typing import TypedDict
from langgraph.graph import START, END, StateGraph
from langgraph.checkpoint.memory import MemorySaver


class S(TypedDict):
    n: int


def build_graph():
    g = StateGraph(S)
    g.add_node("only", lambda s: {"n": 1})
    g.add_edge(START, "only")
    g.add_edge("only", END)
    return g.compile(checkpointer=MemorySaver())
"""

NO_CKPT = WITH_CKPT.replace("from langgraph.checkpoint.memory import MemorySaver\n", "") \
                   .replace("compile(checkpointer=MemorySaver())", "compile()")


@contextlib.contextmanager
def _worker(entry: str, root: Path) -> Iterator[subprocess.Popen]:
    proc = subprocess.Popen(  # nosec B603
        [sys.executable, "-m", "graphloupe_sidecar.worker", "--entry", entry, "--project-root", str(root)],
        cwd=APP_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
        env={**os.environ},
    )
    try:
        yield proc
    finally:
        proc.kill()
        proc.wait()


def _topology(src: str, tmp_path: Path) -> P.GraphTopology:
    (tmp_path / "g.py").write_text(src, encoding="utf-8")
    with _worker("g:build_graph", tmp_path) as proc:
        msg = P.ServerEventAdapter.validate_python(json.loads(proc.stdout.readline()))
    assert isinstance(msg, P.GraphTopology)
    return msg


def test_reports_checkpointer_present(tmp_path: Path) -> None:
    msg = _topology(WITH_CKPT, tmp_path)
    assert msg.hasCheckpointer is True
    assert msg.langgraphVersion  # a non-empty version string


def test_reports_checkpointer_absent(tmp_path: Path) -> None:
    msg = _topology(NO_CKPT, tmp_path)
    assert msg.hasCheckpointer is False
