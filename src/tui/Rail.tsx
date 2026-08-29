import { Box, Text } from "ink";
import type { RailItem } from "./model.js";

export interface RailProps {
  items: RailItem[];
  selectedIndex: number;
  width?: number;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function Rail({ items, selectedIndex, width = 22 }: RailProps) {
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {items.map((item, i) => {
        const selected = i === selectedIndex;
        return (
          <Text key={item.key} inverse={selected} color={item.attention ? "yellow" : undefined}>
            {`${item.glyph} ${clip(item.name, width - 4)}`}
          </Text>
        );
      })}
      {items.length > 0 ? <Text dimColor>{clip(items[selectedIndex]?.detail ?? "", width - 1)}</Text> : null}
    </Box>
  );
}
