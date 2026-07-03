#!/usr/bin/env python3
"""
GraphLoupe quality gate — L0..L3 runner.

A test pyramid for the cross-process contract and the framework PINs:

    L0  PINs (P1-P9) + PIN dump comparison
    L1  contract round-trip TS<->Py on the shared golden JSON
    L2  BDD scenarios
    L3  langgraph dev integration consistency

STATUS: L0 is live. L1-L3 stay PENDING until protocol.ts and the BDD/integration
layers land; a PENDING level exits non-zero so the gate halts (it must never
report a false green).
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

APP_DIR = pathlib.Path(__file__).resolve().parent.parent


def _py(*args: str) -> None:
    subprocess.run([sys.executable, *args], cwd=APP_DIR, check=True)


def _run_l0() -> None:
    """L0: lint (flake8) + types (mypy + tsc) + security (bandit) + PIN tests (pytest).

    tsc typechecks the whole TS side (extension + webview + protocol.ts + tests) — esbuild
    only transpiles and vitest erases types, so without this a type error ships silently.
    """
    lint_targets = ["graphloupe_sidecar", "protocol.py", "pin_dump.py", "scripts", "tests"]
    ship_targets = ["graphloupe_sidecar", "protocol.py", "pin_dump.py"]
    _py("-m", "flake8", *lint_targets)
    _py("-m", "mypy", *ship_targets, "--ignore-missing-imports")
    subprocess.run("npm run typecheck", cwd=APP_DIR, shell=True, check=True)  # tsc --noEmit (TS side)
    _py("-m", "bandit", "-rq", *ship_targets)
    _py("-m", "pytest", "tests/", "-q")


def _run_l1() -> None:
    """L1: TS contract round-trip (vitest). The Python half runs under L0's pytest."""
    subprocess.run("npm run test", cwd=APP_DIR, shell=True, check=True)


# Each level: (id, description, runner). runner=None means PENDING.
LEVELS: list[tuple[str, str, object]] = [
    ("L0", "PINs (offline subset) + PIN dump vs pin_dump.golden.txt", _run_l0),
    ("L1", "contract round-trip TS<->Py on shared golden JSON", _run_l1),
    ("L2", "BDD scenarios", None),
    ("L3", "langgraph dev integration consistency", None),
]


def main(live_only: bool = False) -> int:
    """Run the gate. ``live_only`` skips PENDING levels and treats green live
    levels as success (exit 0) — this is what CI runs so the badge means
    "every level that exists today passes," without a false green and without
    duplicating each level's command list outside this file."""
    pending = []
    for level_id, desc, runner in LEVELS:
        if runner is None:
            print(f"  {level_id}  {'SKIP   ' if live_only else 'PENDING'}  {desc}")
            pending.append(level_id)
            continue
        # When calibrated, runner() runs the level and raises on failure.
        print(f"  {level_id}  RUN      {desc}")
        runner()  # type: ignore[operator]

    if pending and not live_only:
        print(
            f"\nquality_gate: {len(pending)} level(s) PENDING "
            f"({', '.join(pending)}) - calibrate in a later phase.",
            file=sys.stderr,
        )
        return 2
    if pending:
        print(
            f"\nquality_gate: live levels PASSED; "
            f"{len(pending)} level(s) not built yet ({', '.join(pending)})."
        )
        return 0
    print("\nquality_gate: all levels PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(live_only="--live" in sys.argv[1:]))
