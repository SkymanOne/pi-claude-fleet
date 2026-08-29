import { Box, Text } from "ink";
import type { OrchestratorLine, OrchestratorLineKind } from "./model.js";
import type { MdLine, Span } from "./markdown.js";

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

/** Block-level markdown styling; inline styling rides on each span. */
function mdStyle(md: MdLine["kind"] | undefined): { color?: string; dimColor?: boolean; bold?: boolean } {
  switch (md) {
    case "heading":
      return { bold: true, color: "white" };
    case "code":
      return { color: "green" };
    case "quote":
      return { dimColor: true };
    case "rule":
      return { dimColor: true };
    default:
      return {};
  }
}

function spanStyle(span: Span): { bold?: boolean; italic?: boolean; color?: string } {
  return { bold: span.bold, italic: span.italic, color: span.code ? "green" : undefined };
}

function LineView({ line }: { line: OrchestratorLine }) {
  const base = { ...colorFor(line.kind), ...mdStyle(line.md) };
  if (!line.spans) return <Text {...base}>{line.text}</Text>;
  return (
    <Text {...base}>
      {line.spans.map((span, i) => (
        <Text key={i} {...spanStyle(span)}>
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

export function Transcript({ lines, partial, maxLines = 200 }: TranscriptProps) {
  const shown = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {shown.map((line, i) => (
        <LineView key={i} line={line} />
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
