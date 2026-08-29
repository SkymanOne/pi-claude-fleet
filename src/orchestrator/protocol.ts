/**
 * The `claude -p --input-format stream-json --output-format stream-json`
 * wire protocol, as far as the fleet needs it: message types on stdout, the
 * user/control messages we write to stdin, and small tolerant parsers.
 *
 * Shapes follow the Claude Code CLI (2.1.x) / Agent SDK type definitions.
 * Unknown message types are passed through, never rejected.
 */
import { parseLineSafe } from "../util.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

export interface SystemInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
  mcp_server_errors?: { name: string; type: string; message: string }[];
  capabilities?: string[];
  permissionMode?: string;
  claude_code_version?: string;
  uuid?: string;
}

export interface SystemApiRetryMessage {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error?: string;
  error_status?: number | null;
  session_id?: string;
}

export interface SystemOtherMessage {
  type: "system";
  subtype: string;
  [k: string]: unknown;
}

export interface AssistantMessage {
  type: "assistant";
  message: { role: "assistant"; content: ContentBlock[]; model?: string; [k: string]: unknown };
  parent_tool_use_id: string | null;
  session_id?: string;
  uuid?: string;
  error?: unknown;
}

export interface UserMessage {
  type: "user";
  message: { role: "user"; content: string | ContentBlock[] };
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  session_id?: string;
  uuid?: string;
}

export interface StreamEventMessage {
  type: "stream_event";
  event: {
    type: string;
    index?: number;
    delta?: { type: string; text?: string; partial_json?: string; thinking?: string };
    content_block?: { type: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  parent_tool_use_id: string | null;
  session_id?: string;
}

export interface ResultMessage {
  type: "result";
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | string;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  session_id: string;
  errors?: string[];
  stop_reason?: string | null;
  permission_denials?: unknown[];
  usage?: unknown;
}

/** Loosely typed: `{type:"addRules", rules:[{toolName, ruleContent}], behavior:"allow", destination:"session"}` and friends. */
export type PermissionUpdate = Record<string, unknown>;

export interface CanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  title?: string;
  display_name?: string;
  description?: string;
  permission_suggestions?: PermissionUpdate[];
  blocked_path?: string;
  decision_reason?: string;
  decision_reason_type?: string;
  agent_id?: string;
  requires_user_interaction?: boolean;
  suppress_always_allow_rule?: boolean;
}

export interface OtherControlRequest {
  subtype: string;
  [k: string]: unknown;
}

export type ControlRequestBody = CanUseToolRequest | OtherControlRequest;

export interface ControlRequestMessage {
  type: "control_request";
  request_id: string;
  request: ControlRequestBody;
}

export interface ControlResponseMessage {
  type: "control_response";
  response:
    | { subtype: "success"; request_id: string; response?: Record<string, unknown> }
    | { subtype: "error"; request_id: string; error: string };
}

export interface ControlCancelRequestMessage {
  type: "control_cancel_request";
  request_id: string;
}

export interface UnknownMessage {
  type: string;
  [k: string]: unknown;
}

export type ClaudeStreamMessage =
  | SystemInitMessage
  | SystemApiRetryMessage
  | SystemOtherMessage
  | AssistantMessage
  | UserMessage
  | StreamEventMessage
  | ResultMessage
  | ControlRequestMessage
  | ControlResponseMessage
  | ControlCancelRequestMessage
  | UnknownMessage;

/** A slash command or skill the agent offers, from the initialize response. */
export interface AgentCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: "deny"; message: string };

// ---------------------------------------------------------------------------
// Builders (what we write to claude's stdin)

/** A user turn (or an async message injected mid-turn). */
export function userMessage(text: string): UserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

export function controlResponse(requestId: string, response: Record<string, unknown>): ControlResponseMessage {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
}

export function allowResponse(
  requestId: string,
  input: Record<string, unknown>,
  updatedPermissions?: PermissionUpdate[],
): ControlResponseMessage {
  const decision: PermissionDecision = { behavior: "allow", updatedInput: input };
  if (updatedPermissions && updatedPermissions.length > 0) decision.updatedPermissions = updatedPermissions;
  return controlResponse(requestId, decision);
}

export function denyResponse(requestId: string, message: string): ControlResponseMessage {
  return controlResponse(requestId, { behavior: "deny", message });
}

export type AskUserQuestionAnswers = Record<string, string | string[]>;

/**
 * AskUserQuestion is answered by allowing the tool with the original
 * `questions` echoed back plus `answers` keyed by question text.
 */
export function askUserQuestionResponse(
  requestId: string,
  input: Record<string, unknown>,
  answers: AskUserQuestionAnswers,
): ControlResponseMessage {
  return allowResponse(requestId, { ...input, answers });
}

export function controlRequest(requestId: string, request: ControlRequestBody): ControlRequestMessage {
  return { type: "control_request", request_id: requestId, request };
}

export function interruptRequest(requestId: string, cancelQueued = false): ControlRequestMessage {
  return controlRequest(requestId, cancelQueued ? { subtype: "interrupt", cancel_queued: true } : { subtype: "interrupt" });
}

export function setPermissionModeRequest(requestId: string, mode: PermissionMode): ControlRequestMessage {
  return controlRequest(requestId, { subtype: "set_permission_mode", mode });
}

/** The SDK's session handshake; every field is optional, so a bare one is valid. */
export function initializeRequest(requestId: string, extra: Record<string, unknown> = {}): ControlRequestMessage {
  return controlRequest(requestId, { subtype: "initialize", ...extra });
}

export function serialize(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

let requestSeq = 0;

export function newRequestId(): string {
  requestSeq += 1;
  return `req_${Date.now().toString(36)}_${requestSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Parsers (what we read from claude's stdout)

/** One stdout line → message, or null when it is not a JSON object with a string `type`. */
export function parseClaudeLine(line: string): ClaudeStreamMessage | null {
  const parsed = parseLineSafe<unknown>(line);
  if (!parsed.ok) return null;
  const v = parsed.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (typeof (v as { type?: unknown }).type !== "string") return null;
  return v as ClaudeStreamMessage;
}

export function isSystemInit(msg: ClaudeStreamMessage): msg is SystemInitMessage {
  return msg.type === "system" && (msg as SystemInitMessage).subtype === "init";
}

export function isControlRequest(msg: ClaudeStreamMessage): msg is ControlRequestMessage {
  return msg.type === "control_request" && typeof (msg as ControlRequestMessage).request_id === "string";
}

export function isCanUseTool(msg: ClaudeStreamMessage): msg is ControlRequestMessage & { request: CanUseToolRequest } {
  return isControlRequest(msg) && msg.request?.subtype === "can_use_tool";
}

export function isAskUserQuestion(req: CanUseToolRequest): boolean {
  return req.tool_name === "AskUserQuestion";
}

export function isAssistant(msg: ClaudeStreamMessage): msg is AssistantMessage {
  return msg.type === "assistant";
}

export function isUser(msg: ClaudeStreamMessage): msg is UserMessage {
  return msg.type === "user";
}

export function isResult(msg: ClaudeStreamMessage): msg is ResultMessage {
  return msg.type === "result";
}

export function isStreamEvent(msg: ClaudeStreamMessage): msg is StreamEventMessage {
  return msg.type === "stream_event";
}

function blocksOf(content: string | ContentBlock[] | undefined): ContentBlock[] {
  return Array.isArray(content) ? content : [];
}

/** Concatenated text blocks of an assistant message. */
export function textOfAssistant(msg: AssistantMessage): string {
  return blocksOf(msg.message?.content)
    .filter((b): b is TextBlock => b.type === "text" && typeof (b as TextBlock).text === "string")
    .map((b) => b.text)
    .join("");
}

export function toolUsesOf(msg: AssistantMessage): ToolUseBlock[] {
  return blocksOf(msg.message?.content).filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export interface ToolResult {
  toolUseId: string;
  text: string;
  isError: boolean;
}

export function toolResultText(block: ToolResultBlock): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map((c) => c.text ?? "").join("");
  return "";
}

export function toolResultsOf(msg: UserMessage): ToolResult[] {
  return blocksOf(msg.message?.content)
    .filter((b): b is ToolResultBlock => b.type === "tool_result")
    .map((b) => ({ toolUseId: b.tool_use_id, text: toolResultText(b), isError: Boolean(b.is_error) }));
}

/** Text of a user message that carries plain text (a replayed turn), or null for tool results. */
export function userText(msg: UserMessage): string | null {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  const blocks = blocksOf(content);
  if (blocks.length === 0 || blocks.some((b) => b.type === "tool_result")) return null;
  return blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
}

/** With --replay-user-messages, claude echoes our own user messages back; those are not tool results. */
export function isReplayedUserMessage(msg: UserMessage): boolean {
  return !msg.isSynthetic && msg.parent_tool_use_id === null && userText(msg) !== null;
}

export function textDeltaOf(msg: StreamEventMessage): string | null {
  const ev = msg.event;
  if (ev?.type !== "content_block_delta") return null;
  if (ev.delta?.type !== "text_delta" || typeof ev.delta.text !== "string") return null;
  return ev.delta.text;
}
