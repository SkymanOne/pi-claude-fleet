import path from "node:path";
import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { visibleTailWithNotice } from "./layout.js";
import {
  applyEvent,
  partialText,
  readNewEvents,
  replay,
  type LineKind,
  type Transcript as TranscriptState,
  type TranscriptLine,
} from "../console/transcript.js";

export interface WorkerTranscriptProps {
  runDir: string;
  pollMs?: number;
  tailLines?: number;
  /** Rows the pane may occupy; the tail that fits is shown. */
  maxRows?: number;
  width?: number;
}

function colorFor(kind: LineKind): { color?: string; dimColor?: boolean } {
  switch (kind) {
    case "steer":
      return { color: "yellow" };
    case "question":
      return { color: "yellow" };
    case "tool":
      return { color: "blue" };
    case "tool_result":
      return { dimColor: true };
    case "system":
      return { color: "magenta" };
    case "error":
      return { color: "red" };
    default:
      return {};
  }
}

/** Follows one worker's events.jsonl, the way the old attach console did. */
export function WorkerTranscript({ runDir, pollMs = 250, tailLines = 400, maxRows = 200, width = 80 }: WorkerTranscriptProps) {
  const eventsPath = path.join(runDir, "events.jsonl");
  const transcriptRef = useRef<TranscriptState | null>(null);
  const offsetRef = useRef(0);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [partial, setPartial] = useState<string | null>(null);

  useEffect(() => {
    const initial = replay(eventsPath, tailLines);
    transcriptRef.current = initial.transcript;
    offsetRef.current = initial.offset;
    setLines([...initial.transcript.lines]);
    setPartial(partialText(initial.transcript));
    const tick = (): void => {
      const t = transcriptRef.current;
      if (!t) return;
      const { events, offset } = readNewEvents(eventsPath, offsetRef.current);
      offsetRef.current = offset;
      if (events.length === 0) return;
      for (const ev of events) applyEvent(t, ev);
      if (t.lines.length > tailLines) t.lines.splice(0, t.lines.length - tailLines);
      setLines([...t.lines]);
      setPartial(partialText(t));
    };
    const timer = setInterval(tick, pollMs);
    return () => clearInterval(timer);
  }, [eventsPath, pollMs, tailLines]);

  const partialRows = partial ? Math.max(1, Math.ceil(partial.length / Math.max(1, width))) : 0;
  const { lines: shown, hidden } = visibleTailWithNotice(lines, Math.max(1, maxRows - partialRows), width, (l) => l.text);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {lines.length === 0 ? <Text dimColor>(no events captured yet)</Text> : null}
      {hidden > 0 ? <Text dimColor>{`… ${hidden} earlier line${hidden === 1 ? "" : "s"}`}</Text> : null}
      {shown.map((line, i) => (
        <Text key={i} {...colorFor(line.kind)}>
          {line.text}
        </Text>
      ))}
      {partial ? (
        <Text>
          {partial}
          <Text dimColor>▍</Text>
        </Text>
      ) : null}
    </Box>
  );
}
