"""P1-5c (TDD corrective): runs must be ISOLATED — the reconstruction of one run's
branch decisions / state must not absorb an earlier run's.

This is the test that was MISSING: every prior reconstruction test opened its own fresh
thread, so none ever exercised the real runtime condition (all runs reuse thread "run").
That reused-thread case is exactly where lineage-based reconstruction pollutes across
runs — proven here — which is why each run must get its own thread_id.
"""
from typing import TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

import protocol as P
from graphloupe_sidecar import worker


class S(TypedDict):
    steps: int
    decision: str


def _graph():
    def plan(s):
        return {"steps": s.get("steps", 0) + 1}

    def review(s):
        return {"decision": interrupt({"ask": "?"})}

    def route(s):
        return "approve" if s.get("decision") == "approve" else "redo"

    g = StateGraph(S)
    g.add_node("plan", plan)
    g.add_node("review", review)
    g.add_node("gate", lambda s: {})
    g.add_node("synth", lambda s: {"steps": s.get("steps", 0) + 1})
    g.add_edge(START, "plan")
    g.add_edge("plan", "review")
    g.add_edge("review", "gate")
    g.add_conditional_edges("gate", route, {"redo": "plan", "approve": "synth"})
    g.add_edge("synth", END)
    return g.compile(checkpointer=MemorySaver())


def _keys(app, thread_id):
    ev = P.BranchDecisions.model_validate_json(worker._branch_decisions(app, thread_id))
    return [d.key for d in ev.decisions]


def _run_loop_then_approve(app, thread_id):
    cfg = {"configurable": {"thread_id": thread_id}}
    app.invoke({"steps": 0}, config=cfg)
    app.invoke(Command(resume="redo"), config=cfg)
    app.invoke(Command(resume="approve"), config=cfg)


def _run_direct(app, thread_id):
    cfg = {"configurable": {"thread_id": thread_id}}
    app.invoke({"steps": 0}, config=cfg)
    app.invoke(Command(resume="approve"), config=cfg)


def test_distinct_threads_isolate_branch_reconstruction():
    """The invariant the fix relies on: a run on its own thread reconstructs only its own
    decisions, regardless of what other runs happened before it."""
    app = _graph()
    _run_loop_then_approve(app, "run-a")   # an earlier run that looped
    _run_direct(app, "run-b")              # a later, separate run — its own thread
    assert _keys(app, "run-a") == ["redo", "approve"]
    assert _keys(app, "run-b") == ["approve"]   # NOT polluted by run-a


def test_reused_thread_pollutes_reconstruction():
    """The bug (documented as the reason distinct threads are required): running a second
    time on the SAME thread makes the reconstruction absorb the earlier run's decisions."""
    app = _graph()
    _run_loop_then_approve(app, "run")     # first run on thread "run"
    _run_direct(app, "run")                # second run REUSES thread "run"
    # the direct run alone should be just ["approve"], but it inherits the loop's decisions:
    assert _keys(app, "run") == ["redo", "approve", "approve"]
