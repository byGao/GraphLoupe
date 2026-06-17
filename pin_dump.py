"""pin_dump.py — dump the real framework behavior for the installed versions.

Run once, commit the output as pin_dump.golden.txt; PIN-07 re-runs this and
compares against the golden (red = the framework moved, recheck the pins).
Offline: build_graph() uses a fake chat model, so no Copilot / vscode.lm needed.

Determinism: we print sorted *keys* and shapes, never values that carry ids or
timestamps, so two runs on the same versions produce byte-identical output.
"""
from __future__ import annotations

import asyncio
import importlib.metadata as meta

from langchain_core.messages import HumanMessage

from graphloupe_sidecar.graph import build_graph

PKGS = ["langgraph", "langchain-core", "langgraph-checkpoint", "langgraph-checkpoint-sqlite"]
THREAD = {"configurable": {"thread_id": "pin"}}


def _h(title: str) -> None:
    print(f"== {title} ==")


def main() -> None:
    _h("versions")
    for pkg in PKGS:
        print(f"{pkg} {meta.version(pkg)}")

    app = build_graph()
    g = app.get_graph()

    _h("get_graph nodes (PIN: R1 render contract)")
    print("NODES:", sorted(g.nodes))

    _h("get_graph edges")
    print("EDGES:", sorted((e.source, e.target) for e in g.edges))

    _h("astream_events v2 shapes (PIN: P4 event protocol, LlmStart.model)")

    async def run_events() -> None:
        seen: dict[str, tuple] = {}
        async for ev in app.astream_events(
            {"messages": [HumanMessage(content="ping")], "steps": 0},
            version="v2",
            config=THREAD,
        ):
            name = ev["event"]
            if name in ("on_chain_start", "on_chat_model_start") and name not in seen:
                seen[name] = (
                    sorted(ev.keys()),
                    sorted((ev.get("data") or {}).keys()),
                    sorted((ev.get("metadata") or {}).keys()),
                )
        for name in sorted(seen):
            ev_keys, data_keys, meta_keys = seen[name]
            print(f"{name}: event_keys={ev_keys}")
            print(f"{name}: data_keys={data_keys}")
            print(f"{name}: metadata_keys={meta_keys}")

    asyncio.run(run_events())

    _h("get_state().values (PIN: StateSnapshot.values, StateDiffEntry.channel)")
    state = app.get_state(THREAD)
    print("VALUE_CHANNELS:", sorted(state.values.keys()))
    print("VALUE_TYPES:", {k: type(v).__name__ for k, v in sorted(state.values.items())})

    _h("checkpointer + fork API (PIN: SqliteSaver path, update_state/get_state_history)")
    from langgraph.checkpoint.sqlite import SqliteSaver

    print("SqliteSaver:", f"{SqliteSaver.__module__}.{SqliteSaver.__name__}")
    print("graph.update_state:", hasattr(app, "update_state"))
    print("graph.get_state_history:", hasattr(app, "get_state_history"))


if __name__ == "__main__":
    main()
