"""P1-2 (headless): worker reconstructs the run's per-step state timeline from the
committed checkpoint lineage — each step is the node that ran plus its before/after diff."""
from typing import TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

import protocol as P
from graphloupe_sidecar import worker


class S(TypedDict):
    x: int
    note: str


def _graph():
    def ingest(s):
        return {"x": 1}

    def plan(s):
        return {"x": s["x"] + 1, "note": "done"}

    g = StateGraph(S)
    g.add_node("ingest", ingest)
    g.add_node("plan", plan)
    g.add_edge(START, "ingest")
    g.add_edge("ingest", "plan")
    g.add_edge("plan", END)
    return g.compile(checkpointer=MemorySaver())


def _timeline(graph, thread_id):
    return P.StateTimeline.model_validate_json(worker._state_timeline(graph, thread_id)).steps


def test_reconstructs_per_step_diffs_in_order():
    g = _graph()
    g.invoke({"x": 0}, config={"configurable": {"thread_id": "t"}})
    steps = _timeline(g, "t")

    assert [s.node for s in steps] == ["ingest", "plan"]      # oldest -> newest
    assert [s.seq for s in steps] == [0, 1]                    # seq is dense, ordered

    ingest = steps[0].diff
    assert {d.channel: (d.op, d.before, d.after) for d in ingest} == {"x": ("update", 0, 1)}

    plan = {d.channel: d for d in steps[1].diff}
    assert plan["x"].op == "update" and plan["x"].before == 1 and plan["x"].after == 2
    assert plan["note"].op == "add" and plan["note"].before is None and plan["note"].after == "done"


def test_empty_for_unknown_thread():
    # a thread that never ran has no lineage -> empty timeline, not a crash
    assert _timeline(_graph(), "never-ran") == []
