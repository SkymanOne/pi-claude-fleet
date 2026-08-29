import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdownBlock, oneLine } from "../src/tui/markdown.js";

const plain = (spans: { text: string }[]) => spans.map((s) => s.text).join("");

test("inline: bold, italic, code, and text that is none of those", () => {
  assert.deepEqual(parseInline("plain text"), [{ text: "plain text" }]);
  assert.deepEqual(parseInline("a **bold** b"), [{ text: "a " }, { text: "bold", bold: true }, { text: " b" }]);
  assert.deepEqual(parseInline("__also bold__"), [{ text: "also bold", bold: true }]);
  assert.deepEqual(parseInline("an *emphasis* here"), [{ text: "an " }, { text: "emphasis", italic: true }, { text: " here" }]);
  assert.deepEqual(parseInline("run `git status` now"), [{ text: "run " }, { text: "git status", code: true }, { text: " now" }]);
  assert.deepEqual(parseInline("**a** and `b`"), [{ text: "a", bold: true }, { text: " and " }, { text: "b", code: true }]);
  // unmatched markers stay literal rather than eating the rest of the line
  assert.equal(plain(parseInline("2 * 3 * 4 = 24")), "2 * 3 * 4 = 24");
  assert.equal(plain(parseInline("a ** b")), "a ** b");
});

test("blocks: headings, bullets, numbered items, quotes, rules, fenced code", () => {
  const md = [
    "## Findings (5, no high severity)",
    "",
    "1. **medium** — `commands.ts:346`: cleanup removes the worktree",
    "- a bullet with **bold**",
    "  * nested bullet",
    "> quoted line",
    "---",
    "```ts",
    "const x = 1;",
    "```",
    "Done.",
  ].join("\n");
  const all = parseMarkdownBlock(md);
  // blocks of different kinds are separated by blank lines
  const blanks = all.filter((l) => l.spans.every((sp) => sp.text.trim() === ""));
  assert.ok(blanks.length >= 3, "groups are spaced apart");
  const lines = all.filter((l) => !l.spans.every((sp) => sp.text.trim() === ""));
  assert.deepEqual(lines.map((l) => l.kind), ["heading", "bullet", "bullet", "bullet", "quote", "rule", "code", "text"]);

  const heading = lines[0];
  assert.equal(plain(heading.spans), "Findings (5, no high severity)");
  assert.ok(heading.spans.every((s) => s.bold), "headings are bold all through");

  const numbered = lines[1];
  assert.equal(plain(numbered.spans), "1. medium — commands.ts:346: cleanup removes the worktree");
  assert.deepEqual(numbered.spans[0], { text: "1. " });
  assert.deepEqual(numbered.spans[1], { text: "medium", bold: true });
  assert.ok(numbered.spans.some((s) => s.code && s.text === "commands.ts:346"));

  assert.equal(plain(lines[2].spans), "• a bullet with bold");
  assert.equal(plain(lines[3].spans), "  • nested bullet");
  assert.equal(plain(lines[4].spans), "│ quoted line");
  assert.equal(lines[6].spans[0].code, true, "fenced content is code");
  assert.equal(plain(lines[6].spans), "const x = 1;");
  assert.equal(lines.some((l) => l.spans.some((s) => s.text.includes("```"))), false, "fence markers are not rendered");
  assert.equal(plain(lines[7].spans), "Done.");
});

test("groups are separated, and a run of prose is not", () => {
  const blank = (l: { spans: { text: string }[] }) => l.spans.every((s) => s.text.trim() === "");
  const prose = parseMarkdownBlock("one line\nanother line\na third");
  assert.equal(prose.filter(blank).length, 0, "consecutive prose stays together");

  const mixed = parseMarkdownBlock("Status:\n- a\n- b\nAfter the list.\n## Heading\nUnder it.");
  const kinds = mixed.map((l) => (blank(l) ? "blank" : l.kind));
  assert.deepEqual(kinds, ["text", "blank", "bullet", "bullet", "blank", "text", "blank", "heading", "blank", "text"]);

  const already = parseMarkdownBlock("Status:\n\n- a");
  assert.equal(already.filter(blank).length, 1, "a blank line already there is not doubled");
});

test("markdown inside a fence is left alone", () => {
  const lines = parseMarkdownBlock("```\n# not a heading\n**not bold**\n```");
  assert.deepEqual(lines.map((l) => l.kind), ["code", "code"]);
  assert.equal(plain(lines[0].spans), "# not a heading");
  assert.equal(plain(lines[1].spans), "**not bold**");
});

test("oneLine flattens and bounds runaway tool output", () => {
  assert.equal(oneLine("  a\n b\tc  "), "a b c");
  assert.equal(oneLine(""), "");
  const long = oneLine(JSON.stringify({ lastAssistantText: "x".repeat(5000) }));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
  assert.equal(oneLine("short", 200), "short");
});
