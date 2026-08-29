/** Key bindings, in one place so the help overlay and the handlers cannot drift. */
export interface KeyHelp {
  keys: string;
  what: string;
}

export const GLOBAL_KEYS: KeyHelp[] = [
  { keys: "tab / shift-tab", what: "next / previous session" },
  { keys: "j / k", what: "next / previous session (empty composer)" },
  { keys: "esc", what: "interrupt the orchestrator's turn" },
  { keys: "?", what: "this help (empty composer)" },
  { keys: "q / ctrl-c", what: "quit (workers keep running)" },
];

export const COMPOSER_KEYS: KeyHelp[] = [
  { keys: "type + enter", what: "message the orchestrator, or steer the selected worker" },
  { keys: "/answer <text>", what: "answer the selected worker's question" },
  { keys: "/followup <text>", what: "queue a message for the selected worker" },
  { keys: "/stop", what: "abort the selected worker" },
  { keys: "/help", what: "this help" },
  { keys: "/quit", what: "quit" },
];

export const APPROVAL_KEYS: KeyHelp[] = [
  { keys: "y", what: "allow once" },
  { keys: "a", what: "allow for this session" },
  { keys: "n", what: "deny (then type a reason)" },
  { keys: "↑/↓ + enter", what: "pick an answer (questions)" },
];

export const HINT = "tab switch · esc interrupt · ? help · q quit";

export function helpText(): string {
  const section = (title: string, rows: KeyHelp[]): string =>
    [title, ...rows.map((r) => `  ${r.keys.padEnd(16)} ${r.what}`)].join("\n");
  return [
    section("Keys", GLOBAL_KEYS),
    "",
    section("Composer", COMPOSER_KEYS),
    "",
    section("Approvals", APPROVAL_KEYS),
  ].join("\n");
}
