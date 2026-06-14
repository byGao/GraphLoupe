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

from typing import Annotated, Any, Literal, Union
from pydantic import BaseModel, Field

PROTOCOL_VERSION = "0.1.0"

CheckpointId = str
ThreadId = str
RunId = str
InterruptId = str   # PIN: parallel interrupt id collision (langgraph #6626) -> dedup by node+seq
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
    channel: str            # PIN
    before: Any | None = None
    after: Any | None = None
    op: Literal["add", "update", "remove"]


class StateSnapshot(BaseModel):
    values: dict[str, Any]  # PIN: shape of get_state().values
    diff: list[StateDiffEntry] | None = None


# ---- Helpers ---------------------------------------------------------------
class ChatMessage(BaseModel):
    role: Literal["system", "human", "ai", "tool"]
    content: str
    name: str | None = None
    toolCallId: str | None = None   # PIN: BaseMessage reconstruction field


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
    model: str | None = None        # PIN: on_chat_model_start metadata
    promptTokens: TokenCount | None = None


class LlmToken(Envelope):
    type: Literal["llm_token"] = "llm_token"
    llmEventId: str
    delta: str


class LlmEnd(Envelope):
    type: Literal["llm_end"] = "llm_end"
    llmEventId: str
    tokens: TokenCount | None = None
    finishReason: str | None = None


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
    status: Literal["completed", "interrupted", "error"]
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
        RunStarted, NodeStart, NodeEnd, LlmStart, LlmToken, LlmEnd,
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
