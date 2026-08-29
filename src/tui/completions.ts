/**
 * Composer completions: slash commands, `@` mentions of workers and repository
 * files. Pure functions over the current input so the popup is testable without
 * a terminal.
 */
import fs from "node:fs";
import path from "node:path";
import { gitRaw } from "../worktree.js";

export type SuggestionKind = "command" | "agent" | "worker" | "file";

export interface Suggestion {
  /** Text that replaces the token being completed. */
  value: string;
  label: string;
  detail?: string;
  kind: SuggestionKind;
}

export interface CompletionState {
  items: Suggestion[];
  /** Index in the input where the replaced token starts. */
  start: number;
  token: string;
}

export interface CommandSpec {
  name: string;
  detail: string;
  /** Commands that take an argument get a trailing space when accepted. */
  takesArgument?: boolean;
  /** Only offered when a worker is selected. */
  workerOnly?: boolean;
  /**
   * Key that runs it without typing. Only ctrl combinations: the composer always
   * has focus, so a bare letter would swallow the first character of a message.
   */
  shortcut?: string;
  /** Short forms, e.g. `/q` for `/quit`. */
  aliases?: string[];
}

export const COMMANDS: CommandSpec[] = [
  { name: "/answer", detail: "answer the worker's pending question", takesArgument: true, workerOnly: true, shortcut: "ctrl+a", aliases: ["/a"] },
  { name: "/followup", detail: "queue a message for after its current work", takesArgument: true, workerOnly: true, shortcut: "ctrl+f", aliases: ["/f"] },
  { name: "/stop", detail: "abort the worker", workerOnly: true, shortcut: "ctrl+x", aliases: ["/s"] },
  { name: "/remove", detail: "remove the worker: worktree, branch, rail row", workerOnly: true, shortcut: "ctrl+r", aliases: ["/rm", "/r"] },
  { name: "/thinking", detail: "set the reasoning level of the selected session", takesArgument: true, shortcut: "ctrl+t", aliases: ["/t"] },
  { name: "/help", detail: "keys and commands", shortcut: "ctrl+g", aliases: ["/h", "/?"] },
  { name: "/quit", detail: "close the console (workers keep running)", shortcut: "ctrl+d", aliases: ["/q"] },
  { name: "/shutdown", detail: "stop the orchestrator and every worker, then exit", shortcut: "ctrl+k", aliases: ["/sd"] },
];

/** Resolve a typed command word, long form or alias, to its spec. */
export function resolveCommand(word: string): CommandSpec | null {
  const token = word.trim().toLowerCase();
  return COMMANDS.find((c) => c.name === token || c.aliases?.includes(token)) ?? null;
}

/** Everything a command answers to, for matching and for display. */
export function commandForms(spec: CommandSpec): string[] {
  return [spec.name, ...(spec.aliases ?? [])];
}

/** ctrl+<letter> → command, for the key handler. */
export const SHORTCUTS: Record<string, CommandSpec> = Object.fromEntries(
  COMMANDS.filter((c) => c.shortcut).map((c) => [c.shortcut!.replace("ctrl+", ""), c]),
);

/** The whitespace-delimited token the cursor sits at the end of. */
export function activeToken(input: string): { token: string; start: number } {
  const m = /[^\s]*$/.exec(input);
  const token = m ? m[0] : "";
  return { token, start: input.length - token.length };
}

/** Prefix matches first, then substring matches; both case-insensitive. */
export function rank<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query) return items;
  const q = query.toLowerCase();
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const item of items) {
    const value = key(item).toLowerCase();
    // a key can hold several forms ("/quit /q"); a prefix of any of them counts
    if (value.split(" ").some((form) => form.startsWith(q))) prefix.push(item);
    else if (value.includes(q)) contains.push(item);
  }
  return [...prefix, ...contains];
}

/** A command the underlying agent offers: a claude slash command or skill, or a pi command. */
export interface AgentCommandOption {
  name: string;
  description: string;
  /** "skill", "prompt", "extension" for pi; the argument hint for claude. */
  source?: string;
  argumentHint?: string;
}

export interface CompletionContext {
  /** What the composer is aimed at; worker-only commands are hidden otherwise. */
  target: "orchestrator" | "worker";
  workers: { name: string; detail: string }[];
  files: string[];
  /** Commands the selected agent offers, passed through to it verbatim. */
  agentCommands?: AgentCommandOption[];
}

export const MAX_SUGGESTIONS = 8;

/** What to offer for the current input, or null when nothing applies. */
export function completionsFor(input: string, ctx: CompletionContext): CompletionState | null {
  const { token, start } = activeToken(input);

  if (token.startsWith("/") && start === 0) {
    const available = COMMANDS.filter((c) => !c.workerOnly || ctx.target === "worker");
    // match the long form and every alias, so "/q" finds "/quit"
    const items = rank(available, token, (c) => commandForms(c).join(" ")).map<Suggestion>((c) => ({
      value: c.takesArgument ? `${c.name} ` : c.name,
      label: c.name,
      detail: [c.detail, `(${[...(c.aliases ?? []), c.shortcut].filter(Boolean).join(", ")})`].join("  "),
      kind: "command",
    }));
    // then whatever the agent itself offers: claude's slash commands and skills,
    // pi's skills, prompt templates and extension commands
    const agent = ctx.agentCommands ?? [];
    const agentItems = rank(agent, token.slice(1), (c) => c.name).map<Suggestion>((c) => ({
      value: c.argumentHint ? `/${c.name} ` : `/${c.name}`,
      label: `/${c.name}`,
      detail: [c.description, c.argumentHint, c.source ? `[${c.source}]` : ""].filter(Boolean).join("  "),
      kind: "agent",
    }));
    const all = [...items, ...agentItems];
    return all.length > 0 ? { items: all.slice(0, MAX_SUGGESTIONS), start, token } : null;
  }

  if (token.startsWith("@")) {
    const query = token.slice(1);
    const workers = rank(ctx.workers, query, (w) => w.name).map<Suggestion>((w) => ({
      value: `@${w.name}`,
      label: `@${w.name}`,
      detail: w.detail,
      kind: "worker",
    }));
    const files = rank(ctx.files, query, (f) => f).map<Suggestion>((f) => ({ value: `@${f}`, label: `@${f}`, kind: "file" }));
    const items = [...workers, ...files].slice(0, MAX_SUGGESTIONS);
    return items.length > 0 ? { items, start, token } : null;
  }

  return null;
}

/** Put the chosen suggestion into the input in place of the token. */
export function applySuggestion(input: string, state: CompletionState, suggestion: Suggestion): string {
  return input.slice(0, state.start) + suggestion.value;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".pi-fleet", ".next", "build", "coverage"]);
const MAX_FILES = 5000;

function isNoise(file: string): boolean {
  return file.split("/").some((part) => SKIP_DIRS.has(part));
}

/** Repository files for `@` completion: git's list when there is one, else a bounded walk. */
export async function listRepoFiles(cwd: string): Promise<string[]> {
  const tracked = await gitRaw(["ls-files", "--cached", "--others", "--exclude-standard"], cwd);
  if (tracked.code === 0) {
    // a repo without a .gitignore still lists node_modules; nobody wants those
    const files = tracked.stdout.split("\n").filter((l) => l.length > 0 && !isNoise(l));
    if (files.length > 0) return files.slice(0, MAX_FILES);
  }
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (out.length < MAX_FILES) out.push(path.relative(cwd, full));
    }
  };
  walk(cwd, 0);
  return out;
}
