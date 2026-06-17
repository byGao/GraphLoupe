"""L0 PIN tests — lock framework truth (test-plan.html L0).

These do NOT test our code; they assert the framework still behaves as the spec
claims. Red here means the foundation moved and upper layers must be rechecked.

Runnable offline subset: PIN-01, PIN-04, PIN-07.
DEFER (need vscode.lm host or parallel semantics): PIN-03, PIN-05, PIN-06, PIN-08.

Run from apps/GraphLoupe with: python -m pytest tests/ -q
"""
from __future__ import annotations

import asyncio
import contextlib
import io
from pathlib import Path

from langchain_core.messages import HumanMessage
from langgraph.types import Command

from graphloupe_sidecar.graph import build_graph, build_interrupt_graph

ROOT = Path(__file__).resolve().parent.parent


def test_pin01_resume_reruns_whole_node() -> None:
    """P1: resume re-runs the entire node, so a side effect before interrupt()
    fires twice across the initial run + resume (counter-intuitive guard)."""
    calls: list[int] = []
    app = build_interrupt_graph(lambda: calls.append(1))
    cfg = {"configurable": {"thread_id": "pin01"}}

    app.invoke({"messages": [], "steps": 0}, cfg)  # runs up to interrupt()
    assert len(calls) == 1, "side effect should fire once on the initial run"

    app.invoke(Command(resume="answer"), cfg)  # resume re-runs the node
    assert len(calls) == 2, "P1: resume re-runs the whole node -> spy fires again"


def test_pin04_astream_events_v2_emits_chat_model_start() -> None:
    """P4: astream_events(version='v2') emits on_chat_model_start with the
    event/name/data keys EventTranslator depends on."""
    app = build_graph()

    async def collect() -> list[str]:
        names: list[str] = []
        async for ev in app.astream_events(
            {"messages": [HumanMessage(content="ping")], "steps": 0},
            version="v2",
            config={"configurable": {"thread_id": "pin04"}},
        ):
            if ev["event"] == "on_chat_model_start":
                assert {"event", "name", "data"} <= set(ev.keys())
                names.append(ev["event"])
        return names

    assert "on_chat_model_start" in asyncio.run(collect())


def test_pin07_pin_dump_matches_golden() -> None:
    """PIN-07: pin_dump output must equal the committed golden (line-wise, so
    CRLF/LF differences do not cause false reds)."""
    import pin_dump

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        pin_dump.main()
    got = buf.getvalue()
    golden = (ROOT / "pin_dump.golden.txt").read_text(encoding="utf-8")
    assert got.splitlines() == golden.splitlines()
