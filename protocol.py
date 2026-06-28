"""
LangGraph IDE — Frozen Contract · Python mirror
============================================================================
This file mirrors protocol.ts. Fields, discriminators, and enum values must
match verbatim. The contract round-trip test (test-plan §L1) feeds the same
golden JSON to both sides.

PIN notes (same as protocol.ts): anything marked `# PIN` has a shape that must
be calibrated against a real runtime dump (engineering-design §1).
Depends on: pydantic v2.
"""
from __future__ import annotations

from typing import Annotated, Any, Final, Literal, Union
from pydantic import BaseModel, Field, TypeAdapter

PROTOCOL_VERSION: Final = "0.1.0"

CheckpointId = str
ThreadId = str
RunId = str
# PIN: parallel interrupt id collision (langgraph #6626) -> dedup by node+seq.
# PIN-cal DEFER 2026-06-17: parallel-interrupt behavior on langgraph 1.1.9 not yet
# exercised (no vscode.lm offline); dedup layer lands PHASE 2. See pin_dump.golden.txt.
InterruptId = str
NodeName = str

BoundaryWhen = Literal["before", "after"]
ProviderMode = Literal["copilot", "api", "manual"]
InferenceExpectation = Literal["text", "tool_call"]
TokenSource = Literal["vscode_lm_counttokens", "api_usage", "sidecar_estimate"]


class Envelope(BaseModel):
    v: Literal["0.1.0"] = PROTOCOL_VERSION
    corr: str | None = None


# ---- Token measurement (R3) -----------------------------------------------
class TokenCount(BaseModel):
    prompt: int
    completion: int | None = None
    source: TokenSource


# ---- State (R1/R2) ---------------------------------------------------------
class StateDiffEntry(BaseModel):
    # PIN-cal confirmed 2026-06-17: get_state().values is keyed by channel name
    # (golden: 'messages', 'steps').
    channel: str
    before: Any | None = None
    after: Any | None = None
    op: Literal["add", "update", "remove"]


class StateSnapshot(BaseModel):
    # PIN-cal confirmed 2026-06-17: get_state().values is a dict[str, Any] keyed by
    # channel (pin_dump.golden.txt).
    values: dict[str, Any]
    diff: list[StateDiffEntry] | None = None


# ---- Helpers ---------------------------------------------------------------
class ChatMessage(BaseModel):
    role: Literal["system", "human", "ai", "tool"]
    content: str
    name: str | None = None
    # PIN-cal PENDING 2026-06-17: needs a tool-calling model; offline fake model emits no
    # tool calls. Confirm on PHASE 2 (manual tool_call path / vscode.lm).
    toolCallId: str | None = None


class JsonSchema(BaseModel):
    type: Literal["object"]
    properties: dict[str, dict[str, Any]]
    required: list[str] | None = None


ErrorCode = Literal[
    "consent_denied", "quota_exceeded", "model_unavailable",
    "resume_kind_mismatch", "tool_schema_validation", "interrupt_id_conflict",
    "graph_load_failed", "checkpoint_not_found", "internal",
]


# ============================================================================
# ServerEvent — sidecar -> extension
# ============================================================================
class GraphTopology(Envelope):
    # R1 execution view: get_graph() nodes/edges for the canvas. Added PHASE 1.
    type: Literal["graph"] = "graph"
    threadId: ThreadId | None = None
    nodes: list[NodeName]
    edges: list[tuple[NodeName, NodeName]]
    # JSON Schema of the graph's input (get_input_jsonschema) for the run-input form;
    # None if introspection failed. Added run-input-form.
    inputSchema: dict[str, Any] | None = None
    # Absolute project root the graph was loaded from, so the form can pre-fill
    # path-like inputs (repo_path -> root, out_dir -> root/out). Added ui-design-pass.
    projectRoot: str | None = None
    # First docstring line per node (the node's purpose) for the overview table;
    # None per node if it has no docstring. Added graph-overview-lanes.
    nodeDocs: dict[str, str | None] | None = None
    # Static lane classification per node: "llm" (references a model / calls
    # interrupt) or "script". Best-effort; the webview refines it from runtime
    # llm_start / manual_inference_required events. Added graph-overview-lanes.
    nodeKinds: dict[str, str] | None = None
    # Branch condition per conditional edge, keyed "src->tgt" (e.g. "gate->review":
    # "human"). From get_graph().edges[i].data. Added graph-autolayout.
    edgeLabels: dict[str, str] | None = None


class RunStarted(Envelope):
    type: Literal["run_started"] = "run_started"
    threadId: ThreadId
    runId: RunId
    checkpointId: CheckpointId | None = None


class NodeStart(Envelope):
    type: Literal["node_start"] = "node_start"
    threadId: ThreadId
    runId: RunId
    node: NodeName
    checkpointId: CheckpointId
    ts: float


class NodeEnd(Envelope):
    type: Literal["node_end"] = "node_end"
    threadId: ThreadId
    runId: RunId
    node: NodeName
    checkpointId: CheckpointId
    durationMs: float
    diff: list[StateDiffEntry] | None = None


class LlmStart(Envelope):
    type: Literal["llm_start"] = "llm_start"
    threadId: ThreadId
    runId: RunId
    node: NodeName
    llmEventId: str
    # PIN-cal confirmed 2026-06-17: on_chat_model_start.metadata carries
    # ls_model_type / ls_provider (pin_dump.golden.txt).
    model: str | None = None
    promptTokens: TokenCount | None = None
    # The actual prompt text sent to the model (clipped). Added llm-prompt-view.
    promptText: str | None = None


class LlmToken(Envelope):
    type: Literal["llm_token"] = "llm_token"
    llmEventId: str
    delta: str


class LlmEnd(Envelope):
    type: Literal["llm_end"] = "llm_end"
    llmEventId: str
    tokens: TokenCount | None = None
    finishReason: str | None = None
    # The model's response text (clipped). Added llm-prompt-view.
    completionText: str | None = None


class ToolStart(Envelope):
    type: Literal["tool_start"] = "tool_start"
    threadId: ThreadId
    runId: RunId
    node: NodeName
    toolEventId: str
    name: str
    args: dict[str, Any]


class ToolEnd(Envelope):
    type: Literal["tool_end"] = "tool_end"
    toolEventId: str
    ok: bool
    result: Any | None = None
    error: str | None = None


class ManualInferenceRequired(Envelope):
    """R4 differentiator. expects + toolSchema = the contract answer to open question #2."""
    type: Literal["manual_inference_required"] = "manual_inference_required"
    threadId: ThreadId
    runId: RunId
    node: NodeName
    interruptId: InterruptId
    renderedText: str
    messages: list[ChatMessage]
    expects: InferenceExpectation
    toolSchema: JsonSchema | None = None
    promptTokens: TokenCount


class BreakpointHit(Envelope):
    type: Literal["breakpoint_hit"] = "breakpoint_hit"
    threadId: ThreadId
    runId: RunId
    node: NodeName
    when: BoundaryWhen
    checkpointId: CheckpointId


class StateSnapshotEvent(Envelope):
    type: Literal["state_snapshot"] = "state_snapshot"
    threadId: ThreadId
    checkpointId: CheckpointId
    snapshot: StateSnapshot


class RunFinished(Envelope):
    type: Literal["run_finished"] = "run_finished"
    threadId: ThreadId
    runId: RunId
    status: Literal["completed", "interrupted", "error", "aborted"]
    checkpointId: CheckpointId | None = None


class ErrorEvent(Envelope):
    type: Literal["error"] = "error"
    code: ErrorCode
    message: str
    detail: Any | None = None
    node: NodeName | None = None
    runId: RunId | None = None


ServerEvent = Annotated[
    Union[
        GraphTopology, RunStarted, NodeStart, NodeEnd, LlmStart, LlmToken, LlmEnd,
        ToolStart, ToolEnd, ManualInferenceRequired, BreakpointHit,
        StateSnapshotEvent, RunFinished, ErrorEvent,
    ],
    Field(discriminator="type"),
]


# ============================================================================
# ClientCommand — extension -> sidecar
# ============================================================================
class StartRun(Envelope):
    type: Literal["start_run"] = "start_run"
    threadId: ThreadId | None = None
    input: dict[str, Any]
    providerMode: ProviderMode


class ResumeText(BaseModel):
    kind: Literal["text"] = "text"
    text: str


class ResumeToolCall(BaseModel):
    kind: Literal["tool_call"] = "tool_call"
    name: str
    args: dict[str, Any]


ResumePayload = Annotated[Union[ResumeText, ResumeToolCall], Field(discriminator="kind")]


class Resume(Envelope):
    type: Literal["resume"] = "resume"
    threadId: ThreadId
    interruptId: InterruptId
    payload: ResumePayload


class SetBreakpoint(Envelope):
    type: Literal["set_breakpoint"] = "set_breakpoint"
    node: NodeName
    when: BoundaryWhen


class ClearBreakpoint(Envelope):
    type: Literal["clear_breakpoint"] = "clear_breakpoint"
    node: NodeName
    when: BoundaryWhen


class Step(Envelope):
    type: Literal["step"] = "step"
    threadId: ThreadId
    runId: RunId


class Fork(Envelope):
    type: Literal["fork"] = "fork"
    threadId: ThreadId
    checkpointId: CheckpointId
    stateOverride: dict[str, Any] | None = None


class GetState(Envelope):
    type: Literal["get_state"] = "get_state"
    threadId: ThreadId
    checkpointId: CheckpointId | None = None


class Cancel(Envelope):
    type: Literal["cancel"] = "cancel"
    threadId: ThreadId
    runId: RunId


ClientCommand = Annotated[
    Union[
        StartRun, Resume, SetBreakpoint, ClearBreakpoint,
        Step, Fork, GetState, Cancel,
    ],
    Field(discriminator="type"),
]


# Runtime parse helpers (Python-only; the TS mirror uses zod discriminated unions).
ServerEventAdapter: TypeAdapter[ServerEvent] = TypeAdapter(ServerEvent)
ClientCommandAdapter: TypeAdapter[ClientCommand] = TypeAdapter(ClientCommand)
