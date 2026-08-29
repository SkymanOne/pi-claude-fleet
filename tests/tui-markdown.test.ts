import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdownBlock, oneLine, wrapSpans, renderTable } from "../src/tui/markdown.js";

const plain = (spans: { text: string }[]) => spans.map((s) => s.text).join("");

test("inline: bold, italic, code, and text that is none of those", () => {
  assert.deepEqual(parseInline("plain text"), [{ text: "plain text" }]);
  assert.deepEqual(parseInline("a **bold** b"), [{ text: "a " }, { text: "bold", bold: true }, { text: " b" }]);
  assert.deepEqual(parseInline("__also bold__"), [{ text: "also bold", bold: true }]);
  assert.deepEqual(parseInline("an *emphasis* here"), [{ text: "an " }, { text: "emphasis", italic: true }, { text: " here" }]);
  assert.deepEqual(parseInline("run `git status` now"), [{ text: "run " }, { text: "git status", code: true }, { text: " now" }]);
  assert.deepEqual(parseInline("**a** and `b`"), [{ text: "a", bold: true }, { text: " and " }, { text: "b", code: true }]);
  // markers only count at a word boundary, so paths and arithmetic survive
  assert.deepEqual(parseInline("2 * 3 * 4 = 24"), [{ text: "2 * 3 * 4 = 24" }]);
  assert.deepEqual(parseInline("a ** b"), [{ text: "a ** b" }]);
  assert.deepEqual(parseInline("src/tui/*, src/mcp/* — both"), [{ text: "src/tui/*, src/mcp/* — both" }]);
  assert.deepEqual(parseInline("snake_case_word here"), [{ text: "snake_case_word here" }]);
  assert.deepEqual(parseInline("(*parenthesised*)"), [{ text: "(" }, { text: "parenthesised", italic: true }, { text: ")" }]);
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

test("table cells wrap instead of being cut, and columns stay aligned", () => {
  const long = "src/orchestrator/*, src/mcp/* — claude subprocess, stdio MCP server, stream-json parsing";
  const lines = parseMarkdownBlock(`| Run | Slice |\n|---|---|\n| review | ${long} |\n| tui | short |`);
  const table = lines.filter((l) => l.kind === "table" || l.kind === "table-header");
  const text = table.map((l) => l.spans.map((s) => s.text).join(""));

  // every word of the long cell survives somewhere in the rendered rows
  const rendered = text.join(" ").replace(/\s+/g, " ");
  for (const word of long.split(/[\s,]+/)) assert.ok(rendered.includes(word), `lost "${word}"`);
  assert.equal(rendered.includes("…"), false, "nothing is truncated");

  // the long cell spans several rows, and the columns line up on every one
  const widths = new Set(text.map((t) => t.indexOf("│")));
  assert.equal(widths.size, 1, `the separator moved: ${[...widths].join(", ")}`);
  assert.ok(text.length > 3, "the long cell wrapped onto extra lines");
  assert.match(text[2], /^ +│/, "a continuation line leaves the first column blank");
});

test("wrapSpans breaks on words, keeps styling, and never loses a long word", () => {
  const spans = [{ text: "hello brave " }, { text: "world", bold: true }];
  assert.deepEqual(
    wrapSpans(spans, 12).map((l) => l.map((s) => s.text).join("")),
    ["hello brave", "world"],
  );
  assert.equal(wrapSpans(spans, 12)[1][0].bold, true, "styling survives the wrap");
  assert.deepEqual(
    wrapSpans([{ text: "supercalifragilistic" }], 8).map((l) => l.map((s) => s.text).join("")),
    ["supercal", "ifragili", "stic"],
    "a word longer than the column is broken rather than dropped",
  );
  assert.deepEqual(wrapSpans([{ text: "" }], 10), [[{ text: "" }]]);
});

test("renderTable pads ragged rows and rules the header", () => {
  const lines = renderTable([["a", "b"], ["only one"]], true);
  assert.deepEqual(lines.map((l) => l.kind), ["table-header", "table-rule", "table"]);
  const header = lines[0].spans.map((s) => s.text).join("");
  const body = lines[2].spans.map((s) => s.text).join("");
  assert.equal(header.indexOf("│"), body.indexOf("│"), "a missing cell still holds its column");
});
