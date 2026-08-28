import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { deriveStatus, type RunState } from "../state.js";
import { formatAge } from "../util.js";

export interface RunRow {
  runId: string;
  runDir: string;
  state: RunState;
}

export interface OpenMenuProps {
  runs: RunRow[];
  onSelect: (row: RunRow) => void;
  onQuit: () => void;
  onRefresh: () => void;
  now?: number;
}

const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s.padEnd(n));

export const HEADER = `${pad("NAME", 18)} ${pad("STATE", 9)} ${pad("LAST-ACTIVITY", 24)} ${pad("LAST-TOOL", 10)} ${pad("STEERED", 7)} AGE`;

export function formatRow(row: RunRow, now: number = Date.now()): string {
  const s = row.state;
  return (
    `${pad(s.name, 18)} ${pad(deriveStatus(s), 9)} ${pad(s.lastActivity ?? "-", 24)} ` +
    `${pad(s.lastTool ?? "-", 10)} ${pad(String(s.steerCount), 7)} ${formatAge(Math.max(0, now - Date.parse(s.createdAt)))}`
  );
}

export function OpenMenu({ runs, onSelect, onQuit, onRefresh, now }: OpenMenuProps) {
  useInput((ch) => {
    if (ch === "q") onQuit();
    else if (ch === "r") onRefresh();
  });
  const items = runs.map((r, i) => ({
    key: r.runId,
    label: `${String(i + 1).padStart(2)} ${formatRow(r, now)}`,
    value: String(i),
  }));
  return (
    <Box flexDirection="column">
      <Text bold>
        {"   # "}
        {HEADER}
      </Text>
      {runs.length === 0 ? (
        <Text dimColor>(no runs — spawn one with: pi-fleet spawn &lt;name&gt; -- "&lt;brief&gt;")</Text>
      ) : (
        <SelectInput items={items} onSelect={(item) => onSelect(runs[Number(item.value)])} />
      )}
      <Text dimColor>↑/↓ (or j/k) + Enter to attach · r refresh · q quit</Text>
    </Box>
  );
}
