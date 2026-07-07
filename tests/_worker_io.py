"""Timeout-guarded read from a worker subprocess's stdout.

A bare ``proc.stdout.readline()`` blocks forever if the worker never writes the
expected line (protocol mismatch, crash before flushing, deadlock) — the worker
stays alive waiting on stdin, so the pipe never hits EOF either. One such stuck
assertion turned a single flaky test into a CI job stuck for hours (until GitHub's
default 6h job timeout, or a human, killed it). Every worker-subprocess test should
read through this instead of calling ``proc.stdout.readline()`` directly.

Reads run in a helper thread rather than gating on ``select()`` on the raw fd:
``proc.stdout`` is a buffered ``TextIOWrapper``, so a burst of several JSON lines
delivered in one OS-level read can sit fully in its internal buffer — ``select()``
on the fd then reports "not ready" (nothing new at the OS level) even though
``readline()`` would return one of those lines instantly.
"""
from __future__ import annotations

import queue
import subprocess
import threading

DEFAULT_TIMEOUT = 15.0


def readline_timeout(proc: subprocess.Popen, timeout: float = DEFAULT_TIMEOUT) -> str:
    result: "queue.Queue[str]" = queue.Queue(maxsize=1)
    threading.Thread(target=lambda: result.put(proc.stdout.readline()), daemon=True).start()
    try:
        return result.get(timeout=timeout)
    except queue.Empty:
        raise TimeoutError(f"worker produced no output within {timeout}s (pid={proc.pid})") from None
