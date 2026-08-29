import { Text } from "ink";
import { HINT } from "./keys.js";

export interface SelectedSession {
  kind: "orchestrator" | "worker";
  name: string;
  /** The worker's derived view, or the orchestrator's activity. */
  state: string;
  model: string | null;
  branch?: string | null;
  /** Reasoning level, when the session reports or was told one. */
  thinking?: string | null;
  /** The orchestrator's permission mode, shown when it is not the default. */
  permissionMode?: string | null;
}

export interface StatusLineProps {
  /** Whatever is selected: its model is the one that matters to you right now. */
  session: SelectedSession;
  sessionId: string | null;
  costUsd: number;
  numTurns: number;
  pendingApprovals: number;
  hint?: string;
}

export function statusText(p: StatusLineProps): string {
  const parts: string[] = [];
  if (p.session.kind === "worker") {
    parts.push(p.session.name, p.session.state, p.session.model ?? "default model");
    if (p.session.thinking) parts.push(`thinking ${p.session.thinking}`);
    if (p.session.branch) parts.push(p.session.branch);
  } else {
    parts.push(p.session.model ?? "starting…", p.sessionId ? p.sessionId.slice(0, 8) : "no session");
    parts.push(`$${p.costUsd.toFixed(3)}`, `${p.numTurns} turn${p.numTurns === 1 ? "" : "s"}`);
    if (p.session.thinking) parts.push(`thinking ${p.session.thinking}`);
    // only worth saying when it is not the mode that asks about everything
    if (p.session.permissionMode && p.session.permissionMode !== "default")
      parts.push(`perms ${p.session.permissionMode}`);
    if (p.session.state === "working") parts.push("working");
  }
  if (p.pendingApprovals > 0) parts.push(`${p.pendingApprovals} approval${p.pendingApprovals === 1 ? "" : "s"} pending`);
  parts.push(p.hint ?? HINT);
  return parts.join(" · ");
}

export function StatusLine(props: StatusLineProps) {
  return <Text dimColor={props.pendingApprovals === 0}>{statusText(props)}</Text>;
}
