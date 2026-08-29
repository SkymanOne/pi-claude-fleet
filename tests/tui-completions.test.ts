import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  completionsFor,
  applySuggestion,
  activeToken,
  rank,
  listRepoFiles,
  resolveCommand,
  COMMANDS,
  SHORTCUTS,
  MAX_SUGGESTIONS,
} from "../src/tui/completions.js";
import { initRepo, tmpDir } from "./helpers.js";

const ctx = (over: Partial<Parameters<typeof completionsFor>[1]> = {}) => ({
  target: "worker" as const,
  workers: [{ name: "add-auth", detail: "running" }, { name: "db", detail: "blocked" }],
  files: ["src/cli.ts", "src/tui/App.tsx", "README.md"],
  ...over,
});

test("activeToken finds the token the cursor is at the end of", () => {
  assert.deepEqual(activeToken(""), { token: "", start: 0 });
  assert.deepEqual(activeToken("/ans"), { token: "/ans", start: 0 });
  assert.deepEqual(activeToken("look at @src/c"), { token: "@src/c", start: 8 });
  assert.deepEqual(activeToken("trailing space "), { token: "", start: 15 });
});

test("rank puts prefix matches before substring matches", () => {
  assert.deepEqual(rank(["ab", "cab", "abc"], "ab", (s) => s), ["ab", "abc", "cab"]);
  assert.deepEqual(rank(["x", "y"], "", (s) => s), ["x", "y"]);
  assert.deepEqual(rank(["Foo"], "foo", (s) => s), ["Foo"]);
});

test("slash commands complete, and worker-only ones are hidden from the orchestrator", () => {
  const all = completionsFor("/", ctx())!;
  assert.deepEqual(all.items.map((i) => i.label), ["/answer", "/followup", "/stop", "/remove", "/help", "/quit"]);
  assert.equal(all.start, 0);
  assert.ok(all.items[0].detail?.includes("ctrl+a"), "the shortcut is advertised");

  const orchestrator = completionsFor("/", ctx({ target: "orchestrator" }))!;
  assert.deepEqual(orchestrator.items.map((i) => i.label), ["/help", "/quit"]);

  const filtered = completionsFor("/an", ctx())!;
  assert.deepEqual(filtered.items.map((i) => i.label), ["/answer"]);
  assert.equal(filtered.items[0].value, "/answer ", "commands that take an argument leave the cursor after a space");
  assert.equal(completionsFor("/stop", ctx())!.items[0].value, "/stop", "commands that take none do not");

  assert.equal(completionsFor("/zzz", ctx()), null);
  assert.equal(completionsFor("not a command", ctx()), null);
  assert.equal(completionsFor("say /answer inside a sentence", ctx()), null, "only at the start of the line");
});

test("@ completes workers first, then repository files", () => {
  const at = completionsFor("@", ctx())!;
  assert.deepEqual(at.items.map((i) => i.label), ["@add-auth", "@db", "@src/cli.ts", "@src/tui/App.tsx", "@README.md"]);
  assert.deepEqual(at.items.map((i) => i.kind), ["worker", "worker", "file", "file", "file"]);
  assert.equal(at.items[0].detail, "running");

  const files = completionsFor("look at @src/t", ctx())!;
  assert.deepEqual(files.items.map((i) => i.label), ["@src/tui/App.tsx"]);
  assert.equal(files.start, 8);
  assert.equal(applySuggestion("look at @src/t", files, files.items[0]), "look at @src/tui/App.tsx");

  const worker = completionsFor("@d", ctx())!;
  assert.equal(worker.items[0].label, "@db", "prefix matches come first");
  assert.deepEqual(worker.items.map((i) => i.label), ["@db", "@add-auth", "@README.md"], "then substring matches");
  assert.equal(applySuggestion("@d", worker, worker.items[0]), "@db");
  assert.equal(completionsFor("@nomatch", ctx()), null);
});

test("the list is capped", () => {
  const many = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`);
  const capped = completionsFor("@src", ctx({ files: many, workers: [] }))!;
  assert.equal(capped.items.length, MAX_SUGGESTIONS);
});

test("every command has a distinct ctrl shortcut", () => {
  const shortcuts = COMMANDS.map((c) => c.shortcut);
  assert.equal(shortcuts.filter(Boolean).length, COMMANDS.length, "all commands have one");
  assert.equal(new Set(shortcuts).size, shortcuts.length, "no duplicates");
  for (const s of shortcuts) assert.match(s!, /^ctrl\+[a-z]$/);
  // ctrl+c is the terminal's own, and these are flow control / signals
  for (const reserved of ["c", "s", "q", "z", "h", "i", "j", "m"]) {
    assert.equal(reserved in SHORTCUTS, false, `ctrl+${reserved} is left to the terminal`);
  }
  assert.equal(SHORTCUTS.r.name, "/remove");
  assert.equal(SHORTCUTS.a.takesArgument, true);
});

test("commands answer to short aliases, and completing one offers the long form", () => {
  assert.equal(resolveCommand("/q")!.name, "/quit");
  assert.equal(resolveCommand("/h")!.name, "/help");
  assert.equal(resolveCommand("/?")!.name, "/help");
  assert.equal(resolveCommand("/rm")!.name, "/remove");
  assert.equal(resolveCommand("/r")!.name, "/remove");
  assert.equal(resolveCommand("/a")!.name, "/answer");
  assert.equal(resolveCommand("/QUIT")!.name, "/quit", "case does not matter");
  assert.equal(resolveCommand("/nope"), null);
  assert.equal(resolveCommand("quit"), null, "the slash is part of it");

  const aliases = COMMANDS.flatMap((c) => c.aliases ?? []);
  assert.equal(new Set(aliases).size, aliases.length, "aliases are unique");
  for (const alias of aliases) assert.match(alias, /^\/[a-z?]{1,2}$/);

  const q = completionsFor("/q", ctx())!;
  assert.deepEqual(q.items.map((i) => i.label), ["/quit"]);
  assert.equal(q.items[0].value, "/quit");
  assert.match(q.items[0].detail!, /\(\/q, ctrl\+d\)/);
  assert.deepEqual(completionsFor("/rm", ctx())!.items.map((i) => i.label), ["/remove"]);
});

test("listRepoFiles uses git when there is a repo, and walks the tree otherwise", async () => {
  const repo = initRepo("pf-files-", { "a.txt": "a\n", "b.md": "b\n" });
  fs.mkdirSync(path.join(repo, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "junk", "x.js"), "x");
  fs.writeFileSync(path.join(repo, "untracked.ts"), "u");
  const tracked = await listRepoFiles(fs.realpathSync(repo));
  assert.ok(tracked.includes("a.txt") && tracked.includes("b.md"));
  assert.ok(tracked.includes("untracked.ts"), "untracked but not ignored files are useful too");
  assert.equal(tracked.some((f) => f.includes("node_modules")), false, "node_modules is dropped even without a .gitignore");

  const plain = tmpDir("pf-files-plain-");
  fs.mkdirSync(path.join(plain, "sub"), { recursive: true });
  fs.writeFileSync(path.join(plain, "sub", "deep.txt"), "d");
  fs.mkdirSync(path.join(plain, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(plain, "node_modules", "skip.js"), "s");
  const walked = await listRepoFiles(fs.realpathSync(plain));
  assert.deepEqual(walked, ["sub/deep.txt"]);
  execFileSync("true");
}, { timeout: 30_000 });
