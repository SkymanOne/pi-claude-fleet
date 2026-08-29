import { Box, Text } from "ink";
import type { OrchestratorLine, OrchestratorLineKind } from "./model.js";
import type { MdLine, Span } from "./markdown.js";
import { visibleTailWithNotice } from "./layout.js";

export interface TranscriptProps {
  lines: OrchestratorLine[];
  partial?: string | null;
  /** Rows the pane may occupy; the tail that fits is shown. */
  maxRows?: number;
  width?: number;
}

export function colorFor(kind: OrchestratorLineKind): { color?: string; dimColor?: boolean; bold?: boolean; italic?: boolean } {
  switch (kind) {
    case "user":
      return { color: "cyan", bold: true };
    case "thinking":
      return { color: "gray", italic: true };
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
    case "table-rule":
      return { dimColor: true };
    case "table-header":
      return { bold: true };
    default:
      return {};
  }
}

function spanStyle(span: Span): { bold?: boolean; italic?: boolean; color?: string; underline?: boolean } {
  return {
    bold: span.bold,
    italic: span.italic,
    underline: span.link,
    color: span.code ? "green" : span.link ? "cyan" : undefined,
  };
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

export function Transcript({ lines, partial, maxRows = 200, width = 80 }: TranscriptProps) {
  const partialRows = partial ? Math.max(1, Math.ceil(partial.length / Math.max(1, width))) : 0;
  const { lines: shown, hidden } = visibleTailWithNotice(lines, Math.max(1, maxRows - partialRows), width, (l) => l.text);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {hidden > 0 ? <Text dimColor>{`… ${hidden} earlier line${hidden === 1 ? "" : "s"}`}</Text> : null}
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
