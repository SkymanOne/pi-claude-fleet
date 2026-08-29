import { Text } from "ink";
import { HINT } from "./keys.js";

export interface StatusLineProps {
  model: string | null;
  sessionId: string | null;
  costUsd: number;
  numTurns: number;
  pendingApprovals: number;
  turnActive: boolean;
  hint?: string;
}

export function statusText(p: StatusLineProps): string {
  const parts = [
    p.model ?? "starting…",
    p.sessionId ? p.sessionId.slice(0, 8) : "no session",
    `$${p.costUsd.toFixed(3)}`,
    `${p.numTurns} turn${p.numTurns === 1 ? "" : "s"}`,
  ];
  if (p.turnActive) parts.push("working");
  if (p.pendingApprovals > 0) parts.push(`${p.pendingApprovals} approval${p.pendingApprovals === 1 ? "" : "s"} pending`);
  parts.push(p.hint ?? HINT);
  return parts.join(" · ");
}

export function StatusLine(props: StatusLineProps) {
  return <Text dimColor={props.pendingApprovals === 0}>{statusText(props)}</Text>;
}
