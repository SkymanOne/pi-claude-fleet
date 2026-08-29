import { Box, Text } from "ink";
import type { OrchestratorLine, OrchestratorLineKind } from "./model.js";

export interface TranscriptProps {
  lines: OrchestratorLine[];
  partial?: string | null;
  maxLines?: number;
}

export function colorFor(kind: OrchestratorLineKind): { color?: string; dimColor?: boolean; bold?: boolean } {
  switch (kind) {
    case "user":
      return { color: "cyan", bold: true };
    case "fleet":
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

export function Transcript({ lines, partial, maxLines = 200 }: TranscriptProps) {
  const shown = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  return (
    <Box flexDirection="column" flexGrow={1}>
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
