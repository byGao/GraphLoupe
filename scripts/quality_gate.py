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

STATUS: scaffold. Every level is PENDING until the pin-dump foundation phase
lands pin_dump.golden.txt and protocol.ts. A PENDING level exits non-zero so
phase-done halts (a gate must never report a false green).
"""
from __future__ import annotations

import sys

# Each level: (id, description, runner). runner=None means PENDING.
LEVELS: list[tuple[str, str, object]] = [
    ("L0", "PINs (P1-P9) + PIN dump vs pin_dump.golden.txt", None),
    ("L1", "contract round-trip TS<->Py on shared golden JSON", None),
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
            f"({', '.join(pending)}) — calibrate after the pin-dump foundation phase.",
            file=sys.stderr,
        )
        return 2
    print("\nquality_gate: all levels PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
