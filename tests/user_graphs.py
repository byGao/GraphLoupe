"""User-graph fixtures for graph-loading tests, loaded by the worker via entry path.

These stand in for "a user's own langgraph project". `custom` is a distinct shape
(!= the demo); `slow` blocks on build (load-timeout test); `raises` fails on build.
"""
from __future__ import annotations

import os
import time
from typing import Annotated, Any, TypedDict

from langchain_core.messages import BaseMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages


class _State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    steps: int


def _bump(state: _State) -> dict[str, Any]:
    return {"steps": state.get("steps", 0) + 1}


def custom():
    """A 3-node shape (ingest -> transform -> output), distinct from the demo.

    Records this process's PID (if GRAPHLOUPE_PIDFILE is set) so a test can assert
    the user graph was built in the worker subprocess, not the sidecar/test process.
    """
    pidfile = os.environ.get("GRAPHLOUPE_PIDFILE")
    if pidfile:
        with open(pidfile, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))

    g = StateGraph(_State)
    g.add_node("ingest", _bump)
    g.add_node("transform", _bump)
    g.add_node("output", _bump)
    g.add_edge(START, "ingest")
    g.add_edge("ingest", "transform")
    g.add_edge("transform", "output")
    g.add_edge("output", END)
    return g.compile(checkpointer=MemorySaver())


def slow():
    """Blocks on build past any sane load timeout (load-timeout test)."""
    time.sleep(30)
    return custom()


def raises():
    """Fails during build (graph_load_failed test)."""
    raise RuntimeError("boom during build")


def runtime_error():
    """A graph whose node raises at run time (tests the worker surfacing run errors)."""
    def boom(state: _State) -> dict[str, Any]:
        raise KeyError("repo_path")  # mimics a user graph needing input it didn't get

    g = StateGraph(_State)
    g.add_node("boom", boom)
    g.add_edge(START, "boom")
    g.add_edge("boom", END)
    return g.compile(checkpointer=MemorySaver())


def manual_tool():
    """Manual-inference node expecting a structured tool_call (toolSchema requires 'query')."""
    from langchain_core.messages import AIMessage

    from graphloupe_sidecar.graph import manual_infer

    schema = {
        "type": "object",
        "properties": {"query": {"type": "string"}, "top_k": {"type": "integer"}},
        "required": ["query"],
    }

    def ask(state: _State) -> dict[str, Any]:
        result = manual_infer([AIMessage(content="search?")], expects="tool_call", tool_schema=schema)
        return {"messages": [AIMessage(content=str(result))]}

    g = StateGraph(_State)
    g.add_node("ask", ask)
    g.add_edge(START, "ask")
    g.add_edge("ask", END)
    return g.compile(checkpointer=MemorySaver())
