"""Minimal real graphs for GraphLoupe.

build_graph() is the canonical entrypoint convention every user graph follows
(GraphLoupe CLAUDE.md §5). The fixtures here back the L0 PIN tests and pin_dump.py
and use a fake chat model so everything runs offline (no Copilot / vscode.lm).
"""
from __future__ import annotations

import asyncio
from typing import Annotated, Any, Callable, TypedDict

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.func import task
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
        reply = await model.ainvoke(state.get("messages") or [])
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


def _estimate_tokens(messages: list[BaseMessage]) -> int:
    """Cheap sidecar-side prompt estimate (no provider tokenizer on the manual path, P8)."""
    chars = sum(len(str(getattr(m, "content", ""))) for m in messages)
    return max(1, chars // 4)


def manual_infer(messages: list[BaseMessage], expects: str = "text",
                 tool_schema: dict[str, Any] | None = None) -> Any:
    """The manual-inference 'model': pause via interrupt() with a contract-shaped
    payload (manual_inference_required fields), return the resumed value.

    Wrapping interrupt() like this is the ManualChatModel — swap it for a vscode.lm
    call and the same node becomes the Copilot auto path (deferred / backlog).
    """
    rendered = "\n".join(f"{getattr(m, 'type', 'human')}: {m.content}" for m in messages)
    payload = {
        "renderedText": rendered,
        "messages": [{"role": "human", "content": rendered, "name": None, "toolCallId": None}],
        "expects": expects,
        "toolSchema": tool_schema,
        "promptTokens": {"prompt": _estimate_tokens(messages), "completion": None,
                         "source": "sidecar_estimate"},
    }
    return interrupt(payload)


def build_manual_graph(spy: Callable[[], None] | None = None, step_delay: float = 0.0):
    """prepare -> ask(manual inference) -> END. The 'ask' node runs an optional spy
    BEFORE interrupt(), wrapped in @task so the side effect is idempotent across the
    resume re-run (P1: node re-runs; P2/@task: effect replays once). The node then
    pauses for a human-pasted answer."""
    @task
    def _side_effect() -> None:
        if spy:
            spy()

    def prepare(state: State) -> dict[str, Any]:
        return {"steps": state.get("steps", 0) + 1}

    def ask(state: State) -> dict[str, Any]:
        _side_effect().result()  # idempotent pre-interrupt effect (engineering §10 ledger)
        answer = manual_infer(state.get("messages") or [AIMessage(content="(no input)")])
        return {"messages": [AIMessage(content=str(answer))]}

    g = StateGraph(State)
    g.add_node("prepare", prepare)
    g.add_node("ask", ask)
    g.add_edge(START, "prepare")
    g.add_edge("prepare", "ask")
    g.add_edge("ask", END)
    return g.compile(checkpointer=MemorySaver())


def manual_demo():
    """Default-discoverable manual graph for the picker / F5 demo."""
    return build_manual_graph()


def build_showcase(step_delay: float = 0.0):
    """Feature-showcase graph: exercises every GraphLoupe capability in one run.

    Shape (a branch, not a line, so order + routing are visible)::

        __start__ -> ingest -> plan -> gate --(needs human)--> review -> synthesize -> __end__
                                          \\--(auto)-----------------------/

    What each capability sees here:
      - visualization + lanes: ``ingest``/``gate`` are script; ``plan``/``synthesize``
        reference a chat model (closure) -> llm lane; ``review`` calls interrupt()
        -> llm/inference lane. The conditional edge from ``gate`` shows branching.
      - token economy: ``plan`` and ``synthesize`` each invoke the model -> two rows.
      - step debugging: compiled with a checkpointer, so breakpoints / step / fork work.
      - manual inference: ``review`` pauses via interrupt() for a human decision.
      - overview: every node has a docstring first line (shown as its purpose).
    """
    model = FakeMessagesListChatModel(
        responses=[AIMessage(content="1. scan 2. group 3. summarize"),
                   AIMessage(content="Done: 3 modules, 1 risk flagged.")],
    )

    async def ingest(state: State) -> dict[str, Any]:
        """Normalize the incoming request into the first message (script node)."""
        if step_delay:
            await asyncio.sleep(step_delay)
        if state.get("messages"):
            return {"steps": 1}
        req = HumanMessage(content="Analyze this repo and summarize its architecture.")
        return {"messages": [req], "steps": 1}

    async def plan(state: State) -> dict[str, Any]:
        """Ask the model to outline steps (LLM node; counts toward token economy)."""
        if step_delay:
            await asyncio.sleep(step_delay)
        reply = await model.ainvoke(state.get("messages") or [])
        return {"messages": [reply], "steps": state.get("steps", 0) + 1}

    def gate(state: State) -> dict[str, Any]:
        """Confidence gate (script): 3-way switch over the plan's confidence."""
        return {}

    def route(state: State) -> str:
        # a 3-way switch that also loops: re-plan once, then a human pass, then exit.
        # bounded by 'steps' so the demo always terminates.
        s = state.get("steps", 0)
        if s < 3:
            return "redo"    # loop back to plan (re-plan)
        if s < 4:
            return "human"   # route to manual review
        return "auto"        # straight to synthesis

    def review(state: State) -> dict[str, Any]:
        """Pause for a human decision on the plan (manual inference via interrupt())."""
        msgs = state.get("messages") or [AIMessage(content="(plan)")]
        rendered = "\n".join(f"{getattr(m, 'type', 'human')}: {m.content}" for m in msgs)
        answer = interrupt({  # direct interrupt() so the lane is classified statically
            "renderedText": rendered,
            "messages": [{"role": "human", "content": rendered, "name": None, "toolCallId": None}],
            "expects": "text", "toolSchema": None,
            "promptTokens": {"prompt": _estimate_tokens(msgs), "completion": None,
                             "source": "sidecar_estimate"},
        })
        return {"messages": [HumanMessage(content=str(answer))], "steps": state.get("steps", 0) + 1}

    async def synthesize(state: State) -> dict[str, Any]:
        """Summarize the outcome with the model (LLM node; second token-economy row)."""
        if step_delay:
            await asyncio.sleep(step_delay)
        reply = await model.ainvoke(state.get("messages") or [])
        return {"messages": [reply], "steps": state.get("steps", 0) + 1}

    g = StateGraph(State)
    g.add_node("ingest", ingest)
    g.add_node("plan", plan)
    g.add_node("gate", gate)
    g.add_node("review", review)
    g.add_node("synthesize", synthesize)
    g.add_edge(START, "ingest")
    g.add_edge("ingest", "plan")
    g.add_edge("plan", "gate")
    # 3-way switch + a loop: redo -> plan (cycle), human -> review, auto -> synthesize
    g.add_conditional_edges("gate", route, {"redo": "plan", "human": "review", "auto": "synthesize"})
    g.add_edge("review", "synthesize")
    g.add_edge("synthesize", END)
    return g.compile(checkpointer=MemorySaver())


def showcase_graph():
    """Default-discoverable showcase for the F5 demo (visible per-node step delay)."""
    return build_showcase(step_delay=0.4)


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
