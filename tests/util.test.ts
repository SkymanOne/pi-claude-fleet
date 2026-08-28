import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  splitJsonLines, parseLineSafe, atomicWriteJson, appendJsonLine, readJsonlTail,
  runIdFor, short7, branchFor, firstLine, formatAge, resultTextOf, readNewLines,
} from "../src/util.js";
import { tmpDir } from "./helpers.js";

test("splitJsonLines: strict \\n framing, CRLF tolerated, chunk boundaries", () => {
  const payload = '{"a":"xy"}\n{"b":"c"}\r\n';
  let rest = "";
  const acc: string[] = [];
  for (const chunk of [payload.slice(0, 7), payload.slice(7)]) {
    const r = splitJsonLines(chunk, rest);
    acc.push(...r.lines);
    rest = r.rest;
  }
  assert.deepEqual(acc, ['{"a":"xy"}', '{"b":"c"}']);
  assert.equal(rest, "");
});

test("splitJsonLines: U+2028 inside a string is not a delimiter", () => {
  const r = splitJsonLines('{"a":"x y"}\n', "");
  assert.equal(r.lines.length, 1);
  assert.equal(JSON.parse(r.lines[0]).a, "x y");
});

test("splitJsonLines: keeps incomplete tail as rest", () => {
  const r = splitJsonLines('{"a":1}\n{"b":', "");
  assert.deepEqual(r.lines, ['{"a":1}']);
  assert.equal(r.rest, '{"b":');
});

test("parseLineSafe rejects garbage", () => {
  assert.equal(parseLineSafe("{oops").ok, false);
  assert.deepEqual(parseLineSafe('{"ok":true}'), { ok: true, value: { ok: true } });
});

test("atomicWriteJson leaves no tmp files and round-trips", async () => {
  const dir = tmpDir("pf-util-");
  const p = path.join(dir, "state.json");
  await atomicWriteJson(p, { a: 1 });
  await atomicWriteJson(p, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")), { a: 2 });
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});

test("appendJsonLine + readJsonlTail returns newest-last slice", async () => {
  const p = path.join(tmpDir("pf-util-"), "events.jsonl");
  for (let i = 0; i < 5; i++) await appendJsonLine(p, { i });
  const tail = await readJsonlTail<{ i: number }>(p, 3);
  assert.deepEqual(tail.map((x) => x.i), [2, 3, 4]);
});

test("runIdFor/short7/branchFor produce spec formats (UTC)", () => {
  const id = runIdFor("auth-worker", new Date("2026-08-28T14:15:30Z"));
  assert.equal(id, "auth-worker-20260828141530");
  assert.equal(short7(id), "8141530");
  assert.equal(branchFor("auth-worker", id), "pi-fleet/auth-worker-8141530");
  assert.equal(firstLine("a\nb"), "a");
  assert.equal(firstLine(null), "");
});

test("formatAge renders compact ages", () => {
  assert.equal(formatAge(30_000), "30s");
  assert.equal(formatAge(125 * 60_000), "2h");
  assert.equal(formatAge(5 * 60_000), "5m");
  assert.equal(formatAge(3 * 86_400_000), "3d");
});

test("resultTextOf joins text content and tolerates missing result", () => {
  assert.equal(resultTextOf({ result: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }), "ab");
  assert.equal(resultTextOf({}), "");
});

test("readNewLines advances only past complete lines and re-reads partial tails", () => {
  const p = path.join(tmpDir("pf-util-"), "control.jsonl");
  fs.writeFileSync(p, '{"a":1}\n{"b":');
  const first = readNewLines(p, 0);
  assert.deepEqual(first, { lines: ['{"a":1}'], offset: 8 });
  fs.appendFileSync(p, '"é"}\r\n');
  const second = readNewLines(p, first.offset);
  assert.deepEqual(second.lines, ['{"b":"é"}']);
  assert.equal(second.offset, fs.statSync(p).size);
  assert.deepEqual(readNewLines(p, second.offset), { lines: [], offset: second.offset });
  assert.deepEqual(readNewLines(path.join(p, "missing"), 0), { lines: [], offset: 0 });
});
