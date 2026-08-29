import { Box, Text } from "ink";
import type { Suggestion } from "./completions.js";

export interface SuggestionsProps {
  items: Suggestion[];
  selectedIndex: number;
}

const KIND_COLOR: Record<Suggestion["kind"], string> = {
  command: "cyan",
  worker: "yellow",
  file: "green",
};

export function Suggestions({ items, selectedIndex }: SuggestionsProps) {
  if (items.length === 0) return null;
  const width = Math.max(...items.map((i) => i.label.length));
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={item.value} inverse={i === selectedIndex}>
          <Text color={KIND_COLOR[item.kind]}>{item.label.padEnd(width)}</Text>
          {item.detail ? <Text dimColor>{`  ${item.detail}`}</Text> : null}
        </Text>
      ))}
      <Text dimColor>tab or enter to accept · esc to dismiss</Text>
    </Box>
  );
}
