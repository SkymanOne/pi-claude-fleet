import { Box, Text, useInput } from "ink";

export interface ConfirmProps {
  message: string;
  onYes: () => void;
  onNo: () => void;
}

/** A blocking yes/no for anything that would destroy work. */
export function Confirm({ message, onYes, onNo }: ConfirmProps) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") onYes();
    else if (input === "n" || input === "N" || key.escape || key.return) onNo();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text bold color="red">
        {message}
      </Text>
      <Text dimColor>y remove · n or esc cancel</Text>
    </Box>
  );
}
