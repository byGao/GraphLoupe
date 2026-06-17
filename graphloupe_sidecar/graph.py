"""Minimal real graphs for GraphLoupe.

build_graph() is the canonical entrypoint convention every user graph follows
(GraphLoupe CLAUDE.md §5). The fixtures here back the L0 PIN tests and pin_dump.py
and use a fake chat model so everything runs offline (no Copilot / vscode.lm).
"""
from __future__ import annotations

import asyncio
from typing import Annotated, Any, Callable, TypedDict

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import interrupt


class State(TypedDict):
    """Two channels: an append-only message list and a step counter."""
    messages: Annotated[list[BaseMessage], add_messages]
    steps: int


def _fake_model() -> FakeMessagesListChatModel:
    # Cycles through the responses; one reply per invocation is enough here.
    return FakeMessagesListChatModel(responses=[AIMessage(content="pong")])


def build_graph(step_delay: float = 0.0):
    """Canonical entrypoint: prepare -> llm, compiled with an in-memory checkpointer.

    Under astream_events(version="v2") this emits on_chain_start and
    on_chat_model_start; get_state().values exposes the 'messages' and 'steps'
    channels. Used by pin_dump.py and PIN-04/07.

    step_delay: a small per-node sleep so the canvas highlight is perceptible when
    running the instant fake model in the UI. Tests / pin_dump use 0 (default).
    """
    model = _fake_model()

    async def prepare(state: State) -> dict[str, Any]:
        if step_delay:
            await asyncio.sleep(step_delay)
        return {"steps": state.get("steps", 0) + 1}

    async def llm(state: State) -> dict[str, Any]:
        if step_delay:
            await asyncio.sleep(step_delay)
        reply = await model.ainvoke(state["messages"])
        return {"messages": [reply]}

    g = StateGraph(State)
    g.add_node("prepare", prepare)
    g.add_node("llm", llm)
    g.add_edge(START, "prepare")
    g.add_edge("prepare", "llm")
    g.add_edge("llm", END)
    return g.compile(checkpointer=MemorySaver())


def demo_graph():
    """Default graph entry for the sidecar: the demo with a visible step delay."""
    return build_graph(step_delay=0.5)


def build_interrupt_graph(spy: Callable[[], None]):
    """Single node that runs a side effect (spy) BEFORE interrupt().

    P1 (PIN-01): resume re-runs the WHOLE node, not from interrupt() onward, so
    the spy fires twice across the initial run + resume. This fixture is the
    counter-intuitive guard that keeps the wrong "runs once" mental model out.
    """
    def ask(state: State) -> dict[str, Any]:
        spy()  # side effect BEFORE interrupt -> re-run on resume (P1)
        answer = interrupt({"ask": "value?"})
        return {
            "steps": state.get("steps", 0) + 1,
            "messages": [AIMessage(content=str(answer))],
        }

    g = StateGraph(State)
    g.add_node("ask", ask)
    g.add_edge(START, "ask")
    g.add_edge("ask", END)
    return g.compile(checkpointer=MemorySaver())


def build_parallel_graph():
    """Fan-out to two branches that each return a step increment.

    Fixture for P3 (parallel interrupt id collision, #6626) — wired into the
    dedup work in a later phase; kept here so the dump/tests have a parallel graph.
    """
    def root(state: State) -> dict[str, Any]:
        return {}

    def left(state: State) -> dict[str, Any]:
        return {"steps": state.get("steps", 0) + 1}

    def right(state: State) -> dict[str, Any]:
        return {"steps": state.get("steps", 0) + 1}

    g = StateGraph(State)
    g.add_node("root", root)
    g.add_node("left", left)
    g.add_node("right", right)
    g.add_edge(START, "root")
    g.add_edge("root", "left")
    g.add_edge("root", "right")
    g.add_edge("left", END)
    g.add_edge("right", END)
    return g.compile(checkpointer=MemorySaver())
