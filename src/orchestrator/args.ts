import { FLEET_TOOLS_ALLOW_PATTERN } from "./mcpConfig.js";

/** `PI_FLEET_CLAUDE_BIN` is an executable spec split on spaces ("node /path/fake-claude.mjs"). */
export function claudeCommand(env: NodeJS.ProcessEnv = process.env): { bin: string; prefix: string[] } {
  const [bin, ...prefix] = (env.PI_FLEET_CLAUDE_BIN || "claude").split(" ");
  return { bin, prefix };
}

/** Pre-approved: every fleet tool, and read-only git. Everything else prompts in the TUI. */
export const DEFAULT_ALLOWED_TOOLS = [
  FLEET_TOOLS_ALLOW_PATTERN,
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git status *)",
  "Bash(git branch *)",
  "Bash(git show *)",
];

/** The orchestrator coordinates; it never edits. */
export const DEFAULT_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"];

export interface ClaudeArgsOptions {
  /** Rendered orchestrator prompt, handed to --append-system-prompt-file. */
  promptFile: string;
  /** JSON document for --mcp-config (see fleetMcpConfig). */
  mcpConfigJson: string;
  model?: string;
  effort?: string;
  resumeSessionId?: string | null;
  maxBudgetUsd?: number | null;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/** The exact argv for the orchestrator child (`claude` itself is the command). */
export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--permission-prompt-tool", "stdio",
    "--append-system-prompt-file", o.promptFile,
    "--mcp-config", o.mcpConfigJson,
    "--strict-mcp-config",
  ];
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);
  if (o.maxBudgetUsd && o.maxBudgetUsd > 0) args.push("--max-budget-usd", String(o.maxBudgetUsd));
  // variadic lists go last so they cannot swallow a following option's value
  const disallowed = o.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
  if (disallowed.length > 0) args.push("--disallowedTools", ...disallowed);
  const allowed = o.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  if (allowed.length > 0) args.push("--allowedTools", ...allowed);
  return args;
}
