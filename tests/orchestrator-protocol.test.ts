import { test } from "node:test";
import assert from "node:assert/strict";
import { splitJsonLines } from "../src/util.js";
import {
  userMessage,
  allowResponse,
  denyResponse,
  askUserQuestionResponse,
  interruptRequest,
  setPermissionModeRequest,
  initializeRequest,
  serialize,
  newRequestId,
  parseClaudeLine,
  isSystemInit,
  isCanUseTool,
  isAskUserQuestion,
  isAssistant,
  isUser,
  isResult,
  isStreamEvent,
  textOfAssistant,
  toolUsesOf,
  toolResultsOf,
  userText,
  isReplayedUserMessage,
  textDeltaOf,
  type AssistantMessage,
  type UserMessage,
  type StreamEventMessage,
} from "../src/orchestrator/protocol.js";

test("builders produce the exact stdin shapes", () => {
  assert.deepEqual(userMessage("hi"), {
    type: "user",
    message: { role: "user", content: "hi" },
    parent_tool_use_id: null,
  });
  assert.deepEqual(allowResponse("r1", { command: "ls" }), {
    type: "control_response",
    response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { command: "ls" } } },
  });
  const perms = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow", destination: "session" }];
  assert.deepEqual(allowResponse("r2", { command: "ls" }, perms).response, {
    subtype: "success",
    request_id: "r2",
    response: { behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: perms },
  });
  assert.deepEqual(allowResponse("r3", {}, []).response, {
    subtype: "success",
    request_id: "r3",
    response: { behavior: "allow", updatedInput: {} },
  });
  assert.deepEqual(denyResponse("r4", "no"), {
    type: "control_response",
    response: { subtype: "success", request_id: "r4", response: { behavior: "deny", message: "no" } },
  });
  assert.deepEqual(interruptRequest("i1"), { type: "control_request", request_id: "i1", request: { subtype: "interrupt" } });
  assert.deepEqual(interruptRequest("i2", true).request, { subtype: "interrupt", cancel_queued: true });
  assert.deepEqual(setPermissionModeRequest("p1", "acceptEdits").request, { subtype: "set_permission_mode", mode: "acceptEdits" });
  assert.deepEqual(initializeRequest("n1").request, { subtype: "initialize" });
  assert.deepEqual(initializeRequest("n2", { appendSystemPrompt: "x" }).request, { subtype: "initialize", appendSystemPrompt: "x" });
});

test("AskUserQuestion answers echo the questions and add answers keyed by question text", () => {
  const input = {
    questions: [{ question: "Which style?", header: "Style", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: false }],
  };
  const msg = askUserQuestionResponse("q1", input, { "Which style?": "B" });
  assert.equal(msg.response.subtype, "success");
  const response = (msg.response as { response: Record<string, unknown> }).response;
  assert.equal(response.behavior, "allow");
  assert.deepEqual(response.updatedInput, { ...input, answers: { "Which style?": "B" } });
});

test("serialize emits one JSON line; newRequestId is unique", () => {
  const line = serialize(userMessage("x"));
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1);
  assert.notEqual(newRequestId(), newRequestId());
});

test("parseClaudeLine is tolerant", () => {
  assert.equal(parseClaudeLine("not json"), null);
  assert.equal(parseClaudeLine("[1,2]"), null);
  assert.equal(parseClaudeLine('{"foo":1}'), null);
  assert.deepEqual(parseClaudeLine('{"type":"mystery","x":1}'), { type: "mystery", x: 1 });
});

test("framing: CRLF and split chunks", () => {
  const a = splitJsonLines('{"type":"system","subtype":"init","session_id":"s"}\r\n{"type":"assis', "");
  assert.equal(a.lines.length, 1);
  const msg = parseClaudeLine(a.lines[0]);
  assert.ok(msg && isSystemInit(msg));
  const b = splitJsonLines('tant","message":{"role":"assistant","content":[]},"parent_tool_use_id":null}\n', a.rest);
  assert.equal(b.lines.length, 1);
  assert.ok(isAssistant(parseClaudeLine(b.lines[0])!));
});

test("control requests: can_use_tool and AskUserQuestion detection", () => {
  const req = parseClaudeLine(
    JSON.stringify({
      type: "control_request",
      request_id: "abc",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t1", title: "Run ls" },
    }),
  )!;
  assert.ok(isCanUseTool(req));
  if (isCanUseTool(req)) {
    assert.equal(req.request.tool_name, "Bash");
    assert.equal(isAskUserQuestion(req.request), false);
    assert.equal(isAskUserQuestion({ ...req.request, tool_name: "AskUserQuestion" }), true);
  }
  const other = parseClaudeLine('{"type":"control_request","request_id":"x","request":{"subtype":"hook_callback"}}')!;
  assert.equal(isCanUseTool(other), false);
});

test("assistant helpers: text, tool uses", () => {
  const msg: AssistantMessage = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Hello " },
        { type: "tool_use", id: "t1", name: "mcp__fleet__fleet_status", input: {} },
        { type: "text", text: "world" },
      ],
    },
    parent_tool_use_id: null,
  };
  assert.equal(textOfAssistant(msg), "Hello world");
  assert.deepEqual(toolUsesOf(msg).map((t) => t.name), ["mcp__fleet__fleet_status"]);
});

test("user helpers: replayed text vs tool results", () => {
  const replay: UserMessage = { type: "user", message: { role: "user", content: "hi there" }, parent_tool_use_id: null };
  assert.equal(isReplayedUserMessage(replay), true);
  assert.equal(userText(replay), "hi there");
  const blocks: UserMessage = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    parent_tool_use_id: null,
  };
  assert.equal(userText(blocks), "ab");
  const result: UserMessage = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok\nmore" }], is_error: false }] },
    parent_tool_use_id: null,
  };
  assert.equal(isReplayedUserMessage(result), false);
  assert.equal(userText(result), null);
  assert.deepEqual(toolResultsOf(result), [{ toolUseId: "t1", text: "ok\nmore", isError: false }]);
  const stringResult: UserMessage = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "plain", is_error: true }] },
    parent_tool_use_id: null,
  };
  assert.deepEqual(toolResultsOf(stringResult), [{ toolUseId: "t2", text: "plain", isError: true }]);
  const synthetic: UserMessage = { ...replay, isSynthetic: true };
  assert.equal(isReplayedUserMessage(synthetic), false);
});

test("stream events: text deltas only", () => {
  const delta: StreamEventMessage = {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tok" } },
    parent_tool_use_id: null,
  };
  assert.equal(textDeltaOf(delta), "tok");
  assert.equal(
    textDeltaOf({ ...delta, event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } }),
    null,
  );
  assert.equal(textDeltaOf({ ...delta, event: { type: "message_start" } }), null);
  assert.ok(isStreamEvent(delta));
  const result = parseClaudeLine('{"type":"result","subtype":"success","result":"done","session_id":"s","total_cost_usd":0.01}')!;
  assert.ok(isResult(result));
  assert.ok(isUser(parseClaudeLine('{"type":"user","message":{"role":"user","content":"x"},"parent_tool_use_id":null}')!));
});
