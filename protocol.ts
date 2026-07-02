/**
 * LangGraph IDE — Frozen Contract · TypeScript mirror
 * ===========================================================================
 * Mirror of protocol.py. Fields, discriminators and enum values must match
 * verbatim; the L1 round-trip test (test/protocol.l1.test.ts + tests/test_protocol_l1.py)
 * feeds the same golden JSON to both sides. Change one side -> change the other + golden.
 *
 * Runtime validation via zod (the Python side uses pydantic). `# PIN` shapes on the
 * Python side are calibrated against pin_dump.golden.txt.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = "0.1.0" as const;

// Envelope fields shared by every wire message.
const env = { v: z.literal(PROTOCOL_VERSION), corr: z.string().nullable() };

// ---- enums -----------------------------------------------------------------
export const BoundaryWhen = z.enum(["before", "after"]);
export const ProviderMode = z.enum(["copilot", "api", "manual"]);
export const InferenceExpectation = z.enum(["text", "tool_call"]);
export const TokenSource = z.enum(["vscode_lm_counttokens", "api_usage", "sidecar_estimate"]);
export const ErrorCode = z.enum([
  "consent_denied", "quota_exceeded", "model_unavailable",
  "resume_kind_mismatch", "tool_schema_validation", "interrupt_id_conflict",
  "graph_load_failed", "checkpoint_not_found", "internal",
]);

// ---- helpers ---------------------------------------------------------------
export const TokenCount = z.object({
  prompt: z.number().int(),
  completion: z.number().int().nullable(),
  source: TokenSource,
});
export const StateDiffEntry = z.object({
  channel: z.string(),
  before: z.any().nullable(),
  after: z.any().nullable(),
  op: z.enum(["add", "update", "remove"]),
});
export const StateSnapshot = z.object({
  values: z.record(z.any()),
  diff: z.array(StateDiffEntry).nullable(),
});
export const ChatMessage = z.object({
  role: z.enum(["system", "human", "ai", "tool"]),
  content: z.string(),
  name: z.string().nullable(),
  toolCallId: z.string().nullable(),
});
export const JsonSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.record(z.any())),
  required: z.array(z.string()).nullable(),
});
// Where a node's function is defined, for jump-to-source (P1-1). file = absolute path,
// line = 1-based def line.
export const SourceRef = z.object({ file: z.string(), line: z.number().int() });

// ============================================================================
// ServerEvent — sidecar -> extension
// ============================================================================
export const GraphTopology = z.object({
  ...env, type: z.literal("graph"),
  threadId: z.string().nullable(),
  nodes: z.array(z.string()),
  edges: z.array(z.tuple([z.string(), z.string()])),
  inputSchema: z.record(z.any()).nullable(),
  projectRoot: z.string().nullable().default(null),
  nodeDocs: z.record(z.string().nullable()).nullable().default(null),
  nodeKinds: z.record(z.string()).nullable().default(null),
  edgeLabels: z.record(z.string()).nullable().default(null),
  nodeSources: z.record(SourceRef).nullable().default(null),
  hasCheckpointer: z.boolean().nullable().default(null),
  langgraphVersion: z.string().nullable().default(null),
  workerPython: z.string().nullable().default(null),
});
export const RunStarted = z.object({
  ...env, type: z.literal("run_started"),
  threadId: z.string(), runId: z.string(), checkpointId: z.string().nullable(),
});
export const NodeStart = z.object({
  ...env, type: z.literal("node_start"),
  threadId: z.string(), runId: z.string(), node: z.string(), checkpointId: z.string(), ts: z.number(),
});
export const NodeEnd = z.object({
  ...env, type: z.literal("node_end"),
  threadId: z.string(), runId: z.string(), node: z.string(), checkpointId: z.string(),
  durationMs: z.number(), diff: z.array(StateDiffEntry).nullable(),
});
export const LlmStart = z.object({
  ...env, type: z.literal("llm_start"),
  threadId: z.string(), runId: z.string(), node: z.string(), llmEventId: z.string(),
  model: z.string().nullable(), promptTokens: TokenCount.nullable(),
  promptText: z.string().nullable().default(null),
});
export const LlmToken = z.object({
  ...env, type: z.literal("llm_token"), llmEventId: z.string(), delta: z.string(),
});
export const LlmEnd = z.object({
  ...env, type: z.literal("llm_end"), llmEventId: z.string(),
  tokens: TokenCount.nullable(), finishReason: z.string().nullable(),
  completionText: z.string().nullable().default(null),
});
export const ToolStart = z.object({
  ...env, type: z.literal("tool_start"),
  threadId: z.string(), runId: z.string(), node: z.string(), toolEventId: z.string(),
  name: z.string(), args: z.record(z.any()),
});
export const ToolEnd = z.object({
  ...env, type: z.literal("tool_end"), toolEventId: z.string(),
  ok: z.boolean(), result: z.any().nullable(), error: z.string().nullable(),
});
export const ManualInferenceRequired = z.object({
  ...env, type: z.literal("manual_inference_required"),
  threadId: z.string(), runId: z.string(), node: z.string(), interruptId: z.string(),
  renderedText: z.string(), messages: z.array(ChatMessage),
  expects: InferenceExpectation, toolSchema: JsonSchema.nullable(), promptTokens: TokenCount,
});
export const BreakpointHit = z.object({
  ...env, type: z.literal("breakpoint_hit"),
  threadId: z.string(), runId: z.string(), node: z.string(), when: BoundaryWhen, checkpointId: z.string(),
});
export const CheckpointRef = z.object({
  checkpointId: z.string(),
  node: z.string().nullable(),  // next node to run from here ("rewind to before <node>"); null at the end
});
export const StateSnapshotEvent = z.object({
  ...env, type: z.literal("state_snapshot"),
  threadId: z.string(), checkpointId: z.string(), snapshot: StateSnapshot,
});
export const CheckpointHistory = z.object({
  ...env, type: z.literal("checkpoint_history"),
  threadId: z.string(), checkpoints: z.array(CheckpointRef),
});
// One conditional-edge (router) decision, reconstructed from the checkpoint history (P1-3):
// at `source` the router chose `key` -> `target`; `alternatives` is the full {key: target} map.
export const BranchDecision = z.object({
  source: z.string(),
  key: z.string().nullable(),
  target: z.string(),
  alternatives: z.record(z.string()),
  stateValues: z.record(z.any()),
});
export const BranchDecisions = z.object({
  ...env, type: z.literal("branch_decisions"),
  threadId: z.string(), decisions: z.array(BranchDecision),
});
export const RunFinished = z.object({
  ...env, type: z.literal("run_finished"),
  threadId: z.string(), runId: z.string(),
  status: z.enum(["completed", "interrupted", "error", "aborted"]), checkpointId: z.string().nullable(),
});
export const ErrorEvent = z.object({
  ...env, type: z.literal("error"), code: ErrorCode, message: z.string(),
  detail: z.any().nullable(), node: z.string().nullable(), runId: z.string().nullable(),
});

export const ServerEvent = z.discriminatedUnion("type", [
  GraphTopology, RunStarted, NodeStart, NodeEnd, LlmStart, LlmToken, LlmEnd,
  ToolStart, ToolEnd, ManualInferenceRequired, BreakpointHit,
  StateSnapshotEvent, CheckpointHistory, BranchDecisions, RunFinished, ErrorEvent,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

// ============================================================================
// ClientCommand — extension -> sidecar
// ============================================================================
export const StartRun = z.object({
  ...env, type: z.literal("start_run"),
  threadId: z.string().nullable(), input: z.record(z.any()), providerMode: ProviderMode,
});
export const ResumeText = z.object({ kind: z.literal("text"), text: z.string() });
export const ResumeToolCall = z.object({
  kind: z.literal("tool_call"), name: z.string(), args: z.record(z.any()),
});
export const ResumePayload = z.discriminatedUnion("kind", [ResumeText, ResumeToolCall]);
export const Resume = z.object({
  ...env, type: z.literal("resume"), threadId: z.string(), interruptId: z.string(), payload: ResumePayload,
});
export const SetBreakpoint = z.object({
  ...env, type: z.literal("set_breakpoint"), node: z.string(), when: BoundaryWhen,
});
export const ClearBreakpoint = z.object({
  ...env, type: z.literal("clear_breakpoint"), node: z.string(), when: BoundaryWhen,
});
export const Step = z.object({ ...env, type: z.literal("step"), threadId: z.string(), runId: z.string() });
export const Fork = z.object({
  ...env, type: z.literal("fork"), threadId: z.string(), checkpointId: z.string(),
  stateOverride: z.record(z.any()).nullable(),
});
export const GetState = z.object({
  ...env, type: z.literal("get_state"), threadId: z.string(), checkpointId: z.string().nullable(),
});
export const Cancel = z.object({ ...env, type: z.literal("cancel"), threadId: z.string(), runId: z.string() });

export const ClientCommand = z.discriminatedUnion("type", [
  StartRun, Resume, SetBreakpoint, ClearBreakpoint, Step, Fork, GetState, Cancel,
]);
export type ClientCommand = z.infer<typeof ClientCommand>;

export const parseServerEvent = (raw: unknown): ServerEvent => ServerEvent.parse(raw);
export const parseClientCommand = (raw: unknown): ClientCommand => ClientCommand.parse(raw);
