"""P1-3 (headless): worker reconstructs router decisions from the checkpoint lineage.
Reads builder.branches for the decision map and correlates parent->child checkpoints so a
normal edge isn't mis-attributed to a router."""
from typing import TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

import protocol as P
from graphloupe_sidecar import worker


class S(TypedDict):
    x: int


def _cond_graph():
    def start(s):
        return {}  # passthrough; router reads the input

    def route(s):
        return "approve" if s["x"] > 3 else "reject"

    g = StateGraph(S)
    g.add_node("start", start)
    g.add_node("synth", lambda s: {})
    g.add_node("stop", lambda s: {})
    g.add_edge(START, "start")
    g.add_conditional_edges("start", route, {"approve": "synth", "reject": "stop"})
    g.add_edge("synth", END)
    g.add_edge("stop", END)
    return g.compile(checkpointer=MemorySaver())


def test_branch_ends_reads_conditional_edges():
    ends = worker._branch_ends(_cond_graph())
    (_, mapping), = ends["start"].items()
    assert mapping == {"approve": "synth", "reject": "stop"}


def test_branch_ends_empty_without_conditional_edges():
    g = StateGraph(S)
    g.add_node("n", lambda s: {})
    g.add_edge(START, "n")
    g.add_edge("n", END)
    assert worker._branch_ends(g.compile()) == {}


def _decisions(graph, thread_id):
    return P.BranchDecisions.model_validate_json(worker._branch_decisions(graph, thread_id)).decisions


def test_reconstructs_the_taken_branch():
    g = _cond_graph()
    g.invoke({"x": 9}, config={"configurable": {"thread_id": "hi"}})   # x>3 -> approve -> synth
    (d,) = _decisions(g, "hi")
    assert d.source == "start" and d.key == "approve" and d.target == "synth"
    assert d.alternatives == {"approve": "synth", "reject": "stop"}
    assert d.stateValues.get("x") == 9

    g.invoke({"x": 1}, config={"configurable": {"thread_id": "lo"}})   # x<=3 -> reject -> stop
    (d2,) = _decisions(g, "lo")
    assert d2.key == "reject" and d2.target == "stop"


def test_no_decisions_without_conditional_edges():
    g = StateGraph(S)
    g.add_node("n", lambda s: {"x": 1})
    g.add_edge(START, "n")
    g.add_edge("n", END)
    app = g.compile(checkpointer=MemorySaver())
    app.invoke({"x": 0}, config={"configurable": {"thread_id": "t"}})
    assert _decisions(app, "t") == []
