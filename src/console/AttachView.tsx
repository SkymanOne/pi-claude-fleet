import path from "node:path";
import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  deriveStatus,
  loadStateSync,
  resumeHint as resumeCommand,
  TERMINAL_STATES,
  type ControlType,
  type RunState,
} from "../state.js";
import {
  applyEvent,
  partialText,
  readNewEvents,
  replay,
  type LineKind,
  type Transcript,
  type TranscriptLine,
} from "./transcript.js";

export interface AttachViewProps {
  runDir: string;
  writeControl: (type: ControlType, message: string | null) => void;
  onQuit: () => void;
  pollMs?: number;
  tailLines?: number;
}

const isTerminal = (status: string): boolean => (TERMINAL_STATES as readonly string[]).includes(status);

export function resumeHint(state: RunState, runDir: string): string {
  return `resume: ${resumeCommand(state, runDir)}`;
}

function colorFor(kind: LineKind): string | undefined {
  switch (kind) {
    case "steer":
      return "yellow";
    case "tool":
      return "blue";
    case "system":
      return "magenta";
    default:
      return undefined;
  }
}

export function AttachView({ runDir, writeControl, onQuit, pollMs = 250, tailLines = 40 }: AttachViewProps) {
  const eventsPath = path.join(runDir, "events.jsonl");
  const initial = useRef(replay(eventsPath, tailLines));
  const transcriptRef = useRef<Transcript>(initial.current.transcript);
  const offsetRef = useRef<number>(initial.current.offset);
  const [lines, setLines] = useState<TranscriptLine[]>([...initial.current.transcript.lines]);
  const [partial, setPartial] = useState<string | null>(partialText(initial.current.transcript));
  const [state, setState] = useState<RunState>(() => loadStateSync(runDir));
  const [input, setInput] = useState("");

  const publish = () => {
    const t = transcriptRef.current;
    if (t.lines.length > tailLines) t.lines.splice(0, t.lines.length - tailLines);
    setLines([...t.lines]);
    setPartial(partialText(t));
  };

  useEffect(() => {
    const tick = () => {
      const { events, offset } = readNewEvents(eventsPath, offsetRef.current);
      offsetRef.current = offset;
      if (events.length > 0) {
        for (const ev of events) applyEvent(transcriptRef.current, ev);
        publish();
      }
      try {
        setState(loadStateSync(runDir));
      } catch {
        // keep the last known state
      }
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return () => clearInterval(timer);
  }, [eventsPath, runDir, pollMs, tailLines]);

  const status = deriveStatus(state);
  const readOnly = isTerminal(status);

  useInput(
    (ch) => {
      if (ch === "q") onQuit();
    },
    { isActive: readOnly },
  );

  const echo = (text: string) => {
    transcriptRef.current.lines.push({ kind: "system", text });
    publish();
  };

  const submit = (value: string) => {
    const text = value.trim();
    setInput("");
    if (!text) return;
    if (text === "/quit") {
      onQuit();
      return;
    }
    if (text === "/stop") {
      writeControl("abort", null);
      echo("■ abort requested (console)");
      return;
    }
    if (text.startsWith("/followup ")) {
      const message = text.slice("/followup ".length).trim();
      if (message) {
        writeControl("follow_up", message);
        echo(`→ follow-up queued: ${message}`);
      }
      return;
    }
    writeControl("steer", text);
    echo(`→ steer queued: ${text}`);
  };

  return (
    <Box flexDirection="column">
      <Text bold>
        {state.name} · {status} · {state.model ?? "default model"} · {state.branch ?? "no branch"}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} color={colorFor(l.kind)} dimColor={l.kind === "tool_result"}>
          {l.text}
        </Text>
      ))}
      {partial ? (
        <Text>
          {partial}
          <Text dimColor>▍</Text>
        </Text>
      ) : null}
      {readOnly ? (
        <Text dimColor>
          read-only: run is {status} · {resumeHint(state, runDir)} · q to quit
        </Text>
      ) : (
        <>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <TextInput value={input} onChange={setInput} onSubmit={submit} />
          </Box>
          <Text dimColor>type to steer · /followup &lt;msg&gt; · /stop · /quit</Text>
        </>
      )}
    </Box>
  );
}
