/** Key bindings, in one place so the help overlay and the handlers cannot drift. */
export interface KeyHelp {
  keys: string;
  what: string;
}

// Only non-printable keys are bound: the composer is always focused, so a
// letter binding would swallow the first character of a message.
export const GLOBAL_KEYS: KeyHelp[] = [
  { keys: "tab / shift-tab", what: "next / previous session" },
  { keys: "ctrl+n / ctrl+p", what: "next / previous session" },
  { keys: "esc", what: "interrupt the orchestrator turn (or close help)" },
  { keys: "ctrl-c", what: "quit (workers keep running)" },
];

export const COMPOSER_KEYS: KeyHelp[] = [
  { keys: "type + enter", what: "message the orchestrator, or steer the selected worker" },
  { keys: "/answer /a ctrl+a", what: "answer the selected worker's question" },
  { keys: "/followup /f ctrl+f", what: "queue a message for the selected worker" },
  { keys: "/stop /s ctrl+x", what: "abort the selected worker" },
  { keys: "/remove /rm ctrl+r", what: "remove the selected worker (worktree, branch, rail row)" },
  { keys: "/help /h ctrl+g", what: "this help" },
  { keys: "/quit /q ctrl+d", what: "quit" },
];

export const COMPLETION_KEYS: KeyHelp[] = [
  { keys: "/ or @", what: "suggestions: commands, workers, repository files" },
  { keys: "tab / enter", what: "accept the highlighted suggestion" },
  { keys: "up / down", what: "move through suggestions, or recall what you sent" },
  { keys: "esc", what: "dismiss the suggestions" },
];

export const APPROVAL_KEYS: KeyHelp[] = [
  { keys: "y", what: "allow once" },
  { keys: "a", what: "allow for this session" },
  { keys: "n", what: "deny (then type a reason)" },
  { keys: "↑/↓ + enter", what: "pick an answer (questions)" },
];

export const HINT = "tab switch · esc interrupt · ctrl+g help · ctrl+d quit";

export function helpText(): string {
  const section = (title: string, rows: KeyHelp[]): string =>
    [title, ...rows.map((r) => `  ${r.keys.padEnd(16)} ${r.what}`)].join("\n");
  return [
    section("Keys", GLOBAL_KEYS),
    "",
    section("Composer", COMPOSER_KEYS),
    "",
    section("Suggestions", COMPLETION_KEYS),
    "",
    section("Approvals", APPROVAL_KEYS),
  ].join("\n");
}
