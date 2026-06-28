"""FastAPI sidecar — relays between the webview (WebSocket /ws) and an isolated
graph-worker subprocess (graph-loading).

The user graph runs ONLY in the worker; the sidecar never imports the user module.
On connect: spawn the worker (entry from GRAPHLOUPE_GRAPH), read its startup line
within GRAPHLOUPE_LOAD_TIMEOUT and forward the GraphTopology (or graph_load_failed).
Then relay worker stdout -> ws, and StartRun -> worker stdin. Kill the worker on
disconnect / timeout / load failure.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess  # nosec B404 - used to isolate the user graph in a subprocess
import sys
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import protocol as P

app = FastAPI()

DEFAULT_ENTRY = "graphloupe_sidecar.graph:demo_graph"
_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _entry() -> str:
    return os.environ.get("GRAPHLOUPE_GRAPH", DEFAULT_ENTRY)


def _project_root() -> str:
    return os.environ.get("GRAPHLOUPE_PROJECT_ROOT", "")


def _load_timeout() -> float:
    return float(os.environ.get("GRAPHLOUPE_LOAD_TIMEOUT", "10"))


def _spawn_worker(entry: str, project_root: str) -> subprocess.Popen[str]:
    # Intentional isolation (graph-loading spec): run the user graph in a separate
    # process. `entry`/`project_root` are trusted local VS Code settings, not network input.
    cmd = [sys.executable, "-m", "graphloupe_sidecar.worker", "--entry", entry]
    if project_root:
        cmd += ["--project-root", project_root]
    return subprocess.Popen(  # nosec B603
        cmd,
        cwd=_APP_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def _graph_load_failed(message: str) -> str:
    return P.ErrorEvent(code="graph_load_failed", message=message).model_dump_json()


def _to_worker(cmd: P.ClientCommand) -> dict[str, Any] | None:
    """Translate a ClientCommand into the worker's stdin command (cmd = the type)."""
    if isinstance(cmd, P.StartRun):
        return {"cmd": "run", "threadId": cmd.threadId or "run", "input": cmd.input}
    if isinstance(cmd, P.Resume):
        return {"cmd": "resume", "payload": cmd.payload.model_dump()}
    if isinstance(cmd, P.SetBreakpoint):
        return {"cmd": "set_breakpoint", "node": cmd.node, "when": cmd.when}
    if isinstance(cmd, P.ClearBreakpoint):
        return {"cmd": "clear_breakpoint", "node": cmd.node, "when": cmd.when}
    if isinstance(cmd, P.Step):
        return {"cmd": "step"}
    if isinstance(cmd, P.GetState):
        return {"cmd": "get_state", "checkpointId": cmd.checkpointId}
    if isinstance(cmd, P.Fork):
        return {"cmd": "fork", "checkpointId": cmd.checkpointId, "stateOverride": cmd.stateOverride}
    if isinstance(cmd, P.Cancel):
        return {"cmd": "abort"}
    return None


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    proc = _spawn_worker(_entry(), _project_root())
    if proc.stdout is None or proc.stdin is None:  # pragma: no cover - PIPE is always set
        raise RuntimeError("worker stdio pipes not available")
    stdout, stdin = proc.stdout, proc.stdin
    pump: asyncio.Task[None] | None = None
    try:
        try:
            first = await asyncio.wait_for(asyncio.to_thread(stdout.readline), timeout=_load_timeout())
        except asyncio.TimeoutError:
            proc.kill()
            await ws.send_text(_graph_load_failed(f"load timed out after {_load_timeout()}s"))
            return
        if not first.strip():
            await ws.send_text(_graph_load_failed("worker exited during load"))
            return
        await ws.send_text(first.strip())
        if json.loads(first).get("type") == "error":
            return  # load failed; worker already exited

        async def _pump() -> None:
            while True:
                line = await asyncio.to_thread(stdout.readline)
                if not line:
                    break
                await ws.send_text(line.strip())

        pump = asyncio.create_task(_pump())
        while True:
            raw = await ws.receive_text()
            try:
                cmd = P.ClientCommandAdapter.validate_json(raw)
            except Exception:  # nosec B112 - skip malformed client commands, keep the relay alive
                continue
            wire = _to_worker(cmd)
            if wire is not None:
                stdin.write(json.dumps(wire) + "\n")
                stdin.flush()
    except WebSocketDisconnect:
        pass
    finally:
        if pump is not None:
            pump.cancel()
        if proc.poll() is None:
            proc.kill()
        await asyncio.to_thread(proc.wait)
        stdout.close()
        stdin.close()


def main() -> None:  # pragma: no cover - real run path
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":  # pragma: no cover
    main()
