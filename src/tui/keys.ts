/** Key bindings, in one place so the help overlay and the handlers cannot drift. */
export interface KeyHelp {
 keys: string;
 what: string;
}

// Only non-printable keys are bound: the composer is always focused, so a
// letter binding would swallow the first character of a message.
export const GLOBAL_KEYS: KeyHelp[] = [
 {
  keys: "tab / shift-tab",
  what: "next / previous session (also ctrl+n / ctrl+p)",
 },
 { keys: "esc", what: "interrupt the orchestrator turn, or close this help" },
 { keys: "ctrl-c", what: "quit (workers keep running)" },
];

export const COMPOSER_KEYS: KeyHelp[] = [
 {
  keys: "type + enter",
  what: "message the orchestrator, or steer the selected worker",
 },
 { keys: "/answer /a ctrl+a", what: "answer the selected worker's question" },
 {
  keys: "/followup /f ctrl+f",
  what: "queue a message for the selected worker",
 },
 { keys: "/stop /s ctrl+x", what: "abort the selected worker" },
 {
  keys: "/remove /rm ctrl+r",
  what: "remove the selected worker (worktree, branch, rail row)",
 },
 {
  keys: "/thinking /t ctrl+t",
  what: "set the reasoning level of the selected session",
 },
 {
  keys: "/rail /rw ctrl+b",
  what: "widen or compact the session list: compact, auto, wide, full",
 },
 { keys: "/help /h ctrl+g", what: "this help" },
 { keys: "/quit /q ctrl+d", what: "leave the console; workers keep running" },
 {
  keys: "/shutdown /sd ctrl+k",
  what: "stop the orchestrator and every worker, then exit",
 },
];

export const COMPLETION_KEYS: KeyHelp[] = [
 { keys: "/ or @", what: "commands and skills, or workers and files" },
 {
  keys: "tab / enter",
  what: "accept the highlighted suggestion (esc dismisses)",
 },
 {
  keys: "up / down",
  what: "move through suggestions, or recall what you sent",
 },
];

export const APPROVAL_KEYS: KeyHelp[] = [
 {
  keys: "y / a / n",
  what: "allow once · allow for this session · deny with a reason",
 },
 { keys: "↑/↓ + enter", what: "pick an answer to a question" },
];

export const HINT = "tab switch · esc interrupt · ctrl+g help · ctrl+d quit";

/**
 * Compact on purpose: the help shares the pane with everything else, and a
 * reference that scrolls off the top of a short terminal helps nobody.
 */
export interface HelpSection {
  title: string;
  rows: KeyHelp[];
}

/** The help as sections, so it can be laid out in columns and always fit. */
export function helpSections(): HelpSection[] {
  return [
    { title: "Keys", rows: GLOBAL_KEYS },
    { title: "Composer", rows: COMPOSER_KEYS },
    { title: "Suggestions", rows: COMPLETION_KEYS },
    { title: "Approvals", rows: APPROVAL_KEYS },
  ];
}

export function renderSection(section: HelpSection): string {
  return [`${section.title}:`, ...section.rows.map((r) => `  ${r.keys.padEnd(18)} ${r.what}`)].join("\n");
}

/**
 * The help as lines that fit `width`, capped at `maxRows`. It shares a
 * fixed-height pane and has outgrown it as commands were added, so what does
 * not fit is counted rather than silently cut off the bottom.
 */
export function helpLines(width: number, maxRows: number): string[] {
  const lines = helpSections().flatMap((section, i) => (i === 0 ? [] : [""]).concat(renderSection(section).split("\n")));
  const rows = (line: string): number => Math.max(1, Math.ceil(line.length / Math.max(1, width)));
  const shown: string[] = [];
  let used = 0;
  for (const line of lines) {
    // keep a row for the notice when there is more after this one
    if (used + rows(line) > maxRows - 1 && shown.length < lines.length) break;
    shown.push(line);
    used += rows(line);
  }
  const hidden = lines.length - shown.length;
  if (hidden > 0) shown.push(`… ${hidden} more lines — a taller window shows them all`);
  return shown;
}

export function helpText(): string {
  return helpSections().map(renderSection).join("\n");
}
