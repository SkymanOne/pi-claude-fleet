import { Box, Text } from "ink";
import type { RailItem } from "./model.js";

export interface RailProps {
  items: RailItem[];
  selectedIndex: number;
  width?: number;
}

const clip = (s: string, n: number): string =>
  n <= 1
    ? s.slice(0, Math.max(0, n))
    : s.length > n
      ? `${s.slice(0, n - 1)}…`
      : s;

/**
 * `▸● add-auth        2m` — the age is always shown; a long name is clipped to
 * make room for it, since how long a worker has been going is the point.
 */
export function nameLine(
  glyph: string,
  name: string,
  age: string,
  selected: boolean,
  width: number,
): string {
  const prefix = `${selected ? "▸" : " "}${glyph} `;
  if (!age) return `${prefix}${clip(name, Math.max(1, width - prefix.length))}`;
  const room = Math.max(1, width - prefix.length - age.length - 1);
  const shown = clip(name, room);
  const gap = Math.max(1, width - prefix.length - shown.length - age.length);
  return `${prefix}${shown}${" ".repeat(gap)}${age}`;
}

/**
 * Sessions down the left: the orchestrator first, then every worker, each with
 * what it is doing underneath. The selected row is marked and inverted so it
 * reads as selected even where the terminal's inverse is subtle.
 */
export function Rail({ items, selectedIndex, width = 26 }: RailProps) {
  // At full width the age would sit a hundred columns from the name, so the
  // name line keeps a readable width and only the detail uses the whole row.
  const nameWidth = Math.min(width, 60);
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
              color={
                item.attention ? "yellow" : isOrchestrator ? "cyan" : undefined
              }
            >
              {nameLine(item.glyph, item.name, item.age, selected, nameWidth)}
            </Text>
            <Text
              dimColor
            >{`   ${clip(item.detail, Math.max(4, width - 3))}`}</Text>
            {isOrchestrator && items.length > 1 ? (
              <Text dimColor>{"─".repeat(Math.max(4, nameWidth - 1))}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
