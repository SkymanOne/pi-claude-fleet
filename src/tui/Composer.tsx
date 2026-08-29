import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** What the line will be sent to, e.g. "orchestrator" or "db (blocked)". */
  target: string;
  disabled?: boolean;
  hint?: string;
}

export function Composer({ value, onChange, onSubmit, target, disabled, hint }: ComposerProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{`${target} > `}</Text>
        {disabled ? <Text dimColor>(read-only)</Text> : <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />}
      </Box>
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  );
}
