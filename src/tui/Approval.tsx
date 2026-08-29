import { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import type { PermissionRequest } from "../orchestrator/process.js";
import { isAskUserQuestion, type PermissionUpdate, type AskUserQuestionAnswers } from "../orchestrator/protocol.js";

export interface AskQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface ApprovalProps {
  request: PermissionRequest;
  onAllow: (updatedPermissions?: PermissionUpdate[]) => void;
  onDeny: (reason: string) => void;
  onAnswer: (answers: AskUserQuestionAnswers) => void;
  /** Extra requests waiting behind this one. */
  queued?: number;
}

/** Sentinel for the "write your own" row; a label could never collide with it. */
const CUSTOM = "\u0000custom";

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function summarizeInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input, null, 0) ?? "";
  return clip(json, 300);
}

export function questionsOf(request: PermissionRequest): AskQuestion[] {
  const questions = (request.request.input as { questions?: AskQuestion[] }).questions;
  return Array.isArray(questions) ? questions : [];
}

/** The permission prompt / question overlay: everything Claude Code would ask in a terminal. */
export function Approval({ request, onAllow, onDeny, onAnswer, queued = 0 }: ApprovalProps) {
  const isQuestion = isAskUserQuestion(request.request);
  const questions = isQuestion ? questionsOf(request) : [];
  const [answers, setAnswers] = useState<AskUserQuestionAnswers>({});
  const [index, setIndex] = useState(0);
  const [denying, setDenying] = useState(false);
  const [custom, setCustom] = useState(false);
  const [reason, setReason] = useState("");

  useInput(
    (input) => {
      if (input === "y") onAllow();
      else if (input === "a") onAllow(request.request.permission_suggestions);
      else if (input === "n") setDenying(true);
    },
    { isActive: !isQuestion && !denying },
  );

  const header = (
    <Text bold color="yellow">
      {request.request.title ?? request.request.display_name ?? request.request.tool_name}
      {queued > 0 ? ` (+${queued} waiting)` : ""}
    </Text>
  );

  if (isQuestion && questions.length > 0) {
    const current = questions[Math.min(index, questions.length - 1)];
    const answer = (value: string): void => {
      const next = { ...answers, [current.question]: value };
      setAnswers(next);
      setReason("");
      setCustom(false);
      if (index + 1 < questions.length) setIndex(index + 1);
      else onAnswer(next);
    };
    // an option list is a suggestion, not a menu: there is always a way to say
    // something the model did not think of
    const items = [
      ...(current.options ?? []).map((o, i) => ({ key: String(i), label: o.label, value: o.label })),
      { key: "__own__", label: "✎ something else…", value: CUSTOM },
    ];
    const typing = custom || items.length === 1;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        {header}
        <Text>{current.question}</Text>
        {typing ? (
          <Box>
            <Text color="cyan">{"answer > "}</Text>
            <TextInput value={reason} onChange={setReason} onSubmit={(value) => answer(value.trim())} />
          </Box>
        ) : (
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (String(item.value) === CUSTOM) setCustom(true);
              else answer(String(item.value));
            }}
          />
        )}
        <Text dimColor>
          {`question ${Math.min(index + 1, questions.length)}/${questions.length} · ${typing ? "type your answer and press enter" : "↑/↓ + enter, or pick “something else” to write your own"}`}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      {header}
      <Text dimColor>{`${request.request.tool_name} ${summarizeInput(request.request.input)}`}</Text>
      {request.request.description ? <Text dimColor>{clip(request.request.description, 200)}</Text> : null}
      {request.request.decision_reason ? <Text color="red">{clip(request.request.decision_reason, 200)}</Text> : null}
      {denying ? (
        <Box>
          <Text color="cyan">{"deny because > "}</Text>
          <TextInput value={reason} onChange={setReason} onSubmit={(value) => onDeny(value.trim() || "denied by the user")} />
        </Box>
      ) : (
        <Text dimColor>
          y allow once · a allow for this session
          {request.request.suppress_always_allow_rule ? " (not offered)" : ""} · n deny
        </Text>
      )}
    </Box>
  );
}
