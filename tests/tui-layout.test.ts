import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsFor, visibleTail, transcriptRows, MIN_TRANSCRIPT_ROWS, CHROME_BASE } from "../src/tui/layout.js";

const line = (text: string) => ({ text });
const texts = (r: { lines: { text: string }[] }) => r.lines.map((l) => l.text);

test("rowsFor counts wrapped rows", () => {
  assert.equal(rowsFor("", 80), 1);
  assert.equal(rowsFor("short", 80), 1);
  assert.equal(rowsFor("x".repeat(80), 80), 1);
  assert.equal(rowsFor("x".repeat(81), 80), 2);
  assert.equal(rowsFor("x".repeat(200), 80), 3);
  assert.equal(rowsFor("anything", 0), 1, "a zero width must not divide by zero");
});

test("visibleTail keeps the newest lines that fit and reports the rest", () => {
  const lines = ["a", "b", "c", "d"].map(line);
  assert.deepEqual(texts(visibleTail(lines, 2, 80, (l) => l.text)), ["c", "d"]);
  assert.equal(visibleTail(lines, 2, 80, (l) => l.text).hidden, 2);
  assert.deepEqual(texts(visibleTail(lines, 10, 80, (l) => l.text)), ["a", "b", "c", "d"]);
  assert.equal(visibleTail(lines, 10, 80, (l) => l.text).hidden, 0);
  assert.deepEqual(visibleTail([], 5, 80, (l: { text: string }) => l.text), { lines: [], hidden: 0 });

  // wrapping costs rows
  const wrapped = [line("x".repeat(160)), line("tail")];
  assert.deepEqual(texts(visibleTail(wrapped, 2, 80, (l) => l.text)), ["tail"]);
  assert.deepEqual(texts(visibleTail(wrapped, 3, 80, (l) => l.text)), ["x".repeat(160), "tail"]);

  // one line taller than the whole budget is still shown rather than a blank pane
  assert.deepEqual(texts(visibleTail([line("y".repeat(500))], 2, 80, (l) => l.text)), ["y".repeat(500)]);
  assert.deepEqual(visibleTail(lines, 0, 80, (l) => l.text), { lines: [], hidden: 4 });
});

test("transcriptRows leaves room for the chrome and never collapses", () => {
  assert.equal(transcriptRows(40), 40 - CHROME_BASE - 1);
  assert.equal(transcriptRows(40, { flash: 1, suggestions: 5 }), 40 - CHROME_BASE - 1 - 6);
  assert.equal(transcriptRows(40, { overlay: 8 }), 40 - CHROME_BASE - 1 - 8);
  assert.equal(transcriptRows(6), MIN_TRANSCRIPT_ROWS, "a tiny terminal still shows something");
  assert.equal(transcriptRows(0), MIN_TRANSCRIPT_ROWS);
});
