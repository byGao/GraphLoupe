"""P1-5d (headless): a completed run reports its final state as a StateSnapshotEvent, so
History/comparison have a finalState (a normal run otherwise emits full state only at pauses)."""
from typing import TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

import protocol as P
from graphloupe_sidecar import worker


class S(TypedDict):
    steps: int
    note: str


def _graph():
    g = StateGraph(S)
    g.add_node("a", lambda s: {"steps": 1})
    g.add_node("b", lambda s: {"steps": s["steps"] + 1, "note": "done"})
    g.add_edge(START, "a")
    g.add_edge("a", "b")
    g.add_edge("b", END)
    return g.compile(checkpointer=MemorySaver())


def test_final_state_reports_head_values_with_last_step_diff():
    app = _graph()
    app.invoke({"steps": 0}, config={"configurable": {"thread_id": "t"}})
    ev = P.StateSnapshotEvent.model_validate_json(worker._final_state(app, "t"))
    assert ev.snapshot.values["steps"] == 2
    assert ev.snapshot.values["note"] == "done"
    # diff is the genuine last super-step (b: steps 1->2, +note), not an all-add dump
    ops = {d.channel: d.op for d in (ev.snapshot.diff or [])}
    assert ops["steps"] == "update" and ops["note"] == "add"
