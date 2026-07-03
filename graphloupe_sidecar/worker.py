"""graph-worker — isolated subprocess that imports and runs the user graph.

User code (import + build_graph + astream_events) runs ONLY here, never in the
sidecar main process; a crash / hang / exception is contained to this process.
Speaks line-delimited JSON: one startup line, then an async command loop.

  startup  -> {"type":"graph", nodes, edges}                       (success)
           or {"type":"error","code":"graph_load_failed", message}  (any failure)
  stdin    <- {"cmd":"run","threadId":..,"input":{..}}
           <- {"cmd":"resume","payload":{kind:"text",text} | {kind:"tool_call",name,args}}
           <- {"cmd":"shutdown"}
  stdout   -> run_started / node_start* / node_end* / manual_inference_required /
              run_finished / error  (protocol ServerEvents)

manual_inference_required pauses the run (interrupt); the matching resume validates
against the pending interrupt and continues via Command(resume=...). PHASE 2.

Entry format: "package.module:callable" (callable returns a compiled graph).
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import functools
import importlib
import inspect
import json
import os
import sys
import textwrap
import threading
from typing import Any

from langgraph.types import Command

import protocol as P

try:  # classification reads langchain model types; degrade gracefully if absent
    from langchain_core.language_models import BaseLanguageModel
    _MODEL_TYPES: tuple[type, ...] = (BaseLanguageModel,)
except Exception:  # pragma: no cover - langchain always present in practice
    _MODEL_TYPES = ()


def _add_project_root(root: str) -> None:
    """Put the user's project on sys.path so `entry` resolves against THEIR repo,
    not the sidecar's own folder (workspace-load). Also put <root>/.graphloupe on the
    path (in front) when it exists, so a generated adapter (P0-4 entry wizard) imports as
    `entry` while its own `from <user module>` still resolves via root."""
    if not root:
        return
    if root not in sys.path:
        sys.path.insert(0, root)
    adapter_dir = os.path.join(root, ".graphloupe")
    if os.path.isdir(adapter_dir) and adapter_dir not in sys.path:
        sys.path.insert(0, adapter_dir)


def _load(entry: str) -> Any:
    module_name, _, attr = entry.partition(":")
    builder = getattr(importlib.import_module(module_name), attr or "build_graph")
    return builder()


def _emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _langgraph_version() -> str | None:
    """langgraph version in this (the user's) interpreter, for the health panel (P0-5)."""
    try:
        import importlib.metadata as md
        return md.version("langgraph")
    except Exception:  # pragma: no cover - langgraph always installed where a graph loads
        return None


def _node_fn(node: Any) -> Any:
    """The user's callable behind a compiled node (async lives in .afunc)."""
    data = getattr(node, "data", None)
    return (getattr(data, "afunc", None) or getattr(data, "func", None)
            or getattr(data, "bound", None) or data)


def _node_docs(drawable: Any) -> dict[str, str | None]:
    """First docstring line per node (the node's purpose) for the overview table.
    Reliable across graphs (unlike source-based LLM detection); missing -> None."""
    docs: dict[str, str | None] = {}
    for name, node in getattr(drawable, "nodes", {}).items():
        fn = _node_fn(node)
        doc = inspect.getdoc(fn) if callable(fn) else None
        docs[name] = doc.splitlines()[0] if doc else None
    return docs


def _source_fn(fn: Any) -> Any:
    """The user's own function behind a node callable, for source resolution.
    LangGraph wraps a sync node as ``functools.partial(run_in_executor, None, user_fn)``
    with ``@wraps(user_fn)`` — so ``partial.func`` is the langchain wrapper (wrong file),
    but ``__wrapped__`` points at the user's function. Follow __wrapped__ first, then peel
    a partial / bound method."""
    try:
        fn = inspect.unwrap(fn)  # follows __wrapped__ (functools.wraps)
    except ValueError:  # pragma: no cover - broken __wrapped__ cycle
        pass
    if isinstance(fn, functools.partial):
        for cand in (*fn.args, fn.func):  # prefer a wrapped user fn over the wrapper
            if callable(cand) and not isinstance(cand, functools.partial):
                return cand
    return getattr(fn, "__func__", fn)  # bound method -> its function


def _node_sources(drawable: Any) -> dict[str, P.SourceRef]:
    """Source location (file:line) per node, for jump-to-source (P1-1). Uses
    inspect.getsourcefile + getsourcelines (line = the def line) on the unwrapped user
    function. Nodes with no resolvable source (lambda/builtin/C-ext/dynamic) are omitted."""
    out: dict[str, P.SourceRef] = {}
    for name, node in getattr(drawable, "nodes", {}).items():
        if name in ("__start__", "__end__"):
            continue
        fn = _source_fn(_node_fn(node))
        if not callable(fn):
            continue
        try:
            file = inspect.getsourcefile(fn)
            line = inspect.getsourcelines(fn)[1]
        except (OSError, TypeError):
            continue
        if file:
            out[name] = P.SourceRef(file=file, line=line)
    return out


def _refs_a_model(fn: Any) -> bool:
    """True if the node closes over / references a langchain model instance — the
    reliable LLM signal (models are usually captured in the node's closure)."""
    objs: list[Any] = []
    for cell in getattr(fn, "__closure__", None) or ():
        try:
            objs.append(cell.cell_contents)
        except ValueError:  # empty cell
            pass
    g = getattr(fn, "__globals__", {})
    for name in getattr(getattr(fn, "__code__", None), "co_names", ()):
        if name in g:
            objs.append(g[name])
    return any(isinstance(o, _MODEL_TYPES) for o in objs)


def _calls_interrupt(fn: Any) -> bool:
    """True if the node body calls interrupt() (manual inference). AST-based, so it
    never trips on docstrings/comments the way a source regex would."""
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    except (OSError, TypeError, SyntaxError):
        return False
    return any(isinstance(n, ast.Call) and getattr(n.func, "id", None) == "interrupt"
               for n in ast.walk(tree))


def _edge_labels(drawable: Any) -> dict[str, str]:
    """Branch condition per conditional edge (e.data), keyed "src->tgt". langgraph
    omits e.data when the path-map key equals the target name, so only meaningfully
    named branches get a label — which is what we want to show."""
    out: dict[str, str] = {}
    for e in getattr(drawable, "edges", []):
        if getattr(e, "data", None):
            out[f"{e.source}->{e.target}"] = str(e.data)
    return out


def _node_kinds(drawable: Any) -> dict[str, str]:
    """Static best-effort node classification: "manual" if it calls interrupt()
    (pause for a human paste), else "llm" if it references a model instance (an API
    call), else "script". Runtime events (llm_start / manual_inference_required)
    refine this in the webview."""
    kinds: dict[str, str] = {}
    for name, node in getattr(drawable, "nodes", {}).items():
        if name in ("__start__", "__end__"):
            continue
        fn = _node_fn(node)
        if callable(fn) and _calls_interrupt(fn):
            kinds[name] = "manual"          # human-in-the-loop takes precedence
        elif callable(fn) and _refs_a_model(fn):
            kinds[name] = "llm"
        else:
            kinds[name] = "script"
    return kinds


def _interrupt_from_state(state: Any) -> tuple[str, str, dict[str, Any]] | None:
    """If paused at a manual interrupt() (not a breakpoint), return (node, id, payload)."""
    if state.next and state.tasks and state.tasks[0].interrupts:
        intr = state.tasks[0].interrupts[0]
        return state.next[0], intr.id, dict(intr.value)
    return None


def _bp_lists(breakpoints: set[tuple[str, str]]) -> tuple[list[str], list[str]]:
    before = sorted({n for n, w in breakpoints if w == "before"})
    after = sorted({n for n, w in breakpoints if w == "after"})
    return before, after


def _jsonsafe(value: Any) -> Any:
    """Coerce arbitrary graph state to JSON-safe values (objects -> str)."""
    return json.loads(json.dumps(value, default=str))


def _diff(prev: dict[str, Any], cur: dict[str, Any]) -> list[P.StateDiffEntry]:
    entries: list[P.StateDiffEntry] = []
    for key, val in cur.items():
        if key not in prev:
            entries.append(P.StateDiffEntry(channel=key, before=None, after=_jsonsafe(val), op="add"))
        elif prev[key] != val:
            entries.append(P.StateDiffEntry(
                channel=key, before=_jsonsafe(prev[key]), after=_jsonsafe(val), op="update"))
    for key, val in prev.items():
        if key not in cur:
            entries.append(P.StateDiffEntry(channel=key, before=_jsonsafe(val), after=None, op="remove"))
    return entries


def _snapshot(thread_id: str, checkpoint_id: str, values: dict[str, Any],
              prev: dict[str, Any]) -> str:
    snap = P.StateSnapshot(values=_jsonsafe(values), diff=_diff(prev, values))
    return P.StateSnapshotEvent(
        threadId=thread_id, checkpointId=checkpoint_id, snapshot=snap).model_dump_json()


def _manual_required(thread_id: str, node: str, intr_id: str, val: dict[str, Any]) -> str:
    schema = val.get("toolSchema")
    event = P.ManualInferenceRequired(
        threadId=thread_id, runId=thread_id, node=node, interruptId=intr_id,
        renderedText=val.get("renderedText", ""),
        messages=[P.ChatMessage(**m) for m in val.get("messages", [])],
        expects=val.get("expects", "text"),
        toolSchema=P.JsonSchema(**schema) if schema else None,
        promptTokens=P.TokenCount(**val["promptTokens"]),
    )
    return event.model_dump_json()


def _validate_resume(
    intr_value: dict[str, Any], payload: dict[str, Any],
) -> tuple[Any, "P.ErrorCode | None"]:
    """Validate a resume payload against the pending interrupt (B-domain boundary).
    Returns (resume_value, None) on success, or (None, error_code)."""
    expects = intr_value.get("expects", "text")
    kind = payload.get("kind")
    if expects == "text":
        if kind != "text":
            return None, "resume_kind_mismatch"
        return payload.get("text", ""), None
    # expects == "tool_call"
    if kind != "tool_call":
        return None, "resume_kind_mismatch"
    required = (intr_value.get("toolSchema") or {}).get("required") or []
    args = payload.get("args") or {}
    if [r for r in required if r not in args]:
        return None, "tool_schema_validation"
    return {"name": payload.get("name"), "args": args}, None


_SHUTDOWN = object()
_ABORT = object()
# set by the stdin reader on an "abort" command; checked mid-stream so a run can be
# cancelled cleanly (no sidecar restart) even while a node is streaming.
_abort = {"on": False}


def _estimate_tokens(text: str) -> int:
    """Cheap sidecar-side estimate (~4 chars/token) when no provider tokenizer is
    available — P8: never report an estimate as exact. See protocol.TokenSource."""
    return max(1, len(text) // 4) if text else 0


def _text_of(content: Any) -> str:
    """Flatten a message/content into text: str as-is, list of parts -> their text,
    BaseMessage -> its .content, nested lists -> recurse."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    inner = getattr(content, "content", None)
    if inner is not None:
        return _text_of(inner)
    if isinstance(content, dict):
        return str(content.get("text", ""))
    if isinstance(content, (list, tuple)):
        return " ".join(_text_of(p) for p in content)
    return str(content)


def _clip(text: str, limit: int = 4000) -> str:
    """Cap prompt/response text so a huge context doesn't bloat the event stream."""
    return text if len(text) <= limit else text[:limit] + f"\n…(+{len(text) - limit} chars)"


def _llm_event(ev: dict[str, Any], thread_id: str, run_id: str) -> str | None:
    """Translate an astream_events chat-model event into an LlmStart/LlmEnd line.
    PIN: the node is metadata.langgraph_node (ev.name is the model class). P8: fall
    back to sidecar_estimate when the model carries no usage_metadata."""
    name = ev["event"]
    data = ev.get("data") or {}
    if name == "on_chat_model_start":
        md = ev.get("metadata") or {}
        node = md.get("langgraph_node")
        if not node:
            return None
        inp = data.get("input")
        msgs = inp.get("messages") if isinstance(inp, dict) else inp
        text = _text_of(msgs)
        return P.LlmStart(
            threadId=thread_id, runId=run_id, node=node, llmEventId=ev["run_id"],
            model=md.get("ls_model_type") or ev.get("name"),
            promptTokens=P.TokenCount(prompt=_estimate_tokens(text), completion=None,
                                      source="sidecar_estimate"),
            promptText=_clip(text),  # the actual prompt sent to the model
        ).model_dump_json()
    # on_chat_model_end
    out = data.get("output")
    usage = getattr(out, "usage_metadata", None)
    out_text = _text_of(out)
    if usage:
        tokens = P.TokenCount(prompt=int(usage.get("input_tokens") or 0),
                              completion=usage.get("output_tokens"), source="api_usage")
    else:
        tokens = P.TokenCount(prompt=0, completion=_estimate_tokens(out_text),
                              source="sidecar_estimate")
    return P.LlmEnd(llmEventId=ev["run_id"], tokens=tokens,
                    completionText=_clip(out_text),  # the model's response
                    finishReason=getattr(out, "response_metadata", {}).get("finish_reason")
                    if out is not None else None).model_dump_json()


def _emit_event(ev: dict[str, Any], nodes: set[str], thread_id: str, run_id: str) -> None:
    """Emit the ServerEvent for one astream_events item: node chain start/end, plus
    LLM start/end for token economy (PHASE 4). Chat-model events are keyed by
    metadata.langgraph_node, not ev.name, so they bypass the node-name filter."""
    name = ev["event"]
    if name in ("on_chat_model_start", "on_chat_model_end"):
        line = _llm_event(ev, thread_id, run_id)
        if line:
            _emit(line)
        return
    node = ev.get("name")
    if node not in nodes:
        return
    if name == "on_chain_start":
        _emit(P.NodeStart(threadId=thread_id, runId=run_id, node=node,
                          checkpointId="-", ts=0.0).model_dump_json())
    elif name == "on_chain_end":
        _emit(P.NodeEnd(threadId=thread_id, runId=run_id, node=node,
                        checkpointId="-", durationMs=0.0).model_dump_json())


async def _stream(graph: Any, nodes: set[str], source: Any, thread_id: str,
                  before: list[str] | None = None, after: list[str] | None = None,
                  config: dict[str, Any] | None = None) -> None:
    # `config` lets a back-a-node fork resume from a past checkpoint; otherwise the
    # thread's latest checkpoint (by thread_id) is used.
    cfg = config or {"configurable": {"thread_id": thread_id}}
    kwargs: dict[str, Any] = {}
    if before is not None:
        kwargs["interrupt_before"] = before
    if after:
        kwargs["interrupt_after"] = after
    async for ev in graph.astream_events(source, version="v2", config=cfg, **kwargs):
        if _abort["on"]:
            return  # cancelled mid-stream; _run emits run_finished(aborted)
        _emit_event(ev, nodes, thread_id, thread_id)


class _ForkTo:
    """A pause handler resolved a back-a-node fork; carries the target checkpoint
    config (already state-overridden if requested) for the run loop to resume from."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config


def _resolve_checkpoint(graph: Any, thread_id: str, ckpt_id: str | None) -> dict[str, Any] | None:
    """The full checkpoint config (incl checkpoint_ns) for `ckpt_id` from history;
    hand-built configs miss checkpoint_ns and update_state would KeyError."""
    base = {"configurable": {"thread_id": thread_id}}
    return next((s.config for s in graph.get_state_history(base)
                 if s.config["configurable"].get("checkpoint_id") == ckpt_id), None)


_HISTORY_LIMIT = 50  # cap the time-travel timeline so replays don't grow it unbounded


def _checkpoint_history(graph: Any, thread_id: str) -> str:
    """The time-travel timeline (newest first): the current head's lineage back to the
    start, following parent_config. This is the live path only — get_state_history would
    also dump every orphaned replay branch, which is just noise. Each entry's `node` is
    what would run next from that checkpoint ("rewind to before <node>")."""
    refs: list[P.CheckpointRef] = []
    s = graph.get_state({"configurable": {"thread_id": thread_id}})
    while s is not None and len(refs) < _HISTORY_LIMIT:
        cid = s.config["configurable"].get("checkpoint_id")
        if cid is None:
            break
        node = s.next[0] if s.next else None
        # collapse consecutive same-node entries: forking re-runs a node, leaving a
        # child checkpoint at the same position; keep the newest (a real loop puts other
        # nodes in between, so it isn't collapsed).
        if not refs or refs[-1].node != node:
            refs.append(P.CheckpointRef(checkpointId=cid, node=node))
        s = graph.get_state(s.parent_config) if s.parent_config else None
    return P.CheckpointHistory(threadId=thread_id, checkpoints=refs).model_dump_json()


def _branch_ends(graph: Any) -> dict[str, dict[str, dict[str, str]]]:
    """{source_node: {branch_name: {key: target}}} for the graph's conditional edges (P1-3).
    Reads the compiled graph's builder.branches — framework internals (PIN); degrade to {}
    if that structure changes so a branch we can't read never crashes a run."""
    try:
        branches = graph.builder.branches
    except Exception:  # pragma: no cover - builder/branches shape may drift across versions
        return {}
    out: dict[str, dict[str, dict[str, str]]] = {}
    for node, brs in branches.items():
        for name, branch in brs.items():
            ends = getattr(branch, "ends", None)
            if ends:
                out.setdefault(node, {})[name] = {str(k): str(v) for k, v in ends.items()}
    return out


def _branch_decisions(graph: Any, thread_id: str) -> str:
    """Reconstruct router decisions from the committed checkpoint lineage (P1-3): for each
    parent->child step the parent's `next` node RAN to produce the child; if that node is a
    conditional source and the child's `next` (or __end__ at completion) is one of its
    targets, record {source, key, target, alternatives, state}. The parent->child
    correlation avoids mis-attributing a normal edge (ingest->plan) to a router that can
    also reach that target (gate->plan)."""
    ends_by_source = _branch_ends(graph)
    decisions: list[P.BranchDecision] = []
    if ends_by_source:
        s = graph.get_state({"configurable": {"thread_id": thread_id}})
        steps = 0
        while s is not None and s.parent_config and steps < _HISTORY_LIMIT:
            steps += 1
            parent = graph.get_state(s.parent_config)
            ran = parent.next[0] if parent.next else None      # node that ran to produce s
            target = s.next[0] if s.next else "__end__"        # where it led (END at completion)
            if ran in ends_by_source:
                for ends in ends_by_source[ran].values():
                    if target in ends.values():
                        key = next((k for k, v in ends.items() if v == target), None)
                        decisions.append(P.BranchDecision(
                            source=ran, key=key, target=target, alternatives=ends,
                            stateValues=_jsonsafe(s.values)))
                        break
            s = parent
    decisions.reverse()  # oldest -> newest
    return P.BranchDecisions(threadId=thread_id, decisions=decisions).model_dump_json()


def _state_timeline(graph: Any, thread_id: str) -> str:
    """Reconstruct the run's per-step state evolution from the committed checkpoint lineage
    (P1-2): for each parent->child step the node `parent.next[0]` ran to produce the child,
    so its effect is `_diff(parent.values, child.values)`. Same lineage walk and _diff the
    snapshot/timeline already use — post-commit reliable (not the racy on_chain_end)."""
    raw: list[tuple[str, str | None, list[P.StateDiffEntry]]] = []  # (checkpointId, node, diff)
    s = graph.get_state({"configurable": {"thread_id": thread_id}})
    count = 0
    while s is not None and s.parent_config and count < _HISTORY_LIMIT:
        count += 1
        parent = graph.get_state(s.parent_config)
        ran = parent.next[0] if parent.next else None      # node that ran to produce s
        # skip the START pseudo-step (input write, attributed to __start__): the timeline is
        # "which real node changed what", the raw input lives in the State/Raw view.
        if ran not in ("__start__", "__end__"):
            cid = s.config["configurable"].get("checkpoint_id") if s.config else None
            raw.append((cid or "-", ran, _diff(parent.values or {}, s.values or {})))
        s = parent
    raw.reverse()  # oldest -> newest
    steps = [P.StateStep(seq=i, checkpointId=cid, node=node, diff=diff)
             for i, (cid, node, diff) in enumerate(raw)]
    return P.StateTimeline(threadId=thread_id, steps=steps).model_dump_json()


def _fork_target(graph: Any, thread_id: str, cmd: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve a fork command into a resume config; emit checkpoint_not_found on a miss."""
    ckpt_id = cmd.get("checkpointId")
    cfg = _resolve_checkpoint(graph, thread_id, ckpt_id)
    if cfg is None:
        _emit(P.ErrorEvent(code="checkpoint_not_found",
                           message=f"no checkpoint {ckpt_id}").model_dump_json())
        return None
    override = cmd.get("stateOverride")
    return graph.update_state(cfg, override) if override else cfg


async def _next_cmd(cmd_q: "asyncio.Queue[str | None]",
                    breakpoints: set[tuple[str, str]]) -> dict[str, Any] | None:
    """Next stdin command; breakpoint set/clear are applied transparently (any time)."""
    while True:
        raw = await cmd_q.get()
        if raw is None:
            return None
        cmd = json.loads(raw)
        kind = cmd.get("cmd")
        if kind == "set_breakpoint":
            breakpoints.add((cmd["node"], cmd.get("when", "before")))
            continue
        if kind == "clear_breakpoint":
            breakpoints.discard((cmd["node"], cmd.get("when", "before")))
            continue
        return cmd


async def _await_resume(cmd_q: "asyncio.Queue[str | None]", intr_value: dict[str, Any],
                        node: str, breakpoints: set[tuple[str, str]],
                        graph: Any, thread_id: str) -> Any:
    while True:
        cmd = await _next_cmd(cmd_q, breakpoints)
        if cmd is None:
            return _SHUTDOWN
        kind = cmd.get("cmd")
        if kind == "abort":
            return _ABORT
        if kind == "fork":  # ◀ Back: re-run from a past checkpoint instead of resuming
            target = _fork_target(graph, thread_id, cmd)
            if target is not None:
                return _ForkTo(target)
            continue
        if kind != "resume":
            continue
        resume_value, err = _validate_resume(intr_value, cmd.get("payload") or {})
        if err:
            _emit(P.ErrorEvent(code=err, message=f"resume rejected: {err}", node=node).model_dump_json())
            continue
        return Command(resume=resume_value)


async def _await_debug(cmd_q: "asyncio.Queue[str | None]", graph: Any, nodes: set[str],
                       thread_id: str, cfg: dict[str, Any], breakpoints: set[tuple[str, str]],
                       prev: dict[str, Any]) -> Any:
    """At a breakpoint pause: step / continue / inspect / fork, until an advance is chosen.
    A fork returns a _ForkTo so the run loop resumes from the chosen checkpoint."""
    while True:
        cmd = await _next_cmd(cmd_q, breakpoints)
        if cmd is None:
            return "shutdown"
        kind = cmd.get("cmd")
        if kind == "abort":
            return "abort"
        if kind == "step":
            return "step"
        if kind in ("run", "resume"):  # ▶ Run / resume while paused = continue to next bp
            return "continue"
        if kind == "get_state":
            state = graph.get_state(cfg)
            ckpt = state.config["configurable"]["checkpoint_id"] if state.config else "-"
            _emit(_snapshot(thread_id, ckpt, state.values, prev))
        elif kind == "fork":
            target = _fork_target(graph, thread_id, cmd)
            if target is not None:
                return _ForkTo(target)


async def _run(graph: Any, nodes: set[str], thread_id: str, run_input: Any,
               cmd_q: "asyncio.Queue[str | None]", breakpoints: set[tuple[str, str]]) -> None:
    _abort["on"] = False
    _emit(P.RunStarted(threadId=thread_id, runId=thread_id).model_dump_json())
    cfg = {"configurable": {"thread_id": thread_id}}

    def _aborted() -> bool:
        if not _abort["on"]:
            return False
        _abort["on"] = False
        _emit(P.RunFinished(threadId=thread_id, runId=thread_id, status="aborted").model_dump_json())
        return True
    # interrupt/breakpoints/time-travel need a checkpointer; a graph compiled without one
    # can't pause, so just stream it to completion.
    has_checkpointer = getattr(graph, "checkpointer", None) is not None
    prev: dict[str, Any] = {}
    source: Any = run_input
    fork_config: dict[str, Any] | None = None  # set by ◀ Back: resume from a past checkpoint
    step_mode = False
    while True:
        before: list[str] | None = None
        after: list[str] | None = None
        if has_checkpointer:
            bp_before, after = _bp_lists(breakpoints)
            before = sorted(nodes) if step_mode else bp_before
        was_fork = fork_config is not None
        await _stream(graph, nodes, source, thread_id, before, after, config=fork_config)
        fork_config = None
        if _aborted():
            return
        step_mode = False
        state = graph.get_state(cfg) if has_checkpointer else None
        if state is None or not state.next:
            _emit(P.RunFinished(threadId=thread_id, runId=thread_id, status="completed").model_dump_json())
            if has_checkpointer:
                _emit(_branch_decisions(graph, thread_id))  # router decisions for the run (P1-3)
                _emit(_state_timeline(graph, thread_id))    # per-step state evolution (P1-2)
            # a fork/time-travel run reports its final state so the UI can show the result
            if was_fork and state is not None:
                fckpt = state.config["configurable"]["checkpoint_id"] if state.config else "-"
                _emit(_snapshot(thread_id, fckpt, state.values, {}))
            return
        intr = _interrupt_from_state(state)
        if intr is not None:  # manual inference (PHASE 2)
            node, intr_id, val = intr
            _emit(_manual_required(thread_id, node, intr_id, val))
            _emit(_checkpoint_history(graph, thread_id))  # timeline for ◀ time-travel
            _emit(_branch_decisions(graph, thread_id))  # router decisions so far (P1-3)
            _emit(_state_timeline(graph, thread_id))    # per-step state evolution so far (P1-2)
            outcome = await _await_resume(cmd_q, val, node, breakpoints, graph, thread_id)
            if outcome is _SHUTDOWN:
                return
            if outcome is _ABORT:
                _emit(P.RunFinished(threadId=thread_id, runId=thread_id, status="aborted").model_dump_json())
                return
            if isinstance(outcome, _ForkTo):  # ◀ Back from the manual pause
                fork_config, source = outcome.config, None
                _emit(P.RunStarted(threadId=thread_id, runId=thread_id).model_dump_json())
                continue
            source = outcome
            continue
        # breakpoint / step pause (PHASE 3)
        node = state.next[0]
        ckpt = state.config["configurable"]["checkpoint_id"]
        _emit(P.BreakpointHit(threadId=thread_id, runId=thread_id, node=node, when="before",
                              checkpointId=ckpt).model_dump_json())
        _emit(_snapshot(thread_id, ckpt, state.values, prev))
        _emit(_checkpoint_history(graph, thread_id))  # timeline for ◀ time-travel
        _emit(_branch_decisions(graph, thread_id))  # router decisions so far (P1-3 parity)
        _emit(_state_timeline(graph, thread_id))    # per-step state evolution so far (P1-2)
        prev = dict(state.values)
        action = await _await_debug(cmd_q, graph, nodes, thread_id, cfg, breakpoints, prev)
        if action == "shutdown":
            return
        if action == "abort":
            _emit(P.RunFinished(threadId=thread_id, runId=thread_id, status="aborted").model_dump_json())
            return
        if isinstance(action, _ForkTo):  # ◀ Back from the breakpoint pause
            fork_config, source = action.config, None
            _emit(P.RunStarted(threadId=thread_id, runId=thread_id).model_dump_json())
            continue
        step_mode = action == "step"
        source = None


async def _amain(graph: Any, nodes: set[str]) -> None:
    loop = asyncio.get_running_loop()
    cmd_q: "asyncio.Queue[str | None]" = asyncio.Queue()

    def reader() -> None:
        for line in sys.stdin:
            stripped = line.strip()
            if stripped:
                try:  # surface an abort immediately (mid-stream), not just via the queue
                    if json.loads(stripped).get("cmd") == "abort":
                        _abort["on"] = True
                except (ValueError, AttributeError):
                    pass
                loop.call_soon_threadsafe(cmd_q.put_nowait, stripped)
        loop.call_soon_threadsafe(cmd_q.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()
    breakpoints: set[tuple[str, str]] = set()
    while True:
        cmd = await _next_cmd(cmd_q, breakpoints)  # set/clear breakpoints apply while idle too
        if cmd is None:
            return
        if cmd.get("cmd") == "run":
            try:
                await _run(graph, nodes, cmd.get("threadId") or "run",
                           cmd.get("input") or {"messages": [], "steps": 0}, cmd_q, breakpoints)
            except Exception as exc:  # a user-graph node raised: surface it, stay alive
                _emit(P.ErrorEvent(
                    code="internal",
                    message=f"run failed: {type(exc).__name__}: {exc}",
                ).model_dump_json())
        elif cmd.get("cmd") == "shutdown":
            return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--entry", default="graphloupe_sidecar.graph:demo_graph")
    parser.add_argument("--project-root", default="")
    args = parser.parse_args()
    _add_project_root(args.project_root)

    try:
        graph = _load(args.entry)
        g = graph.get_graph()
        nodes = set(g.nodes) - {"__start__", "__end__"}
        try:
            input_schema = graph.get_input_jsonschema()
        except Exception:  # introspection is best-effort; fall back to the raw JSON box
            input_schema = None
        _emit(P.GraphTopology(
            nodes=sorted(g.nodes),
            edges=sorted((e.source, e.target) for e in g.edges),
            inputSchema=input_schema,
            projectRoot=args.project_root or None,
            nodeDocs=_node_docs(g),
            nodeKinds=_node_kinds(g),
            edgeLabels=_edge_labels(g),
            nodeSources=_node_sources(g),
            hasCheckpointer=getattr(graph, "checkpointer", None) is not None,
            langgraphVersion=_langgraph_version(),
            workerPython=sys.executable,
        ).model_dump_json())
    except Exception as exc:  # import error / missing attr / build raises
        _emit(P.ErrorEvent(code="graph_load_failed",
                           message=f"{type(exc).__name__}: {exc}").model_dump_json())
        return

    asyncio.run(_amain(graph, nodes))


if __name__ == "__main__":
    main()
