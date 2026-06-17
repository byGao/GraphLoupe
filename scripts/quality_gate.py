#!/usr/bin/env python3
"""
GraphLoupe quality gate — L0..L3 runner.

Invoked by the studio workflow `/phase-done graphloupe <phase-id>` via
workflow/apps/graphloupe.manifest.json. Mirrors the test pyramid in
workflow/stages/graphloupe/test-plan.html:

    L0  PINs (P1-P9) + PIN dump comparison
    L1  contract round-trip TS<->Py on the shared golden JSON
    L2  BDD scenarios
    L3  langgraph dev integration consistency

STATUS: L0 is live (pin-dump-foundation). L1-L3 stay PENDING until protocol.ts
and the BDD/integration layers land; a PENDING level exits non-zero so phase-done
halts (a gate must never report a false green).
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

APP_DIR = pathlib.Path(__file__).resolve().parent.parent


def _py(*args: str) -> None:
    subprocess.run([sys.executable, *args], cwd=APP_DIR, check=True)


def _run_l0() -> None:
    """L0: lint (flake8) + types (mypy) + security (bandit) + PIN tests (pytest)."""
    lint_targets = ["graphloupe_sidecar", "protocol.py", "pin_dump.py", "scripts", "tests"]
    ship_targets = ["graphloupe_sidecar", "protocol.py", "pin_dump.py"]
    _py("-m", "flake8", *lint_targets)
    _py("-m", "mypy", *ship_targets, "--ignore-missing-imports")
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


def main() -> int:
    pending = []
    for level_id, desc, runner in LEVELS:
        if runner is None:
            print(f"  {level_id}  PENDING  {desc}")
            pending.append(level_id)
            continue
        # When calibrated, runner() runs the level and raises on failure.
        print(f"  {level_id}  RUN      {desc}")
        runner()  # type: ignore[operator]

    if pending:
        print(
            f"\nquality_gate: {len(pending)} level(s) PENDING "
            f"({', '.join(pending)}) - calibrate in a later phase.",
            file=sys.stderr,
        )
        return 2
    print("\nquality_gate: all levels PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
