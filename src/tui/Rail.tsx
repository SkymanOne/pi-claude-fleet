import { Box, Text } from "ink";
import type { RailItem } from "./model.js";

export interface RailProps {
  items: RailItem[];
  selectedIndex: number;
  width?: number;
}

const clip = (s: string, n: number): string => (n <= 1 ? s.slice(0, Math.max(0, n)) : s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `▸● add-auth        2m` — the age is right-aligned when there is room for it. */
export function nameLine(glyph: string, name: string, age: string, selected: boolean, width: number, nameWidth: number): string {
  const head = `${selected ? "▸" : " "}${glyph} ${clip(name, nameWidth)}`;
  if (!age) return head;
  const gap = width - head.length - age.length;
  return gap >= 1 ? `${head}${" ".repeat(gap)}${age}` : head;
}

/**
 * Sessions down the left: the orchestrator first, then every worker, each with
 * what it is doing underneath. The selected row is marked and inverted so it
 * reads as selected even where the terminal's inverse is subtle.
 */
export function Rail({ items, selectedIndex, width = 26 }: RailProps) {
  const nameWidth = Math.max(4, width - 4);
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const selected = i === selectedIndex;
        const isOrchestrator = item.target.kind === "orchestrator";
        return (
          <Box flexDirection="column" key={item.key}>
            {isOrchestrator ? null : null}
            <Text
              inverse={selected}
              bold={selected || isOrchestrator}
              color={item.attention ? "yellow" : isOrchestrator ? "cyan" : undefined}
            >
              {nameLine(item.glyph, item.name, item.age, selected, width, nameWidth)}
            </Text>
            <Text dimColor>{`   ${clip(item.detail, Math.max(4, width - 3))}`}</Text>
            {isOrchestrator && items.length > 1 ? <Text dimColor>{"─".repeat(Math.max(4, width - 1))}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
