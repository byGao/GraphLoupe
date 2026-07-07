"""phase3 debugging AC-01/02/04 (headless): breakpoints, state snapshot + diff, step.

Drives the worker over stdio against a 3-node linear graph (a->b->c).
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
from tests._worker_io import readline_timeout

APP_DIR = Path(__file__).resolve().parent.parent


@contextlib.contextmanager
def _worker(entry: str) -> Iterator[subprocess.Popen]:
    proc = subprocess.Popen(  # nosec B603
        [sys.executable, "-m", "graphloupe_sidecar.worker", "--entry", entry],
        cwd=APP_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
        env={**os.environ},
    )
    try:
        readline_timeout(proc)  # startup graph topology
        yield proc
    finally:
        proc.kill()
        proc.wait()


def _send(proc: subprocess.Popen, obj: dict) -> None:
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def _read_until(proc: subprocess.Popen, type_: str):
    for _ in range(80):
        line = readline_timeout(proc)
        if not line:
            break
        ev = P.ServerEventAdapter.validate_python(json.loads(line))
        if ev.type == type_:
            return ev
    raise AssertionError(f"did not see {type_}")


def test_ac01_breakpoint_hit_and_snapshot() -> None:
    with _worker("tests.user_graphs:linear3") as proc:
        _send(proc, {"cmd": "set_breakpoint", "node": "b", "when": "before"})
        _send(proc, {"cmd": "run", "input": {"log": []}})
        bh = _read_until(proc, "breakpoint_hit")
        assert bh.node == "b" and bh.when == "before"
        snap = _read_until(proc, "state_snapshot")
        assert snap.snapshot.values.get("log") == ["a"]            # a ran, paused before b
        assert any(d.channel == "log" and d.op == "add" for d in snap.snapshot.diff)  # AC-04 diff


def test_ac02_step_advances_then_finishes() -> None:
    with _worker("tests.user_graphs:linear3") as proc:
        _send(proc, {"cmd": "set_breakpoint", "node": "b", "when": "before"})
        _send(proc, {"cmd": "run", "input": {"log": []}})
        _read_until(proc, "breakpoint_hit")           # paused before b
        _send(proc, {"cmd": "step"})                  # run b -> pause before c
        assert _read_until(proc, "breakpoint_hit").node == "c"
        _send(proc, {"cmd": "step"})                  # run c -> done
        assert _read_until(proc, "run_finished").status == "completed"


def test_continue_runs_to_next_breakpoint() -> None:
    with _worker("tests.user_graphs:linear3") as proc:
        _send(proc, {"cmd": "set_breakpoint", "node": "c", "when": "before"})
        _send(proc, {"cmd": "run", "input": {"log": []}})
        assert _read_until(proc, "breakpoint_hit").node == "c"   # skipped a,b -> stopped at c
        _send(proc, {"cmd": "run"})                              # continue
        assert _read_until(proc, "run_finished").status == "completed"


def test_ac03_fork_time_travel_with_override() -> None:
    with _worker("tests.user_graphs:linear3") as proc:
        _send(proc, {"cmd": "set_breakpoint", "node": "b", "when": "before"})
        _send(proc, {"cmd": "run", "input": {"log": []}})
        ckpt = _read_until(proc, "breakpoint_hit").checkpointId   # checkpoint before b
        _read_until(proc, "state_snapshot")
        # fork from there with an override; re-runs b, c on a new runId
        _send(proc, {"cmd": "fork", "checkpointId": ckpt, "stateOverride": {"log": ["X"]}})
        final = _read_until(proc, "state_snapshot")              # final state (emitted before run_finished)
        _read_until(proc, "run_finished")                        # fork run finished
        assert "X" in final.snapshot.values["log"]               # override is in the forked state


def test_ac04_no_checkpointer_ignores_breakpoints() -> None:
    with _worker("tests.user_graphs:no_checkpointer") as proc:
        _send(proc, {"cmd": "set_breakpoint", "node": "step", "when": "before"})
        _send(proc, {"cmd": "run", "input": {}})
        assert _read_until(proc, "run_finished").status == "completed"  # no pause, no hang
