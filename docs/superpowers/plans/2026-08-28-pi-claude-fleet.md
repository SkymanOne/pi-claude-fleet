# pi-claude-fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `pi-claude-fleet` — a CLI (`pi-fleet`), pi package (report protocol), and Claude Code skill (orchestration loop) that let Claude Code orchestrate headless pi agents with worktree isolation, live console steering, and structured report-back.

**Architecture:** `pi-fleet` manages detached `pi --mode rpc` subprocesses ("workers") from a file-based state dir (`.pi-fleet/` in the target repo). The monitor wrapper captures RPC events, forwards steering from `control.jsonl`, and derives status. Workers write final markdown reports; the Claude Code skill drives the spawn→monitor→report→merge loop.

**Tech Stack:** Node.js >= 22, TypeScript (strict, ESM/NodeNext) compiled with tsc; pnpm; runtime deps commander, simple-git, cli-table3, and ink + react (+ ink-select-input, ink-text-input) for the console; `node:test` via tsx for tests. pi extension in TypeScript (loaded by pi's own jiti loader).

**Spec:** `docs/superpowers/specs/2026-08-28-pi-claude-fleet-design.md` (read it first — this plan implements it section by section)

## Global Constraints

- Node >= 22 (ink 7), **TypeScript** source in `src/` (strict, `NodeNext`, `jsx: react-jsx`), compiled with `tsc` to `dist/` (bin = `dist/cli.js`); tests run via `pnpm test` = `node --import tsx --test "tests/**/*.test.ts"` (Node rejects the bare directory form)
- **pnpm** is the package manager. Runtime deps (lean, established): `commander` (arg parsing), `simple-git` (git operations), `cli-table3` (status tables), `ink` + `react` (+ `ink-select-input`, `ink-text-input`) for the interactive console. No other deps without need
- `pi/` and `claude/` ship as source and sit outside `tsconfig` `include`; `pi/extensions/fleet-report.ts` is loaded by pi's jiti loader and only type-imports `@earendil-works/pi-coding-agent` (not a dependency of this package)
- Dev launcher (`PI_FLEET_DEV=1`, set by tests): the detached monitor runs `node --import <absolute tsx loader> src/cli.ts`; a bare `--import tsx` does not resolve from a cwd outside this package, so `cliSpawnArgs()` resolves the loader via `import.meta.resolve("tsx")`
- All JSONL parsing splits strictly on `\n` only and strips one trailing `\r` (never split on U+2028/U+2029 — they are legal inside JSON strings)
- All `state.json` writes are atomic (write `<file>.tmp-<pid>` then `rename`)
- Exit codes (machine contract for the orchestrator): `0` ok · `1` refusal/general error · `2` no report · `3` wait timeout · `4` wait ended stopped/error/dead · `5` merge conflict
- Run IDs: `<name>-<YYYYMMDDHHMMSS>` (no inner hyphen — refinement over spec §7's `YYYYMMDD-HHMMSS` so that `runId.slice(-7)` is a clean 7-char branch suffix). Branches: `pi-fleet/<name>-<short7>` where `short7 = runId.slice(-7)`
- Fleet state dir: `<fleetDir>/.pi-fleet/` where `fleetDir` = git repo root containing the spawn target, or the target dir itself when not a git repo
- Env contract for workers: `PI_FLEET_RUN=<runId>`, `PI_FLEET_DIR=<fleetDir>/.pi-fleet`
- Test hermeticity hook: monitor launches `process.env.PI_FLEET_PI_BIN || "pi"` — tests always set `PI_FLEET_PI_BIN` to the fake-pi fixture
- Worktree isolation defaults ON (`--no-worktree` opts out); non-git targets warn and run in place
- `status`/`open` hide runs with `status:"archived"` by default
- Every task ends with a green test run and a git commit

## File Structure

```text
pi-claude-fleet/
├── package.json                        # bin dist/cli.js, pi manifest, scripts (build/typecheck/test/test:e2e)
├── tsconfig.json                       # strict, NodeNext, jsx react-jsx, src → dist
├── src/
│   ├── cli.ts                          # commander program: every command + exit codes (hidden __monitor)
│   ├── commands.ts                     # command handlers: spawn/status/wait/output/logs/send/followup/stop/report/diff/merge/cleanup
│   ├── paths.ts                        # SRC_DIR, PACKAGE_ROOT, extension/skill/claude-skill paths
│   ├── util.ts                         # JSONL framing, atomic IO, ids, formatting
│   ├── state.ts                        # state schema, load/save, status derivation, run index, control append
│   ├── worktree.ts                     # git worktree/branch lifecycle (simple-git), gitignore
│   ├── spawn.ts                        # fleet dir resolution, run creation
│   ├── monitor.ts                      # __monitor: owns pi child, events, control watcher
│   ├── report.ts                       # report lookup + steering-log appendix
│   ├── install.ts                      # install-claude-skill symlink logic
│   └── console/
│       ├── transcript.ts               # events.jsonl → display lines (pure) + incremental reader
│       ├── lock.ts                     # console.lock marker (pid, ts) helpers
│       ├── AttachView.tsx              # ink live view + steering input
│       ├── OpenMenu.tsx                # ink run picker
│       └── index.tsx                   # cmdOpen / cmdAttach entry points
├── pi/
│   ├── extensions/fleet-report.ts      # appends the report protocol to the worker system prompt
│   └── skills/fleet-worker-report/SKILL.md
├── claude/skills/pi-orchestrator/
│   ├── SKILL.md
│   └── references/cli.md
├── tests/
│   ├── helpers.ts                      # runCli, initRepo, fakePiEnv, readState, waitFor, …
│   ├── fixtures/fake-pi.mjs            # scripted pi RPC replacement (plain JS)
│   ├── *.test.ts                       # one per task (node:test via tsx)
│   └── e2e.ts                          # real pi: spawn→report→merge→cleanup + console steering
├── README.md
└── docs/superpowers/{specs,plans}/
```

**Task map:** Tasks 1–5 (scaffold, util, state, worktree, spawn — already ported to TypeScript, see Task 5b for tests) → Task 6–7 (monitor + control channel) → Task 8–11 (commands) → Task 12–13 (console) → Task 14 (pi extension/skill) → Task 15 (Claude skill + installer) → Task 16 (real e2e) → Task 17 (README, packaging).

---

### Task 1: Package scaffold + CLI dispatch skeleton

**Files:**

- Create: `package.json`, `bin/pi-fleet.mjs`, `src/cli.mjs`, `.gitignore`
- Test: `tests/cli.test.mjs`

**Interfaces:**

- Consumes: nothing
- Produces: `bin/pi-fleet.mjs` runnable as `node bin/pi-fleet.mjs --help`; `src/cli.mjs` exports `main(argv)` returning a numeric exit code (all later commands plug into its dispatch table `COMMANDS`)

- [ ] **Step 1: Write package.json, bin, and gitignore**

`package.json`:

```json
{
  "name": "pi-claude-fleet",
  "version": "0.1.0",
  "description": "Claude Code orchestrates pi agents: pi-fleet CLI, report protocol, orchestrator skill",
  "keywords": ["pi-package", "pi", "claude-code", "orchestration", "fleet"],
  "license": "MIT",
  "type": "module",
  "bin": { "pi-fleet": "bin/pi-fleet.mjs" },
  "engines": { "node": ">=20" },
  "files": ["bin", "src", "pi", "claude", "README.md"],
  "pi": { "extensions": ["pi/extensions"], "skills": ["pi/skills"] },
  "scripts": { "test": "node --test tests/", "test:e2e": "node tests/e2e.mjs" }
}
```

`bin/pi-fleet.mjs`:

```js
#!/usr/bin/env node
import { main } from "../src/cli.mjs";

const code = await main(process.argv.slice(2));
if (Number.isFinite(code) && code !== 0) process.exit(code);
```

`.gitignore` (repo root):

```text
node_modules/
.pi-fleet/
```

- [ ] **Step 2: Write src/cli.mjs dispatch skeleton**

```js
const USAGE = `pi-fleet — Claude Code ↔ pi fleet orchestration

Usage:
  pi-fleet <command> [options] [-- "<task brief>"]

Commands:
  spawn <name>              Start a pi worker (--help for spawn options)
  status [<name>] [--json]  Fleet table or one run's full state
  wait <name>               Block until a run settles (--timeout <sec>)
  open                      Interactive run menu → attach
  attach <name>             Live chat view + steering console
  send <name>               Steer a running worker (-- "<message>")
  followup <name>           Queue a follow-up (-- "<message>")
  output <name> [--tail n]  Last assistant text / activity trail
  report <name>             Final report + steering log
  diff <name> [--name-only] Worker's git diff vs base
  merge <name> [--no-commit] Merge worker branch into orchestrating checkout
  stop <name>               Abort a running worker
  logs <name> [--tail n]    Tail captured RPC stream
  cleanup <name|all>        Remove worktree+branch, archive run
  install-claude-skill      Link orchestrator skill into ~/.claude/skills
  help                      Show this help`;

const COMMANDS = new Map([
  ["help", () => { console.log(USAGE); return 0; }],
]);

export async function main(argv) {
  const command = argv[0];
  if (!command || !COMMANDS.has(command)) {
    console.log(USAGE);
    return command ? 1 : 0;
  }
  try {
    return await COMMANDS.get(command)(argv.slice(1));
  } catch (err) {
    console.error(`pi-fleet: ${err?.message ?? err}`);
    return 1;
  }
}
```

- [ ] **Step 3: Write failing test**

`tests/cli.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-fleet.mjs");

test("help prints usage and exits 0", async () => {
  const { stdout } = await run(process.execPath, [BIN, "help"]);
  assert.match(stdout, /pi-fleet — Claude Code/);
  assert.match(stdout, /spawn/);
});

test("unknown command exits 1", async () => {
  await assert.rejects(
    run(process.execPath, [BIN, "nope"]),
    (err) => err.code === 1
  );
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cli.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add package.json bin src .gitignore tests/cli.test.mjs
git commit -m "feat: package scaffold and CLI dispatch skeleton"
```

---

### Task 2: util.mjs — JSONL framing, atomic IO, ids, arg parsing

**Files:**

- Create: `src/util.mjs`
- Test: `tests/util.test.mjs`

**Interfaces:**

- Consumes: nothing
- Produces (used by every later task):
  - `splitJsonLines(chunk, prevRest)` → `{ lines: string[], rest: string }`
  - `parseLineSafe(line)` → `{ ok: true, value } | { ok: false }`
  - `atomicWriteJson(filePath, data)`, `appendJsonLine(filePath, obj)`, `appendText(filePath, s)`
  - `readJsonlTail(filePath, n)` → object[] (oldest→newest), `tailText(filePath, nLines)` → string
  - `runIdFor(name, now?)` → `` `${name}-${YYYYMMDDHHMMSS}` `` ; `short7(runId)` → `runId.slice(-7)` ; `branchFor(name, runId)` → `pi-fleet/<name>-<short7>`
  - `firstLine(s)`, `formatAge(ms)`, `nowIso()`
  - `parseCommandArgs(argv, { flags = [], string = [] })` → `{ options, positionals, brief }` where `brief` is everything after a bare `--` (joined by spaces) or `null`

- [ ] **Step 1: Write failing tests**

`tests/util.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  splitJsonLines, parseLineSafe, atomicWriteJson, appendJsonLine,
  readJsonlTail, runIdFor, short7, branchFor, firstLine, formatAge,
  parseCommandArgs,
} from "../src/util.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pf-util-"));
}

test("splitJsonLines: strict \\n framing, CRLF tolerated, unicode separators kept inside strings", () => {
  const payload = '{"a":"xy"}\n{"b":"c"}\r\n';
  let rest = "";
  const acc = [];
  for (const chunk of [payload.slice(0, 7), payload.slice(7)]) {
    const r = splitJsonLines(chunk, rest);
    acc.push(...r.lines);
    rest = r.rest;
  }
  assert.deepEqual(acc, ['{"a":"xy"}', '{"b":"c"}']);
  assert.equal(rest, "");
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
  const dir = tmp();
  const p = path.join(dir, "state.json");
  await atomicWriteJson(p, { a: 1 });
  await atomicWriteJson(p, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")), { a: 2 });
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});

test("appendJsonLine + readJsonlTail returns newest-last slice", async () => {
  const dir = tmp();
  const p = path.join(dir, "events.jsonl");
  for (let i = 0; i < 5; i++) await appendJsonLine(p, { i });
  const tail = await readJsonlTail(p, 3);
  assert.deepEqual(tail.map((x) => x.i), [2, 3, 4]);
});

test("runIdFor/short7/branchFor produce spec formats", () => {
  const id = runIdFor("auth-worker", new Date("2026-08-28T14:15:30"));
  assert.equal(id, "auth-worker-20260828141530");
  assert.equal(short7(id), "28141530".slice(-7));
  assert.equal(branchFor("auth-worker", id), "pi-fleet/auth-worker-28141530".slice(0, -6) + id.slice(-7));
  assert.equal(firstLine("a\nb"), "a");
});

test("formatAge renders compact ages", () => {
  assert.equal(formatAge(30_000), "30s");
  assert.equal(formatAge(125 * 60_000), "2m");
  assert.equal(formatAge(3 * 3_600_000), "3h");
});

test("parseCommandArgs: options, flags, brief after --", () => {
  const r = parseCommandArgs(
    ["auth", "--cwd", ".", "--json", "--", "do the thing"],
    { flags: ["json"], string: ["cwd"] }
  );
  assert.equal(r.options.cwd, ".");
  assert.equal(r.options.json, true);
  assert.deepEqual(r.positionals, ["auth"]);
  assert.equal(r.brief, "do the thing");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/util.test.mjs`
Expected: FAIL (`Cannot find module ../src/util.mjs`)

- [ ] **Step 3: Implement src/util.mjs**

```js
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

// Strict JSONL framing: split on \n only, strip one trailing \r.
export function splitJsonLines(chunk, prevRest = "") {
  const buffer = prevRest + chunk;
  const lines = [];
  let rest = buffer;
  let idx;
  while ((idx = rest.indexOf("\n")) !== -1) {
    let line = rest.slice(0, idx);
    rest = rest.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lines.push(line);
  }
  return { lines, rest };
}

export function parseLineSafe(line) {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

export async function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

export async function appendJsonLine(filePath, obj) {
  await fs.appendFile(filePath, JSON.stringify(obj) + "\n");
}

export async function appendText(filePath, text) {
  await fs.appendFile(filePath, text);
}

export async function readJsonlTail(filePath, n) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const out = [];
  for (const line of lines.slice(-n)) {
    const parsed = parseLineSafe(line);
    if (parsed.ok) out.push(parsed.value);
  }
  return out;
}

export async function tailText(filePath, nLines) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.split("\n").slice(-nLines).join("\n");
  } catch {
    return "";
  }
}

function stamp(d) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function runIdFor(name, now = new Date()) {
  return `${name}-${stamp(now)}`;
}

export function short7(runId) {
  return runId.slice(-7);
}

export function branchFor(name, runId) {
  return `pi-fleet/${name}-${short7(runId)}`;
}

export function firstLine(s) {
  const idx = (s ?? "").indexOf("\n");
  return idx === -1 ? (s ?? "") : s.slice(0, idx);
}

export function formatAge(ms) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function nowIso() {
  return new Date().toISOString();
}

// Parse argv for one command. `flags` are boolean options, `string` take a value.
// A bare `--` ends option parsing; everything after it becomes `brief`.
export function parseCommandArgs(argv, { flags = [], string = [] } = {}) {
  const options = {};
  const positionals = [];
  let brief = null;
  let inBrief = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (inBrief) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      inBrief = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (flags.includes(key)) {
        options[key] = true;
        continue;
      }
      if (string.includes(key)) {
        options[key] = argv[++i] ?? "";
        continue;
      }
      throw new Error(`unknown option --${key}`);
    }
    positionals.push(arg);
  }
  if (inBrief) brief = positionals.join(" ");
  return { options, positionals, brief };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/util.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/util.mjs tests/util.test.mjs
git commit -m "feat: util module — JSONL framing, atomic IO, ids, arg parsing"
```

---

### Task 3: state.mjs — run state schema, load/save, status, run index

**Files:**

- Create: `src/state.mjs`
- Test: `tests/state.test.mjs`

**Interfaces:**

- Consumes: `util.mjs` (`atomicWriteJson`, `readJsonlTail`, `runIdFor`, `nowIso`)
- Produces:
  - `RUN_STATES` = `["starting","running","settled","stopped","error","dead","archived"]`
  - `TERMINAL_STATES` = `["settled","stopped","error","dead","archived"]`
  - `newRunState({ fleetDir, runId, name, cwd, worktree, branch, base, model, provider, thinking, sessionArg, skill, appendSystemPrompt, tools, excludeTools, taskBrief })` → state object
  - `runDirFor(fleetDir, runId)` → `<fleetDir>/.pi-fleet/runs/<runId>`
  - `loadState(runDir)` → state (throws if missing)
  - `saveState(runDir, state)` (atomic)
  - `isAlive(pid)` → boolean (pid > 0 and `process.kill(pid, 0)` doesn't fail with ESRCH)
  - `deriveStatus(state, liveness = isAlive)` → `"dead"` if status is `starting`/`running` and pid not alive, else `state.status`
  - `recordToolActivity(state, toolName)` — sets `lastTool`, bumps `lastActivity`
  - `recordSteering(state, { source, message, ts })` — appends to `steeringLog` (cap 20), `steerCount++`
  - `appendControl(runDir, { type, message, source })` — appends line to `runDir/control.jsonl`
  - `listRuns(fleetDir)` → array of `{ runId, runDir }` sorted newest-first (by runId string desc)
  - `findRun(fleetDir, nameOrId)` → `{ runId, runDir, state }` of the newest non-archived run whose id equals `nameOrId`, or starts with `<nameOrId>-` with matching `state.name`; throws with a helpful message if not found

- [ ] **Step 1: Write failing tests**

`tests/state.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newRunState, loadState, saveState, deriveStatus, isAlive,
  recordToolActivity, recordSteering, appendControl, listRuns, findRun,
  runDirFor,
} from "../src/state.mjs";

function mkFleet() {
  const fleetDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-state-")), ".pi-fleet");
  fs.mkdirSync(fleetDir, { recursive: true });
  return fleetDir;
}

const base = {
  fleetDir: "/tmp/x/.pi-fleet", runId: "auth-20260828141530", name: "auth",
  cwd: "/tmp/x", worktree: null, branch: null, base: "HEAD", model: "m",
  provider: null, thinking: null, sessionArg: null, skill: null,
  appendSystemPrompt: null, tools: null, excludeTools: null, taskBrief: "b",
};

test("newRunState has the full schema with neutral defaults", () => {
  const s = newRunState(base);
  for (const k of ["id", "name", "status", "pid", "createdAt", "settledAt", "lastTool",
    "lastActivity", "lastAssistantText", "steerCount", "steeringLog", "error", "taskBrief"]) {
    assert.ok(k in s, `missing ${k}`);
  }
  assert.equal(s.status, "starting");
  assert.equal(s.pid, null);
  assert.equal(s.steerCount, 0);
});

test("saveState is atomic and loadState round-trips", async () => {
  const fleetDir = mkFleet();
  const runDir = runDirFor(fleetDir, base.runId);
  fs.mkdirSync(runDir, { recursive: true });
  const s = newRunState(base);
  await saveState(runDir, s);
  const loaded = await loadState(runDir);
  assert.equal(loaded.id, base.runId);
  assert.deepEqual(fs.readdirSync(runDir).filter((f) => f.includes(".tmp")), []);
});

test("deriveStatus flags dead when pid is gone mid-run", () => {
  const s = newRunState(base);
  s.status = "running";
  s.pid = 1; // our own... use injected liveness instead
  assert.equal(deriveStatus(s, (pid) => pid === 1), "running");
  assert.equal(deriveStatus(s, () => false), "dead");
  s.status = "settled";
  assert.equal(deriveStatus(s, () => false), "settled");
});

test("recordSteering caps log at 20 and counts", () => {
  const s = newRunState(base);
  for (let i = 0; i < 25; i++) {
    recordSteering(s, { source: "console", message: `m${i}`, ts: `t${i}` });
  }
  assert.equal(s.steerCount, 25);
  assert.equal(s.steeringLog.length, 20);
  assert.equal(s.steeringLog.at(-1).message, "m24");
});

test("appendControl writes one JSON line with ts", async () => {
  const fleetDir = mkFleet();
  const runDir = runDirFor(fleetDir, base.runId);
  fs.mkdirSync(runDir, { recursive: true });
  await appendControl(runDir, { type: "steer", message: "hi", source: "orchestrator" });
  const raw = fs.readFileSync(path.join(runDir, "control.jsonl"), "utf8").trim();
  const obj = JSON.parse(raw);
  assert.equal(obj.type, "steer");
  assert.ok(obj.ts);
});

test("listRuns newest-first and findRun resolves by name", async () => {
  const fleetDir = mkFleet();
  for (const id of ["auth-20260828141530", "auth-20260828161530"]) {
    const runDir = runDirFor(fleetDir, id);
    fs.mkdirSync(runDir, { recursive: true });
    await saveState(runDir, newRunState({ ...base, runId: id, name: "auth" }));
  }
  const runs = listRuns(fleetDir);
  assert.equal(runs[0].runId, "auth-20260828161530");
  const found = findRun(fleetDir, "auth");
  assert.equal(found.runId, "auth-20260828161530");
  assert.throws(() => findRun(fleetDir, "ghost"), /No run found/);
});
```

Note: `isAlive` is used indirectly via `deriveStatus` default; a direct smoke check (`isAlive(process.pid) === true`) is included in the implementation verification below rather than as a separate test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/state.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement src/state.mjs**

```js
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, runIdFor, nowIso } from "./util.mjs";

export const RUN_STATES = ["starting", "running", "settled", "stopped", "error", "dead", "archived"];
export const TERMINAL_STATES = ["settled", "stopped", "error", "dead", "archived"];

export function runDirFor(fleetDir, runId) {
  return path.join(fleetDir, "runs", runId);
}

export function newRunState(input) {
  const {
    fleetDir, runId, name, cwd, worktree, branch, base, model, provider,
    thinking, sessionArg, skill, appendSystemPrompt, tools, excludeTools, taskBrief,
  } = input;
  return {
    id: runId,
    name,
    status: "starting",
    cwd,
    worktree: worktree ?? null,
    branch: branch ?? null,
    base: base ?? null,
    model: model ?? null,
    provider: provider ?? null,
    thinking: thinking ?? null,
    sessionArg: sessionArg ?? null,
    skill: skill ?? null,
    appendSystemPrompt: appendSystemPrompt ?? null,
    tools: tools ?? null,
    excludeTools: excludeTools ?? null,
    taskBrief: taskBrief ?? "",
    fleetDir,
    pid: null,
    createdAt: nowIso(),
    settledAt: null,
    lastTool: null,
    lastActivity: null,
    lastAssistantText: null,
    steerCount: 0,
    steeringLog: [],
    error: null,
  };
}

export async function loadState(runDir) {
  const raw = await fsp.readFile(path.join(runDir, "state.json"), "utf8");
  return JSON.parse(raw);
}

export async function saveState(runDir, state) {
  await atomicWriteJson(path.join(runDir, "state.json"), state);
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function deriveStatus(state, liveness = isAlive) {
  if ((state.status === "starting" || state.status === "running") && !liveness(state.pid)) {
    return "dead";
  }
  return state.status;
}

export function recordToolActivity(state, toolName) {
  state.lastTool = toolName;
  state.lastActivity = nowIso();
}

export function recordSteering(state, { source, message, ts }) {
  state.steerCount += 1;
  state.steeringLog.push({ source, message, ts });
  if (state.steeringLog.length > 20) state.steeringLog.splice(0, state.steeringLog.length - 20);
}

export async function appendControl(runDir, { type, message, source }) {
  await fsp.appendFile(
    path.join(runDir, "control.jsonl"),
    JSON.stringify({ type, message, source, ts: nowIso() }) + "\n"
  );
}

export function listRuns(fleetDir) {
  const runsDir = path.join(fleetDir, "runs");
  let entries = [];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  return entries
    .map((runId) => ({ runId, runDir: path.join(runsDir, runId) }))
    .filter((r) => fs.existsSync(path.join(r.runDir, "state.json")))
    .sort((a, b) => (a.runId < b.runId ? 1 : -1));
}

export function findRun(fleetDir, nameOrId) {
  const runs = listRuns(fleetDir);
  const candidates = runs.filter((r) => {
    if (r.runId === nameOrId) return true;
    if (r.runId.startsWith(`${nameOrId}-`)) return true;
    return false;
  });
  const nonArchived = candidates.filter((r) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(r.runDir, "state.json"), "utf8")).status !== "archived";
    } catch {
      return false;
    }
  });
  const chosen = nonArchived[0] ?? candidates[0];
  if (!chosen) {
    throw new Error(`No run found matching "${nameOrId}" in ${fleetDir}/runs`);
  }
  const state = JSON.parse(fs.readFileSync(path.join(chosen.runDir, "state.json"), "utf8"));
  return { runId: chosen.runId, runDir: chosen.runDir, state };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/state.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/state.mjs tests/state.test.mjs
git commit -m "feat: run state schema, atomic persistence, status derivation, run index"
```

---

### Task 4: worktree.mjs — git worktree + branch lifecycle

**Files:**

- Create: `src/worktree.mjs`
- Test: `tests/worktree.test.mjs`

**Interfaces:**

- Consumes: `short7`, `branchFor` from `util.mjs`
- Produces:
  - `git(args, cwd)` → `{ code, stdout, stderr }` (no throw; callers decide)
  - `isGitRepo(dir)` → boolean
  - `repoRoot(dir)` → string | null
  - `ensureWorktree({ repoRoot, worktreesDir, runId, name, base })` → `{ worktreePath, branch, baseRef }` — runs `git worktree add <path> -b <branch> <baseRef>` where branch = `branchFor(name, runId)`, baseRef = `base || "HEAD"`; throws on failure
  - `removeWorktree({ repoRoot, worktreePath, branch, force = false })` — `git worktree remove [--force]`; then `git branch -d <branch>` (safe) or `-D` when `force`; branch deletion failure is non-fatal
  - `ensureGitignoreEntry(repoRoot, entry)` — appends `\n# pi-fleet\n<entry>\n` once; returns true if appended

- [ ] **Step 1: Write failing tests**

`tests/worktree.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isGitRepo, repoRoot, ensureWorktree, removeWorktree, ensureGitignoreEntry,
} from "../src/worktree.mjs";

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-wt-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

test("isGitRepo/repoRoot detect repos", () => {
  const root = initRepo();
  assert.equal(isGitRepo(root), true);
  assert.equal(repoRoot(root), fs.realpathSync(root));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pf-plain-"));
  assert.equal(isGitRepo(plain), false);
  assert.equal(repoRoot(plain), null);
});

test("ensureWorktree creates worktree and branch; removeWorktree cleans up when merged", () => {
  const root = initRepo();
  const worktreesDir = path.join(root, ".pi-fleet", "worktrees");
  const { worktreePath, branch } = ensureWorktree({
    repoRoot: root, worktreesDir, runId: "auth-20260828141530", name: "auth", base: null,
  });
  assert.equal(fs.existsSync(path.join(worktreePath, "seed.txt")), true);
  const branches = execFileSync("git", ["branch", "--list", branch], { cwd: root }).toString();
  assert.match(branches, /auth-28141530/);

  // simulate worker commit, then merge into main so -d succeeds
  fs.writeFileSync(path.join(worktreePath, "hello.txt"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: worktreePath });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.name", "t"], { cwd: worktreePath });
  execFileSync("git", ["commit", "-qm", "hello"], { cwd: worktreePath });
  execFileSync("git", ["merge", branch, "-q", "--no-edit"], { cwd: root });

  removeWorktree({ repoRoot: root, worktreePath, branch, force: false });
  assert.equal(fs.existsSync(worktreePath), false);
  const gone = execFileSync("git", ["branch", "--list", branch], { cwd: root }).toString();
  assert.equal(gone.trim(), "");
});

test("ensureGitignoreEntry appends once with marker", () => {
  const root = initRepo();
  assert.equal(ensureGitignoreEntry(root, ".pi-fleet/"), true);
  assert.equal(ensureGitignoreEntry(root, ".pi-fleet/"), false);
  const content = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(content, /# pi-fleet\n\.pi-fleet\//);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/worktree.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement src/worktree.mjs**

```js
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { branchFor } from "./util.mjs";

const pExecFile = promisify(execFile);

export async function git(args, cwd) {
  try {
    const { stdout, stderr } = await pExecFile("git", args, { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
  }
}

export async function isGitRepo(dir) {
  const r = await git(["rev-parse", "--is-inside-work-tree"], dir);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function repoRoot(dir) {
  const r = await git(["rev-parse", "--show-toplevel"], dir);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function ensureWorktree({ repoRoot: root, worktreesDir, runId, name, base }) {
  const branch = branchFor(name, runId);
  const worktreePath = path.join(worktreesDir, runId);
  const baseRef = base || "HEAD";
  const r = await git(["worktree", "add", worktreePath, "-b", branch, baseRef], root);
  if (r.code !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
  }
  return { worktreePath, branch, baseRef };
}

export async function removeWorktree({ repoRoot: root, worktreePath, branch, force = false }) {
  await git(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], root);
  // Safe delete: -d only removes fully merged branches; -D when force.
  await git(["branch", force ? "-D" : "-d", branch], root);
}

export async function ensureGitignoreEntry(root, entry) {
  const gitignorePath = path.join(root, ".gitignore");
  let content = "";
  try {
    content = await fsp.readFile(gitignorePath, "utf8");
  } catch {
    /* new file */
  }
  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(entry)) return false;
  const needsMarker = !lines.includes("# pi-fleet");
  const addition = `${needsMarker ? "# pi-fleet\n" : ""}${entry}\n`;
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await fsp.appendFile(gitignorePath, `${prefix}${addition}`);
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/worktree.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/worktree.mjs tests/worktree.test.mjs
git commit -m "feat: git worktree and branch lifecycle helpers"
```

---

### Task 5: spawn.mjs + spawn command wiring

**Files:**

- Create: `src/spawn.mjs`, `src/commands.mjs`
- Modify: `src/cli.mjs` (register `spawn` and `__monitor` commands)
- Test: `tests/spawn.test.mjs`

**Interfaces:**

- Consumes: `util.mjs` (`parseCommandArgs`, `runIdFor`), `state.mjs` (`newRunState`, `saveState`, `runDirFor`), `worktree.mjs` (`isGitRepo`, `repoRoot`, `ensureWorktree`, `ensureGitignoreEntry`)
- Produces:
  - `sanitizeName(name)` → lowercase kebab-case (used for run ids/branches)
  - `parseSpawnArgs(argv)` → `{ name, brief, opts }`; `opts` keys: `cwd, model, provider, thinking, base, skill, appendSystemPrompt, session, tools, excludeTools, worktree:boolean` (worktree default true, `--no-worktree` clears)
  - `resolveFleetDir(cwd)` → `{ targetDir, repoRoot: string|null, isGit, piFleetDir }` — **`piFleetDir` = `<root>/.pi-fleet` and is the value every later module calls `fleetDir`** (matches state.mjs semantics; note this naming: spec's "fleetDir" = root, code's `fleetDir` = the `.pi-fleet` dir)
  - `createRun({ name, opts, brief })` → `{ runId, runDir, piFleetDir, state, worktreePath|null }` — creates `runs/`, `reports/`, `worktrees/`, ensures `.pi-fleet/` gitignore entry, creates worktree + branch when git repo and `opts.worktree`, writes initial `state.json`. State gets two extra fields beyond Task 3: `repoRoot` (string|null) and `isGit` (boolean) — gitops commands rely on them
  - `launchMonitor({ cliPath, piFleetDir, runId })` — spawns detached `node <cliPath> __monitor <piFleetDir> <runId>`, `stdio: "ignore"`, `unref()`
  - `commands.mjs` exports `cmdSpawn(argv)` → exit code; `__monitor` is dispatched in cli.mjs via dynamic import of `runMonitor` (Task 6)

- [ ] **Step 1: Write failing tests**

`tests/spawn.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseSpawnArgs, resolveFleetDir, createRun, sanitizeName } from "../src/spawn.mjs";

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-spawn-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

test("sanitizeName kebab-cases", () => {
  assert.equal(sanitizeName("Auth Worker 2!"), "auth-worker-2");
});

test("parseSpawnArgs splits options, name, brief; worktree default on", () => {
  const { name, brief, opts } = parseSpawnArgs([
    "Auth Worker", "--cwd", ".", "--model", "glm", "--no-worktree", "--", "do X",
  ]);
  assert.equal(name, "auth-worker");
  assert.equal(brief, "do X");
  assert.equal(opts.worktree, false);
  assert.equal(opts.model, "glm");
  assert.throws(() => parseSpawnArgs(["a"]), /brief required/);
});

test("resolveFleetDir: git repo anchors to root; plain dir anchors to itself", async () => {
  const root = initRepo();
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub);
  const inRepo = await resolveFleetDir(sub);
  assert.equal(inRepo.isGit, true);
  assert.equal(inRepo.piFleetDir, path.join(fs.realpathSync(root), ".pi-fleet"));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pf-plain-"));
  const standalone = await resolveFleetDir(plain);
  assert.equal(standalone.isGit, false);
  assert.equal(standalone.repoRoot, null);
  assert.equal(standalone.piFleetDir, path.join(fs.realpathSync(plain), ".pi-fleet"));
});

test("createRun builds state dir, gitignore, worktree and initial state", async () => {
  const root = initRepo();
  const { runId, runDir, piFleetDir, state, worktreePath } = await createRun({
    name: "auth-worker",
    opts: { cwd: root, worktree: true, model: "glm", base: null },
    brief: "create hello",
  });
  assert.match(runId, /^auth-worker-\d{14}$/);
  assert.equal(fs.existsSync(path.join(piFleetDir, "runs", runId)), true);
  assert.equal(fs.existsSync(path.join(piFleetDir, "reports")), true);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8").includes(".pi-fleet/"), true);
  assert.equal(fs.existsSync(path.join(worktreePath, "seed.txt")), true);
  assert.match(state.branch, /^pi-fleet\/auth-worker-.{7}$/);
  assert.equal(state.repoRoot, fs.realpathSync(root));
  assert.equal(state.isGit, true);
  assert.equal(state.taskBrief, "create hello");
  assert.equal(state.status, "starting");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/spawn.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement src/spawn.mjs**

```js
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseCommandArgs, runIdFor } from "./util.mjs";
import { newRunState, saveState, runDirFor } from "./state.mjs";
import { isGitRepo, repoRoot, ensureWorktree, ensureGitignoreEntry } from "./worktree.mjs";

export function sanitizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function parseSpawnArgs(argv) {
  const { options, positionals, brief } = parseCommandArgs(argv, {
    flags: ["no-worktree"],
    string: ["cwd", "model", "provider", "thinking", "base", "skill",
      "append-system-prompt", "session", "tools", "exclude-tools"],
  });
  const name = positionals[0];
  if (!name) throw new Error("spawn: <name> required");
  if (brief === null || brief.trim() === "") {
    throw new Error('spawn: task brief required after "--"');
  }
  return {
    name: sanitizeName(name),
    brief,
    opts: {
      cwd: options.cwd ?? null,
      model: options.model ?? null,
      provider: options.provider ?? null,
      thinking: options.thinking ?? null,
      base: options.base ?? null,
      skill: options.skill ?? null,
      appendSystemPrompt: options["append-system-prompt"] ?? null,
      session: options.session ?? null,
      tools: options.tools ?? null,
      excludeTools: options["exclude-tools"] ?? null,
      worktree: !options["no-worktree"],
    },
  };
}

export async function resolveFleetDir(cwd) {
  const targetDir = path.resolve(cwd ?? process.cwd());
  if (!fsSync.existsSync(targetDir)) throw new Error(`--cwd does not exist: ${targetDir}`);
  const isGit = await isGitRepo(targetDir);
  const root = isGit ? await repoRoot(targetDir) : targetDir;
  return { targetDir, repoRoot: isGit ? root : null, isGit, piFleetDir: path.join(root, ".pi-fleet") };
}

export async function createRun({ name, opts, brief }) {
  const { targetDir, repoRoot: root, isGit, piFleetDir } = await resolveFleetDir(opts.cwd);
  await fsp.mkdir(path.join(piFleetDir, "runs"), { recursive: true });
  await fsp.mkdir(path.join(piFleetDir, "reports"), { recursive: true });
  await fsp.mkdir(path.join(piFleetDir, "worktrees"), { recursive: true });
  if (isGit) await ensureGitignoreEntry(root, ".pi-fleet/");

  const runId = runIdFor(name);
  let worktreePath = null;
  let branch = null;
  if (isGit && opts.worktree) {
    const created = await ensureWorktree({
      repoRoot: root,
      worktreesDir: path.join(piFleetDir, "worktrees"),
      runId,
      name,
      base: opts.base,
    });
    worktreePath = created.worktreePath;
    branch = created.branch;
  }

  const runDir = runDirFor(piFleetDir, runId);
  await fsp.mkdir(runDir, { recursive: true });
  const state = newRunState({
    fleetDir: piFleetDir, runId, name, cwd: targetDir,
    worktree: worktreePath, branch, base: opts.base, model: opts.model,
    provider: opts.provider, thinking: opts.thinking, sessionArg: opts.session,
    skill: opts.skill, appendSystemPrompt: opts.appendSystemPrompt,
    tools: opts.tools, excludeTools: opts.excludeTools, taskBrief: brief,
  });
  state.repoRoot = root;
  state.isGit = isGit;
  await saveState(runDir, state);
  return { runId, runDir, piFleetDir, state, worktreePath };
}

export function launchMonitor({ cliPath, piFleetDir, runId }) {
  const child = spawn(process.execPath, [cliPath, "__monitor", piFleetDir, runId], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}
```

- [ ] **Step 4: Create src/commands.mjs with cmdSpawn and wire into cli.mjs**

`src/commands.mjs`:

```js
import { fileURLToPath } from "node:url";
import { parseSpawnArgs, createRun, launchMonitor } from "./spawn.mjs";

export const CLI_PATH = fileURLToPath(import.meta.url).replace("commands.mjs", "cli.mjs");

export async function cmdSpawn(argv) {
  const { name, opts, brief } = parseSpawnArgs(argv);
  const created = await createRun({ name, opts, brief });
  launchMonitor({ cliPath: CLI_PATH, piFleetDir: created.piFleetDir, runId: created.runId });
  console.log(`Spawned ${created.runId}`);
  console.log(`  state:    ${created.runDir}/state.json`);
  console.log(`  fleet dir: ${created.piFleetDir}`);
  if (created.worktreePath) console.log(`  worktree: ${created.worktreePath}`);
  if (created.state.branch) console.log(`  branch:   ${created.state.branch}`);
  return 0;
}
```

Add to `src/cli.mjs` (inside the `COMMANDS` map region, above `main`):

```js
import { cmdSpawn } from "./commands.mjs";

const COMMANDS = new Map([
  ["help", () => { console.log(USAGE); return 0; }],
  ["spawn", cmdSpawn],
  ["__monitor", async (argv) => {
    const { runMonitor } = await import("./monitor.mjs");
    return runMonitor({ piFleetDir: argv[0], runId: argv[1] });
  }],
]);
```

(The `__monitor` import of `monitor.mjs` resolves in Task 6; until then the dispatch entry is added but `spawn` end-to-end is verified in Task 6's test.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/spawn.test.mjs tests/cli.test.mjs`
Expected: PASS (spawn: 4 tests; cli: 2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/spawn.mjs src/commands.mjs src/cli.mjs tests/spawn.test.mjs
git commit -m "feat: spawn command — fleet dir resolution, worktree creation, detached monitor launch"
```

---

## Stack adaptation rules (apply to Tasks 6–11)

Tasks 1–11 were drafted as `.mjs` zero-dependency code before the Global Constraints switched the project to TypeScript + commander/simple-git/cli-table3. Tasks 1–5 are already ported (see Task 5b). For Tasks 6–11 the **behavioral contracts, tests, and exit codes stand**; translate the code mechanically with these rules:

1. **Files**: `src/X.mjs` → `src/X.ts`. Relative imports carry the `.js` suffix (`import { x } from "./util.js"`) because of `moduleResolution: NodeNext`. There is no `bin/pi-fleet.mjs`; the bin is `dist/cli.js`, built from `src/cli.ts` (which already has the shebang).
2. **Arg parsing**: there is no `parseCommandArgs`/`parseSpawnArgs`. Every command is a commander subcommand registered in `src/cli.ts`; handlers in `src/commands.ts` have the shape `cmdX(args: { ...typed options }): Promise<number>` and return the exit code (`cli.ts`'s `done()` turns it into `process.exitCode`). The `-- "<brief>"` form is a variadic positional `[brief...]` joined with spaces, exactly like `spawn` already does; a missing brief throws `new Error('<cmd>: message required after "--"')`. Every run-addressed command accepts `--cwd <dir>` (use the shared `cwdOption` tuple in `cli.ts`).
3. **Shared helper** in `commands.ts`: `resolveRun(name: string, cwd?: string): Promise<{ piFleetDir: string; run: RunRef }>` = `resolveFleetDir(cwd)` then `findRun(piFleetDir, name)`. Use it in every run-addressed command.
4. **Git**: use `simple-git` via `src/worktree.ts`. Add there `gitRaw(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>` that wraps `simpleGit({ baseDir: cwd }).raw(args)` in try/catch (success → `{ code: 0, stdout, stderr: "" }`; failure → `{ code: 1, stdout: "", stderr: err.message }`). `diff`/`merge` use it instead of the plan's `git()`.
5. **Tables**: `status` renders with `cli-table3` (`new Table({ head: ["NAME","STATE","LAST-ACTIVITY","LAST-TOOL","STEERED","AGE"], style: { head: [], border: [] } })`).
6. **Tests**: `tests/<name>.test.ts`, run by `pnpm test` (`node --import tsx --test "tests/**/*.test.ts"`). Use `tests/helpers.ts` (`runCli`, `initRepo`, `tmpDir`, `fakePiEnv`, `readState`, `firstRunId`, `fleetDirOf`, `waitFor`, `TERMINAL`) instead of the inline `run(process.execPath, [BIN, ...])` calls: `await runCli(["spawn", "auth", "--cwd", root, "--no-worktree", "--", "create hello.txt"])` returns `{ code, stdout, stderr }` and never throws; pass `{ env: fakePiEnv({ FAKE_PI_DELAY_MS: "4000" }) }` for overrides and `{ cwd }` when the command must run from the orchestrating checkout. `fakePiEnv()` already sets `PI_FLEET_DEV=1` and points `PI_FLEET_PI_BIN` at `tests/fixtures/fake-pi.mjs` (plain JS, exactly as written in Task 6 — no loader needed for it). For the "pi crashes" cases use `fakePiEnv({ PI_FLEET_PI_BIN: "/bin/false" })`.
7. **Task 6's test must not call `pi-fleet wait`** (that is Task 8). Poll instead: `const state = await waitFor(() => { const s = readState(root); return TERMINAL.includes(s.status) ? s : undefined; }, { timeoutMs: 30_000 });`
8. **Types**: `strict` is on. RPC events cross the boundary as `type RpcEvent = { type: string; [key: string]: any }` (declare in `monitor.ts`); control lines are `{ type: ControlType; message: string | null; source: string; ts: string }` (types from `state.ts`). Give anything that outlives one function an explicit interface.
9. **Monitor wiring** already exists after Task 5b: hidden `pi-fleet __monitor <piFleetDir> <runId>` dynamically imports `./monitor.js` and calls `runMonitor({ piFleetDir, runId })`. Task 6 replaces the stub `src/monitor.ts`.
10. **State timestamps**: `lastActivity`, `settledAt`, `createdAt` are ISO strings from `nowIso()`.

---

### Task 5b: Backfill tests + build fixes for the TypeScript port of Tasks 1–5

**Files:**

- Modify: `src/commands.ts`, `src/cli.ts`, `src/spawn.ts`, `package.json`
- Create: `src/monitor.ts` (stub), `tests/helpers.ts`, `tests/cli.test.ts`, `tests/util.test.ts`, `tests/state.test.ts`, `tests/worktree.test.ts`, `tests/spawn.test.ts`

**Interfaces:**

- Consumes: everything Tasks 1–5 produced in `src/` (already ported to TS)
- Produces:
  - `tests/helpers.ts` exports used by every later test: `ROOT`, `CLI_TS`, `TSX_LOADER`, `FAKE_PI`, `TERMINAL`, `fakePiEnv(over?)`, `runCli(args, { env?, cwd? }) → Promise<{ code, stdout, stderr }>`, `tmpDir(prefix)`, `initRepo(prefix, files?)`, `fleetDirOf(root)`, `firstRunId(root)`, `readState(root, runId?)`, `waitFor(fn, { timeoutMs?, intervalMs? })`
  - `cliSpawnArgs()` in `commands.ts` returns `["--import", <absolute tsx loader>, <src/cli.ts>]` under `PI_FLEET_DEV=1`, else `[<dist/cli.js>]`
  - hidden `__monitor <piFleetDir> <runId>` command in `cli.ts`
  - `pnpm test` = `node --import tsx --test "tests/**/*.test.ts"`, `pnpm typecheck` = `tsc --noEmit -p tsconfig.json`

- [ ] **Step 1: Build and script fixes**

`src/commands.ts` — re-export the type `cli.ts` imports, use the absolute tsx loader (a bare `--import tsx` cannot be resolved when the child's cwd is outside this package — the detached monitor inherits the orchestrator's cwd), log the monitor's own stdio to `monitor.log`, and warn on in-place runs:

```ts
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRun, sanitizeName, resolveFleetDir, type SpawnOpts } from "./spawn.js";
import { runDirFor } from "./state.js";

export type { SpawnOpts } from "./spawn.js";

export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.dirname(SRC_DIR);

export function cliSpawnArgs(): string[] {
  if (process.env.PI_FLEET_DEV === "1") {
    const loader = fileURLToPath(import.meta.resolve("tsx"));
    return ["--import", loader, path.join(SRC_DIR, "cli.ts")];
  }
  return [path.join(SRC_DIR, "cli.js")];
}

export async function launchMonitor(args: { piFleetDir: string; runId: string }): Promise<void> {
  const logFd = fs.openSync(path.join(runDirFor(args.piFleetDir, args.runId), "monitor.log"), "a");
  const child = spawn(
    process.execPath,
    [...cliSpawnArgs(), "__monitor", args.piFleetDir, args.runId],
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  fs.closeSync(logFd);
}

export async function cmdSpawn(args: { name: string; brief: string; opts: SpawnOpts }): Promise<number> {
  if (!args.brief.trim()) throw new Error('spawn: task brief required after "--"');
  const created = await createRun({ name: sanitizeName(args.name), opts: args.opts, brief: args.brief });
  if (!created.state.isGit && args.opts.worktree !== false) {
    console.error("warning: target is not a git repo — running in place without a worktree");
  }
  await launchMonitor({ piFleetDir: created.piFleetDir, runId: created.runId });
  console.log(`Spawned ${created.runId}`);
  console.log(`  state:    ${created.runDir}/state.json`);
  console.log(`  fleet dir: ${created.piFleetDir}`);
  if (created.worktreePath) console.log(`  worktree: ${created.worktreePath}`);
  if (created.state.branch) console.log(`  branch:   ${created.state.branch}`);
  return 0;
}
```

`src/spawn.ts` — resolve symlinks so non-git targets compare equal to git's real paths (macOS `/var` → `/private/var`): in `resolveFleetDir`, after the existence check, `const realTarget = fs.realpathSync(targetDir);` and use `realTarget` for `targetDir`, `root`, and `piFleetDir`.

`src/monitor.ts` stub (Task 6 replaces it):

```ts
export async function runMonitor(_args: { piFleetDir: string; runId: string }): Promise<number> {
  throw new Error("monitor not implemented");
}
```

`src/cli.ts` — register the hidden monitor command (after the `spawn` command):

```ts
program
  .command("__monitor <piFleetDir> <runId>", { hidden: true })
  .action(async (piFleetDir: string, runId: string) => {
    const { runMonitor } = await import("./monitor.js");
    done(await runMonitor({ piFleetDir, runId }));
  });
```

`package.json` scripts:

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "prepare": "pnpm run build",
  "test": "node --import tsx --test \"tests/**/*.test.ts\"",
  "test:e2e": "node --import tsx tests/e2e.ts"
}
```

- [ ] **Step 2: Write tests/helpers.ts**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pExecFile = promisify(execFile);

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_TS = path.join(ROOT, "src", "cli.ts");
export const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));
export const FAKE_PI = path.join(ROOT, "tests", "fixtures", "fake-pi.mjs");
export const TERMINAL = ["settled", "stopped", "error", "dead", "archived"];

export function fakePiEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_FLEET_DEV: "1",
    PI_FLEET_PI_BIN: `${process.execPath} ${FAKE_PI}`,
    FAKE_PI_DELAY_MS: "200",
    ...over,
  };
}

export interface CliResult { code: number; stdout: string; stderr: string }

export async function runCli(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await pExecFile(
      process.execPath,
      ["--import", TSX_LOADER, CLI_TS, ...args],
      { env: opts.env ?? fakePiEnv(), cwd: opts.cwd },
    );
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return {
      code: typeof err?.code === "number" ? err.code : 1,
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? String(err),
    };
  }
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function initRepo(prefix: string, files: Record<string, string> = { "seed.txt": "seed\n" }): string {
  const root = tmpDir(prefix);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

export function fleetDirOf(root: string): string {
  return path.join(fs.realpathSync(root), ".pi-fleet");
}

export function firstRunId(root: string): string {
  const runs = fs.readdirSync(path.join(fleetDirOf(root), "runs"));
  if (!runs[0]) throw new Error(`no runs under ${root}`);
  return runs[0];
}

export function readState(root: string, runId: string = firstRunId(root)): any {
  return JSON.parse(fs.readFileSync(path.join(fleetDirOf(root), "runs", runId, "state.json"), "utf8"));
}

export async function waitFor<T>(
  fn: () => T | undefined,
  { timeoutMs = 10_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined;
    try { value = fn(); } catch { value = undefined; }
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

- [ ] **Step 3: Write tests/cli.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli, tmpDir } from "./helpers.js";

test("--help prints usage, lists spawn, hides __monitor, exits 0", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /pi-fleet/);
  assert.match(r.stdout, /spawn/);
  assert.doesNotMatch(r.stdout, /__monitor/);
});

test("unknown command exits 1", async () => {
  const r = await runCli(["nope"]);
  assert.equal(r.code, 1);
});

test("spawn without a brief exits 1 with guidance", async () => {
  const r = await runCli(["spawn", "x", "--cwd", tmpDir("pf-cli-")]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /brief required/);
});
```

- [ ] **Step 4: Write tests/util.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  splitJsonLines, parseLineSafe, atomicWriteJson, appendJsonLine, readJsonlTail,
  runIdFor, short7, branchFor, firstLine, formatAge, resultTextOf,
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
  const r = splitJsonLines('{"a":"x y"}\n', "");
  assert.equal(r.lines.length, 1);
  assert.equal(JSON.parse(r.lines[0]).a, "x y");
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
```

- [ ] **Step 5: Write tests/state.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  newRunState, loadState, saveState, deriveStatus, isAlive, recordSteering,
  recordToolActivity, appendControl, listRuns, findRun, runDirFor,
} from "../src/state.js";
import { tmpDir } from "./helpers.js";

function mkFleet(): string {
  const fleetDir = path.join(tmpDir("pf-state-"), ".pi-fleet");
  fs.mkdirSync(fleetDir, { recursive: true });
  return fleetDir;
}

const base = {
  fleetDir: "/tmp/x/.pi-fleet", runId: "auth-20260828141530", name: "auth",
  cwd: "/tmp/x", base: "HEAD", model: "m", taskBrief: "b",
};

test("newRunState has the full schema with neutral defaults", () => {
  const s = newRunState(base);
  for (const k of ["id", "name", "status", "pid", "createdAt", "settledAt", "lastTool",
    "lastActivity", "lastAssistantText", "steerCount", "steeringLog", "error", "taskBrief",
    "repoRoot", "isGit"]) {
    assert.ok(k in s, `missing ${k}`);
  }
  assert.equal(s.status, "starting");
  assert.equal(s.pid, null);
  assert.equal(s.steerCount, 0);
  assert.equal(s.worktree, null);
});

test("saveState is atomic and loadState round-trips", async () => {
  const runDir = runDirFor(mkFleet(), base.runId);
  fs.mkdirSync(runDir, { recursive: true });
  await saveState(runDir, newRunState(base));
  const loaded = await loadState(runDir);
  assert.equal(loaded.id, base.runId);
  assert.deepEqual(fs.readdirSync(runDir).filter((f) => f.includes(".tmp")), []);
  await assert.rejects(loadState(path.join(runDir, "missing")), /No readable state.json/);
});

test("isAlive: own pid alive, absurd pid not", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(null), false);
  assert.equal(isAlive(2 ** 22 + 12345), false);
});

test("deriveStatus flags dead when pid is gone mid-run", () => {
  const s = newRunState(base);
  s.status = "running";
  s.pid = 1;
  assert.equal(deriveStatus(s, (pid) => pid === 1), "running");
  assert.equal(deriveStatus(s, () => false), "dead");
  s.status = "settled";
  assert.equal(deriveStatus(s, () => false), "settled");
});

test("recordToolActivity and recordSteering (cap 20) update state", () => {
  const s = newRunState(base);
  recordToolActivity(s, "bash");
  assert.equal(s.lastTool, "bash");
  assert.ok(s.lastActivity);
  for (let i = 0; i < 25; i++) recordSteering(s, { source: "console", message: `m${i}`, ts: `t${i}` });
  assert.equal(s.steerCount, 25);
  assert.equal(s.steeringLog.length, 20);
  assert.equal(s.steeringLog.at(-1)?.message, "m24");
});

test("appendControl writes one JSON line with ts", async () => {
  const runDir = runDirFor(mkFleet(), base.runId);
  fs.mkdirSync(runDir, { recursive: true });
  await appendControl(runDir, { type: "steer", message: "hi", source: "orchestrator" });
  const obj = JSON.parse(fs.readFileSync(path.join(runDir, "control.jsonl"), "utf8").trim());
  assert.equal(obj.type, "steer");
  assert.equal(obj.source, "orchestrator");
  assert.ok(obj.ts);
});

test("listRuns newest-first; findRun prefers non-archived; throws when absent", async () => {
  const fleetDir = mkFleet();
  for (const id of ["auth-20260828141530", "auth-20260828161530"]) {
    const runDir = runDirFor(fleetDir, id);
    fs.mkdirSync(runDir, { recursive: true });
    await saveState(runDir, newRunState({ ...base, runId: id }));
  }
  assert.equal(listRuns(fleetDir)[0].runId, "auth-20260828161530");
  assert.equal(findRun(fleetDir, "auth").runId, "auth-20260828161530");
  const newest = findRun(fleetDir, "auth-20260828161530");
  newest.state.status = "archived";
  await saveState(newest.runDir, newest.state);
  assert.equal(findRun(fleetDir, "auth").runId, "auth-20260828141530");
  assert.throws(() => findRun(fleetDir, "ghost"), /No run found/);
});
```

- [ ] **Step 6: Write tests/worktree.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isGitRepo, repoRoot, ensureWorktree, removeWorktree, ensureGitignoreEntry } from "../src/worktree.js";
import { initRepo, tmpDir } from "./helpers.js";

test("isGitRepo/repoRoot detect repos", async () => {
  const root = initRepo("pf-wt-");
  assert.equal(await isGitRepo(root), true);
  assert.equal(await repoRoot(root), fs.realpathSync(root));
  const plain = tmpDir("pf-plain-");
  assert.equal(await isGitRepo(plain), false);
  assert.equal(await repoRoot(plain), null);
});

test("ensureWorktree creates worktree + branch; removeWorktree cleans up when merged", async () => {
  const root = initRepo("pf-wt-");
  const worktreesDir = path.join(root, ".pi-fleet", "worktrees");
  const { worktreePath, branch } = await ensureWorktree({
    repoRoot: root, worktreesDir, runId: "auth-20260828141530", name: "auth", base: null,
  });
  assert.equal(fs.existsSync(path.join(worktreePath, "seed.txt")), true);
  assert.equal(branch, "pi-fleet/auth-8141530");
  assert.match(execFileSync("git", ["branch", "--list", branch], { cwd: root }).toString(), /auth-8141530/);

  fs.writeFileSync(path.join(worktreePath, "hello.txt"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: worktreePath });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "hello"], { cwd: worktreePath });
  execFileSync("git", ["merge", branch, "-q", "--no-edit"], { cwd: root });

  const r = await removeWorktree({ repoRoot: root, worktreePath, branch, force: false });
  assert.deepEqual(r, { worktreeRemoved: true, branchDeleted: true });
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(execFileSync("git", ["branch", "--list", branch], { cwd: root }).toString().trim(), "");
});

test("removeWorktree keeps an unmerged branch unless force", async () => {
  const root = initRepo("pf-wt-");
  const worktreesDir = path.join(root, ".pi-fleet", "worktrees");
  const { worktreePath, branch } = await ensureWorktree({
    repoRoot: root, worktreesDir, runId: "x-20260828141530", name: "x", base: null,
  });
  fs.writeFileSync(path.join(worktreePath, "unmerged.txt"), "u\n");
  execFileSync("git", ["add", "."], { cwd: worktreePath });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "u"], { cwd: worktreePath });
  const soft = await removeWorktree({ repoRoot: root, worktreePath, branch, force: false });
  assert.equal(soft.worktreeRemoved, true);
  assert.equal(soft.branchDeleted, false);
  const hard = await removeWorktree({ repoRoot: root, worktreePath, branch, force: true });
  assert.equal(hard.branchDeleted, true);
});

test("ensureGitignoreEntry appends once with marker", async () => {
  const root = initRepo("pf-wt-");
  assert.equal(await ensureGitignoreEntry(root, ".pi-fleet/"), true);
  assert.equal(await ensureGitignoreEntry(root, ".pi-fleet/"), false);
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /# pi-fleet\n\.pi-fleet\//);
});
```

- [ ] **Step 7: Write tests/spawn.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveFleetDir, createRun, sanitizeName } from "../src/spawn.js";
import { initRepo, tmpDir } from "./helpers.js";

test("sanitizeName kebab-cases", () => {
  assert.equal(sanitizeName("Auth Worker 2!"), "auth-worker-2");
  assert.equal(sanitizeName("--x--"), "x");
});

test("resolveFleetDir: git repo anchors to root; plain dir anchors to itself; missing dir throws", async () => {
  const root = initRepo("pf-spawn-");
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub);
  const inRepo = await resolveFleetDir(sub);
  assert.equal(inRepo.isGit, true);
  assert.equal(inRepo.repoRoot, fs.realpathSync(root));
  assert.equal(inRepo.piFleetDir, path.join(fs.realpathSync(root), ".pi-fleet"));
  const plain = tmpDir("pf-plain-");
  const standalone = await resolveFleetDir(plain);
  assert.equal(standalone.isGit, false);
  assert.equal(standalone.repoRoot, null);
  assert.equal(standalone.piFleetDir, path.join(fs.realpathSync(plain), ".pi-fleet"));
  await assert.rejects(resolveFleetDir(path.join(plain, "nope")), /does not exist/);
});

test("createRun builds state dir, gitignore, worktree and initial state", async () => {
  const root = initRepo("pf-spawn-");
  const { runId, piFleetDir, state, worktreePath } = await createRun({
    name: "auth-worker", opts: { cwd: root, worktree: true, model: "glm" }, brief: "create hello",
  });
  assert.match(runId, /^auth-worker-\d{14}$/);
  assert.equal(fs.existsSync(path.join(piFleetDir, "runs", runId, "state.json")), true);
  assert.equal(fs.existsSync(path.join(piFleetDir, "reports")), true);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8").includes(".pi-fleet/"), true);
  assert.ok(worktreePath);
  assert.equal(fs.existsSync(path.join(worktreePath, "seed.txt")), true);
  assert.match(state.branch ?? "", /^pi-fleet\/auth-worker-.{7}$/);
  assert.equal(state.repoRoot, fs.realpathSync(root));
  assert.equal(state.isGit, true);
  assert.equal(state.taskBrief, "create hello");
  assert.equal(state.status, "starting");
  assert.equal(state.model, "glm");
});

test("createRun in a plain directory runs in place (no worktree, no branch)", async () => {
  const dir = tmpDir("pf-plain-");
  const { state, worktreePath } = await createRun({ name: "r", opts: { cwd: dir }, brief: "b" });
  assert.equal(worktreePath, null);
  assert.equal(state.branch, null);
  assert.equal(state.isGit, false);
  assert.equal(state.cwd, fs.realpathSync(dir));
});
```

- [ ] **Step 8: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; 25 tests PASS.

- [ ] **Step 9: Commit (this also lands the previously uncommitted Tasks 1–5 work)**

```bash
git add -A
git commit -m "feat: pi-fleet scaffold — CLI, util, state, worktree, spawn (TypeScript) with tests"
```

---

### Task 6: monitor.mjs — owns the pi RPC child, captures events, settles state

**Files:**

- Create: `src/monitor.mjs`, `tests/fixtures/fake-pi.mjs`
- Test: `tests/monitor.test.mjs`

**Interfaces:**

- Consumes: `util.mjs` (`splitJsonLines`, `parseLineSafe`, `nowIso`, `firstLine`), `state.mjs` (`loadState`, `saveState`, `recordToolActivity`)
- Produces:
  - `runMonitor({ piFleetDir, runId })` → resolves `0` after the pi child exits and final state is saved
  - Monitor behavior contract (commands in later tasks depend on it):
    - sets `state.pid = process.pid` (monitor's own pid), `status:"running"` at start
    - spawns `PI_FLEET_PI_BIN || "pi"` with `--mode rpc --session-dir <runDir>/session` plus passthroughs (`--provider --model --thinking --skill --append-system-prompt --tools --exclude-tools --session`), cwd = `state.worktree ?? state.cwd`, env adds `PI_FLEET_RUN`, `PI_FLEET_DIR`
    - appends every raw stdout line to `rpc.log`; appends selected events to `events.jsonl` with `ts`: the `SELECTED` set (agent_start, agent_end, agent_settled, turn_end, tool_execution_start, tool_execution_end, extension_error, auto_retry_start, auto_retry_end, compaction_start, compaction_end) plus `message_update` events where `assistantMessageEvent.type ∈ {text_start, text_delta, text_end}` (stored as `{type:"message_update", ev:{type, contentIndex, delta, content?}}`)
    - emits fleet event `{type:"task_prompt", brief}` and sends `{id:"fleet-init", type:"prompt", message: brief + reportReminder}` ~150ms after start
    - on `agent_settled`: status = `"stopped"` if abort already requested else `"settled"`, sets `settledAt`, sends `{id:"fleet-last", type:"get_last_assistant_text"}`; patches `lastAssistantText` from the response
    - on child close: if status not settled/stopped → `"error"` with last 8 stderr lines in `state.error` (stderr tail kept in memory, last 20 lines)
    - state saves are debounced on a 300ms dirty-flush interval; critical transitions flush immediately
    - `SIGTERM` on the monitor forwards an RPC `abort` to the pi child and sets pendingAbort

- [ ] **Step 1: Write the fake-pi fixture**

`tests/fixtures/fake-pi.mjs`:

```js
#!/usr/bin/env node
// Scripted `pi --mode rpc` replacement.
// Env: FAKE_PI_DELAY_MS (settle delay after work, default 300),
//      FAKE_PI_WRITE_HELLO=1 (write + git-commit hello.txt in cwd).
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const steers = [];
let taskStarted = false;
const delay = Number(process.env.FAKE_PI_DELAY_MS || 300);

function writeReport() {
  const dir = process.env.PI_FLEET_DIR;
  const runId = process.env.PI_FLEET_RUN;
  if (!dir || !runId) return;
  fsSync.mkdirSync(path.join(dir, "reports"), { recursive: true });
  const steeringSection = steers.length > 0
    ? steers.map((s) => `- ${s.message}`).join("\n")
    : "none";
  fsSync.writeFileSync(
    path.join(dir, "reports", `${runId}.md`),
    `# Fleet Report: ${runId}\n\n## Status\ndone\n\n## Summary\nCreated hello.txt with greeting content as briefed.\n\n## What I did\n1. Created hello.txt\n2. Verified content\n\n## Files changed\nhello.txt: new file with greeting\n\n## Verification\ncat hello.txt -> hi\n\n## Decisions & assumptions\nGreeting text chosen as "hi".\n\n## Steering received\n${steeringSection}\n\n## Open questions for orchestrator\n(none)\n\n## Suggested next step\nMerge pi-fleet branch.\n`
  );
}

function doWork() {
  if (process.env.FAKE_PI_WRITE_HELLO === "1") {
    fsSync.writeFileSync(path.join(process.cwd(), "hello.txt"), "hi\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "hello.txt"], { cwd: process.cwd() });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add hello"], { cwd: process.cwd() });
  }
}

function runTask() {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working: " } });
  send({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi" } });
  doWork();
  send({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wrote hello.txt" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Working: wrote hello.txt" } });
  send({ type: "turn_end", message: { role: "assistant" } });
  writeReport();
  setTimeout(() => {
    send({ type: "agent_end", willRetry: false });
    send({ type: "agent_settled" });
  }, delay);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "prompt" && !taskStarted) {
      taskStarted = true;
      runTask();
    } else if (msg.type === "steer") {
      steers.push({ message: msg.message });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: `[steer ack: ${msg.message}]` } });
    } else if (msg.type === "follow_up") {
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "[followup ack]" } });
    } else if (msg.type === "abort") {
      send({ type: "agent_end", willRetry: false });
      send({ type: "agent_settled" });
    } else if (msg.type === "get_last_assistant_text") {
      send({ id: msg.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "Working: wrote hello.txt" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
```

- [ ] **Step 2: Write failing test**

`tests/monitor.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "pi-fleet.mjs");
const FAKE_PI = path.join(ROOT, "tests", "fixtures", "fake-pi.mjs");

function initRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

The monitor launches `PI_FLEET_PI_BIN || "pi"` as a single executable spec string, split on the first space (`const [piBin, ...piPrefix] = (process.env.PI_FLEET_PI_BIN || "pi").split(" ")`) — so tests point at the `.mjs` fixture with `PI_FLEET_PI_BIN: "node <abs path>"`:

```js
const env = (over = {}) => ({
  ...process.env,
  PI_FLEET_PI_BIN: `${process.execPath} ${FAKE_PI}`,
  FAKE_PI_DELAY_MS: "300",
  ...over,
});
```

```js
test("full run: spawn → settled → lastAssistantText + report + events captured", async () => {
  const root = initRepo("pf-mon-");
  await run(process.execPath, [BIN, "spawn", "auth", "--cwd", root, "--no-worktree", "--", "create hello.txt"], { env: env() });
  const wait = await run(process.execPath, [BIN, "wait", "auth", "--cwd", root, "--timeout", "30"], { env: env() });
  assert.equal(wait.stdout.trim(), ""); // quiet success is fine

  const fleetDir = path.join(fs.realpathSync(root), ".pi-fleet");
  const runId = fs.readdirSync(path.join(fleetDir, "runs"))[0];
  const state = JSON.parse(fs.readFileSync(path.join(fleetDir, "runs", runId, "state.json"), "utf8"));
  assert.equal(state.status, "settled");
  assert.equal(state.lastAssistantText, "Working: wrote hello.txt");
  assert.ok(state.lastTool === "bash");
  assert.equal(fs.existsSync(path.join(fleetDir, "reports", `${runId}.md`)), true);
  const events = fs.readFileSync(path.join(fleetDir, "runs", runId, "events.jsonl"), "utf8");
  assert.match(events, /tool_execution_end/);
  assert.match(events, /"text_end"/);
  assert.match(events, /"task_prompt"/);
  // state.json pid equals the monitor process (alive or finished — just an integer)
  assert.ok(Number.isInteger(state.pid));
}, { timeout: 60_000 });

test("pi child crash → wait exits 4 with error state", async () => {
  const root = initRepo("pf-err-");
  await run(process.execPath, [BIN, "spawn", "boom", "--cwd", root, "--no-worktree", "--", "x"], {
    env: { ...process.env, PI_FLEET_PI_BIN: "/bin/false" },
  });
  const code = await run(process.execPath, [BIN, "wait", "boom", "--cwd", root, "--timeout", "20"], { env: {} })
    .then(() => 0)
    .catch((err) => err.code);
  assert.equal(code, 4);
  const fleetDir = path.join(fs.realpathSync(root), ".pi-fleet");
  const runId = fs.readdirSync(path.join(fleetDir, "runs"))[0];
  const state = JSON.parse(fs.readFileSync(path.join(fleetDir, "runs", runId, "state.json"), "utf8"));
  assert.equal(state.status, "error");
  assert.ok(state.error !== null);
}, { timeout: 60_000 });
```

Note the test `wait` command needs a `--cwd` option (used above) so it can locate the fleet dir — `wait`/`status`/`send`/etc. all accept `--cwd` and pass it to `resolveFleetDir`. This is part of Task 8's command implementations; add the flag there.

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/monitor.test.mjs`
Expected: FAIL (`monitor.mjs` missing → spawn exits 1)

- [ ] **Step 4: Implement src/monitor.mjs**

```js
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { splitJsonLines, parseLineSafe, nowIso } from "./util.mjs";
import { loadState, saveState, recordToolActivity } from "./state.mjs";

const SELECTED = new Set([
  "agent_start", "agent_end", "agent_settled", "turn_end",
  "tool_execution_start", "tool_execution_end", "extension_error",
  "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end",
]);
const TEXT_TYPES = new Set(["text_start", "text_delta", "text_end"]);

export async function runMonitor({ piFleetDir, runId }) {
  const runDir = path.join(piFleetDir, "runs", runId);
  const state = await loadState(runDir);
  state.pid = process.pid;
  state.status = "running";

  let dirty = true;
  let settledHandled = false;
  let pendingAbort = false;
  const eventsPath = path.join(runDir, "events.jsonl");
  const rpcLogPath = path.join(runDir, "rpc.log");

  const writeEvent = (obj) => {
    fsSync.appendFileSync(eventsPath, JSON.stringify({ ...obj, ts: nowIso() }) + "\n");
  };
  const flushNow = async () => {
    dirty = false;
    await saveState(runDir, state);
  };
  const flusher = setInterval(() => {
    if (dirty) { dirty = false; saveState(runDir, state).catch(() => {}); }
  }, 300);

  const piSpec = (process.env.PI_FLEET_PI_BIN || "pi").split(" ");
  const piArgs = [
    ...piSpec.slice(1),
    "--mode", "rpc",
    "--session-dir", path.join(runDir, "session"),
  ];
  if (state.provider) piArgs.push("--provider", state.provider);
  if (state.model) piArgs.push("--model", state.model);
  if (state.thinking) piArgs.push("--thinking", state.thinking);
  if (state.skill) piArgs.push("--skill", state.skill);
  if (state.appendSystemPrompt) piArgs.push("--append-system-prompt", state.appendSystemPrompt);
  if (state.tools) piArgs.push("--tools", state.tools);
  if (state.excludeTools) piArgs.push("--exclude-tools", state.excludeTools);
  if (state.sessionArg) piArgs.push("--session", state.sessionArg);

  const child = spawn(piSpec[0], piArgs, {
    cwd: state.worktree ?? state.cwd,
    env: { ...process.env, PI_FLEET_RUN: runId, PI_FLEET_DIR: piFleetDir },
  });

  const stderrTail = [];
  child.stderr.on("data", (d) => {
    stderrTail.push(d.toString());
    if (stderrTail.length > 20) stderrTail.shift();
  });

  function handleEvent(ev) {
    if (ev.type === "response" && ev.command === "get_last_assistant_text" && ev.success) {
      state.lastAssistantText = ev.data?.text ?? state.lastAssistantText;
      dirty = true;
      flushNow().catch(() => {});
      return;
    }
    if (ev.type === "message_update" && ev.assistantMessageEvent && TEXT_TYPES.has(ev.assistantMessageEvent.type)) {
      const a = ev.assistantMessageEvent;
      writeEvent({ type: "message_update", ev: { type: a.type, contentIndex: a.contentIndex, delta: a.delta, content: a.content } });
      if (a.type === "text_delta") { state.lastActivity = nowIso(); dirty = true; }
      return;
    }
    if (!SELECTED.has(ev.type)) return;
    writeEvent(ev);
    if (ev.type === "tool_execution_start" || ev.type === "tool_execution_end") {
      recordToolActivity(state, ev.toolName ?? state.lastTool);
      dirty = true;
    }
    if (ev.type === "agent_settled" && !settledHandled) {
      settledHandled = true;
      state.status = pendingAbort ? "stopped" : "settled";
      state.settledAt = nowIso();
      flushNow().catch(() => {});
      try {
        child.stdin.write(JSON.stringify({ id: "fleet-last", type: "get_last_assistant_text" }) + "\n");
      } catch {}
    }
  }

  let rest = "";
  child.stdout.on("data", (chunk) => {
    const framed = splitJsonLines(chunk.toString(), rest);
    rest = framed.rest;
    for (const line of framed.lines) {
      try { fsSync.appendFileSync(rpcLogPath, line + "\n"); } catch {}
      const parsed = parseLineSafe(line);
      if (parsed.ok) handleEvent(parsed.value);
    }
  });

  const reportReminder =
    `When you finish this task, write your fleet report to ${piFleetDir}/reports/${runId}.md ` +
    `using the fleet-worker-report template before ending your final turn. ` +
    `Include a "Steering received" section ("none" if you received no steering).`;
  setTimeout(() => {
    try {
      writeEvent({ type: "task_prompt", brief: state.taskBrief });
      child.stdin.write(JSON.stringify({
        id: "fleet-init", type: "prompt",
        message: `${state.taskBrief}\n\n${reportReminder}`,
      }) + "\n");
    } catch {}
  }, 150);

  process.on("SIGTERM", () => {
    pendingAbort = true;
    try { child.stdin.write(JSON.stringify({ type: "abort" }) + "\n"); } catch {}
  });

  return await new Promise((resolve) => {
    child.on("close", async () => {
      clearInterval(flusher);
      if (state.status !== "settled" && state.status !== "stopped") {
        state.status = "error";
        state.error = stderrTail.join("").split("\n").slice(-8).join("\n");
      }
      if (!state.settledAt) state.settledAt = nowIso();
      try { await saveState(runDir, state); } catch {}
      resolve(0);
    });
  });
}
```

- [ ] **Step 5: Run monitor tests**

Run: `node --test tests/monitor.test.mjs`
Expected: PASS (2 tests, up to ~35s runtime)

- [ ] **Step 6: Commit**

```bash
git add src/monitor.mjs tests/fixtures/fake-pi.mjs tests/monitor.test.mjs
git commit -m "feat: monitor — owns pi RPC child, captures events, settles state, error tails"
```

---

### Task 7: monitor control channel — steering, follow-up, abort with provenance

**Files:**

- Modify: `src/monitor.mjs`
- Test: `tests/monitor-control.test.mjs`

**Interfaces:**

- Consumes: Task 6 monitor, Task 3 `recordSteering`, `appendControl` (state.mjs), `TERMINAL_STATES`
- Produces (monitor additions):
  - Polls `<runDir>/control.jsonl` every 300ms starting from the file size at monitor boot (byte offset); parses complete new lines
  - `steer` / `follow_up` (skipped when already settled): forwards `{type, message}` to pi stdin, emits fleet event `{type:"steering_delivered", source, message}`, calls `recordSteering(state, {source, message, ts})`
  - `abort`: emits `{type:"abort_requested"}`, sets `pendingAbort`, forwards `{type:"abort"}` to pi stdin
  - `stop` command (Task 9) depends on this; report steering appendix (Task 10) reads `state.steeringLog`

- [ ] **Step 1: Write failing test**

`tests/monitor-control.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "pi-fleet.mjs");
const FAKE_PI = path.join(ROOT, "tests", "fixtures", "fake-pi.mjs");

function initRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

function fleetDirOf(root) {
  return path.join(fs.realpathSync(root), ".pi-fleet");
}

async function waitSettled(root, name, timeout = "30") {
  try {
    await run(process.execPath, [BIN, "wait", name, "--cwd", root, "--timeout", timeout], { env: process.env });
    return "settled";
  } catch (err) {
    return `exit-${err.code}`;
  }
}

test("console steering mid-run → steering_delivered event, steerCount, report reflects it", async () => {
  const root = initRepo("pf-steer-");
  await run(process.execPath, [BIN, "spawn", "auth", "--cwd", root, "--no-worktree", "--", "create hello.txt"], {
    env: { ...process.env, PI_FLEET_PI_BIN: `${process.execPath} ${FAKE_PI}`, FAKE_PI_DELAY_MS: "4000" },
  });
  const fleetDir = fleetDirOf(root);
  // wait until the run is running
  const runsDir = path.join(fleetDir, "runs");
  let runId;
  for (let i = 0; i < 50 && !runId; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const entries = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
    if (entries[0]) {
      const s = JSON.parse(fs.readFileSync(path.join(runsDir, entries[0], "state.json"), "utf8"));
      if (s.status === "running") runId = entries[0];
    }
  }
  assert.ok(runId, "run never reached running state");
  // simulate console steering (raw control line, same as pi-fleet attach writes)
  fs.appendFileSync(
    path.join(runsDir, runId, "control.jsonl"),
    JSON.stringify({ type: "steer", message: "use tabs not spaces", source: "console", ts: new Date().toISOString() }) + "\n"
  );
  assert.equal(await waitSettled(root, "auth"), "settled");

  const state = JSON.parse(fs.readFileSync(path.join(runsDir, runId, "state.json"), "utf8"));
  assert.equal(state.steerCount, 1);
  assert.equal(state.steeringLog[0].source, "console");
  assert.equal(state.steeringLog[0].message, "use tabs not spaces");
  const events = fs.readFileSync(path.join(runsDir, runId, "events.jsonl"), "utf8");
  assert.match(events, /steering_delivered/);
  const report = fs.readFileSync(path.join(fleetDir, "reports", `${runId}.md`), "utf8");
  assert.match(report, /## Steering received/);
  assert.match(report, /use tabs not spaces/);
}, { timeout: 60_000 });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/monitor-control.test.mjs`
Expected: FAIL (`steering_delivered` never recorded — monitor has no control watcher)

- [ ] **Step 3: Add the control watcher to src/monitor.mjs**

Insert after the `setTimeout` prompt block, before the `SIGTERM` handler:

```js
  const controlPath = path.join(runDir, "control.jsonl");
  let controlOffset = 0;
  try { controlOffset = fsSync.statSync(controlPath).size; } catch {}
  const controlTimer = setInterval(() => {
    let size = 0;
    try { size = fsSync.statSync(controlPath).size; } catch { return; }
    if (size <= controlOffset) return;
    const fd = fsSync.openSync(controlPath, "r");
    try {
      const buf = Buffer.alloc(size - controlOffset);
      fsSync.readSync(fd, buf, 0, buf.length, controlOffset);
      controlOffset = size;
      for (const raw of buf.toString("utf8").split("\n")) {
        if (!raw.trim()) continue;
        const parsed = parseLineSafe(raw);
        if (parsed.ok) handleControl(parsed.value);
      }
    } finally {
      fsSync.closeSync(fd);
    }
  }, 300);

  function handleControl(msg) {
    if (msg.type === "steer" || msg.type === "follow_up") {
      if (settledHandled) return;
      try {
        child.stdin.write(JSON.stringify({ type: msg.type, message: msg.message }) + "\n");
      } catch { return; }
      const source = msg.source ?? "unknown";
      writeEvent({ type: "steering_delivered", source, message: msg.message });
      recordSteering(state, { source, message: msg.message, ts: nowIso() });
      dirty = true;
      flushNow().catch(() => {});
    } else if (msg.type === "abort") {
      writeEvent({ type: "abort_requested" });
      pendingAbort = true;
      try { child.stdin.write(JSON.stringify({ type: "abort" }) + "\n"); } catch {}
    }
  }
```

Also update the import line to include `recordSteering`:

```js
import { loadState, saveState, recordToolActivity, recordSteering } from "./state.mjs";
```

And clear `controlTimer` in the close handler:

```js
    child.on("close", async () => {
      clearInterval(flusher);
      clearInterval(controlTimer);
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/monitor-control.test.mjs tests/monitor.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/monitor.mjs tests/monitor-control.test.mjs
git commit -m "feat: monitor control channel — steer/followup/abort with provenance recording"
```

---

### Task 8: read commands — status, wait, output, logs

**Files:**

- Modify: `src/commands.mjs` (add `cmdStatus`, `cmdWait`, `cmdOutput`, `cmdLogs`), `src/cli.mjs` (register)
- Test: `tests/commands.test.mjs`

**Interfaces:**

- Consumes: `state.mjs` (`listRuns`, `findRun`, `loadState`, `deriveStatus`, `TERMINAL_STATES`, `runDirFor`), `util.mjs` (`readJsonlTail`, `tailText`, `firstLine`, `formatAge`, `parseCommandArgs`), `spawn.mjs` (`resolveFleetDir`)
- Produces:
  - Shared helper in commands.mjs: `resolveRun(argv, { flags = [], string = [] })` → `{ options, positionals, run, runDir, state }` — parses args with `--cwd` added to `string`, calls `resolveFleetDir(options.cwd)`, `findRun(piFleetDir, positionals[0])`
  - `cmdStatus(argv)` — one run: pretty JSON of full state (with derived status); no positional: table `NAME STATE LAST-ACTIVITY LAST-TOOL STEERED AGE`, archived hidden unless `--all`, `--json` prints array of states
  - `cmdWait(argv)` — polls every 2s until `deriveStatus(state) ∈ TERMINAL_STATES` or `--timeout` (string option, seconds, default 600); prints one final line `"<name> <status>"`; exit 0 settled / 3 timeout / 4 stopped|error|dead
  - `cmdOutput(argv)` — `--tail <n>` prints last n `tool_execution_end` events as `toolName: firstLine(result text)`; default prints `state.lastAssistantText` or `(no output yet)`
  - `cmdLogs(argv)` — prints last `--tail <n>` (default 50) lines of `rpc.log`
  - Result-text helper `resultTextOf(ev)` → text of `ev.result?.content` (also used by Task 12 console)

- [ ] **Step 1: Write failing tests**

`tests/commands.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "pi-fleet.mjs");
const FAKE_PI = path.join(ROOT, "tests", "fixtures", "fake-pi.mjs");
const FAST_ENV = {
  ...process.env,
  PI_FLEET_PI_BIN: `${process.execPath} ${FAKE_PI}`,
  FAKE_PI_DELAY_MS: "200",
};

function initRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

async function settledRun(prefix) {
  const root = initRepo(prefix);
  await run(process.execPath, [BIN, "spawn", "worker", "--cwd", root, "--no-worktree", "--", "task"], { env: FAST_ENV });
  await run(process.execPath, [BIN, "wait", "worker", "--cwd", root, "--timeout", "30"], { env: FAST_ENV });
  return root;
}

test("status table + --json", async () => {
  const root = await settledRun("pf-cmd-1-");
  const table = await run(process.execPath, [BIN, "status", "--cwd", root], { env: FAST_ENV });
  assert.match(table.stdout, /NAME/);
  assert.match(table.stdout, /worker/);
  const json = JSON.parse((await run(process.execPath, [BIN, "status", "--cwd", root, "--json"], { env: FAST_ENV })).stdout);
  assert.equal(json[0].name, "worker");
  assert.equal(json[0].status, "settled");
});

test("output prints last assistant text; --tail prints tool trail", async () => {
  const root = await settledRun("pf-cmd-2-");
  const out = await run(process.execPath, [BIN, "output", "worker", "--cwd", root], { env: FAST_ENV });
  assert.equal(out.stdout.trim(), "Working: wrote hello.txt");
  const trail = await run(process.execPath, [BIN, "output", "worker", "--cwd", root, "--tail", "5"], { env: FAST_ENV });
  assert.match(trail.stdout, /bash/);
});

test("wait timeout exits 3; terminal failure exits 4", async () => {
  const root = initRepo("pf-cmd-3-");
  await run(process.execPath, [BIN, "spawn", "slow", "--cwd", root, "--no-worktree", "--", "task"], {
    env: { ...FAST_ENV, FAKE_PI_DELAY_MS: "20000" },
  });
  const t = await run(process.execPath, [BIN, "wait", "slow", "--cwd", root, "--timeout", "1"], { env: FAST_ENV })
    .then(() => 0).catch((e) => e.code);
  assert.equal(t, 3);
  // stop it for cleanup
  await run(process.execPath, [BIN, "stop", "slow", "--cwd", root], { env: FAST_ENV }).catch(() => {});
  const s = await run(process.execPath, [BIN, "wait", "slow", "--cwd", root, "--timeout", "15"], { env: FAST_ENV })
    .then(() => 0).catch((e) => e.code);
  assert.equal(s, 4);
}, { timeout: 60_000 });

test("logs tails rpc.log", async () => {
  const root = await settledRun("pf-cmd-4-");
  const logs = await run(process.execPath, [BIN, "logs", "worker", "--cwd", root, "--tail", "10"], { env: FAST_ENV });
  assert.match(logs.stdout, /agent_start|turn_end|prompt/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/commands.test.mjs`
Expected: FAIL (`status` falls through to usage → exit 1)

- [ ] **Step 3: Implement the four commands**

Append to `src/commands.mjs`:

```js
import {
  listRuns, findRun, loadState, deriveStatus, runDirFor, TERMINAL_STATES,
} from "./state.mjs";
import { resolveFleetDir } from "./spawn.mjs";
import { readJsonlTail, tailText, firstLine, formatAge, parseCommandArgs } from "./util.mjs";

async function resolveRun(argv, { flags = [], string = [] } = {}) {
  const { options, positionals } = parseCommandArgs(argv, { flags, string: ["cwd", ...string] });
  const { piFleetDir } = await resolveFleetDir(options.cwd);
  const run = findRun(piFleetDir, positionals[0]);
  return { options, positionals, run, piFleetDir };
}

export function resultTextOf(ev) {
  const content = ev?.result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c.text ?? "").join("");
}

const pad = (s, n) => String(s ?? "").padEnd(n);

export async function cmdStatus(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    flags: ["json", "all"],
    string: ["cwd"],
  });
  const { piFleetDir } = await resolveFleetDir(options.cwd);
  if (positionals[0]) {
    const { run } = findRun(piFleetDir, positionals[0]);
    run.status = deriveStatus(run);
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }
  const runs = listRuns(piFleetDir)
    .map(({ runId, runDir }) => {
      try { return { runId, state: loadStateSync(runDir) }; } catch { return null; }
    })
    .filter(Boolean)
    .filter((r) => options.all || r.state.status !== "archived");
  if (options.json) {
    console.log(JSON.stringify(runs.map((r) => ({ ...r.state, status: deriveStatus(r.state) })), null, 2));
    return 0;
  }
  console.log(`${pad("NAME", 20)}${pad("STATE", 10)}${pad("LAST-ACTIVITY", 22)}${pad("LAST-TOOL", 12)}${pad("STEERED", 8)}AGE`);
  for (const { state } of runs) {
    const derived = deriveStatus(state);
    const age = formatAge(Date.now() - new Date(state.createdAt).getTime());
    console.log(
      `${pad(state.name, 20)}${pad(derived, 10)}${pad(state.lastActivity ?? "-", 22)}${pad(state.lastTool ?? "-", 12)}${pad(state.steerCount, 8)}${age}`
    );
  }
  return 0;
}

import fsSync0 from "node:fs";
function loadStateSync(runDir) {
  return JSON.parse(fsSync0.readFileSync(runDir + "/state.json", "utf8"));
}

export async function cmdWait(argv) {
  const { options } = await (async () => {
    const parsed = parseCommandArgs(argv, { flags: [], string: ["cwd", "timeout"] });
    return { options: parsed.options, positionals: parsed.positionals };
  })();
  const { positionals } = parseCommandArgs(argv, { string: ["cwd", "timeout"] });
  const { piFleetDir } = await resolveFleetDir(options.cwd);
  const run = findRun(piFleetDir, positionals[0]);
  const timeoutMs = (Number(options.timeout) || 600) * 1000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let state;
    try { state = await loadState(run.runDir); } catch { state = null; }
    if (state) {
      const derived = deriveStatus(state);
      if (TERMINAL_STATES.includes(derived)) {
        console.log(`${state.name} ${derived}`);
        if (derived === "settled") return 0;
        if (derived === "archived") return 0;
        return 4;
      }
    }
    if (Date.now() > deadline) {
      console.error(`wait: timed out after ${options.timeout ?? 600}s waiting for ${run.state.name}`);
      return 3;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function cmdOutput(argv) {
  const { options, run } = await resolveRun(argv, { string: ["tail"] });
  if (options.tail) {
    const events = await readJsonlTail(run.runDir + "/events.jsonl", 2000);
    const ends = events.filter((e) => e.type === "tool_execution_end").slice(-Number(options.tail));
    for (const ev of ends) {
      console.log(`${ev.toolName}: ${firstLine(resultTextOf(ev))}`);
    }
    return 0;
  }
  console.log(run.state.lastAssistantText ?? "(no output yet)");
  return 0;
}

export async function cmdLogs(argv) {
  const { options, run } = await resolveRun(argv, { string: ["tail"] });
  const text = await tailText(run.runDir + "/rpc.log", Number(options.tail) || 50);
  if (text) process.stdout.write(text + "\n");
  else console.log("(no rpc.log yet)");
  return 0;
}
```

Simplify `cmdWait`'s awkward double-parse — replace its first three lines with:

```js
export async function cmdWait(argv) {
  const { options, positionals } = parseCommandArgs(argv, { string: ["cwd", "timeout"] });
  const { piFleetDir } = await resolveFleetDir(options.cwd);
  const run = findRun(piFleetDir, positionals[0]);
```

Register in `src/cli.mjs`:

```js
import {
  cmdSpawn, cmdStatus, cmdWait, cmdOutput, cmdLogs,
} from "./commands.mjs";

const COMMANDS = new Map([
  ["help", () => { console.log(USAGE); return 0; }],
  ["spawn", cmdSpawn],
  ["status", cmdStatus],
  ["wait", cmdWait],
  ["output", cmdOutput],
  ["logs", cmdLogs],
  ["__monitor", async (argv) => {
    const { runMonitor } = await import("./monitor.mjs");
    return runMonitor({ piFleetDir: argv[0], runId: argv[1] });
  }],
]);
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/commands.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/commands.mjs src/cli.mjs tests/commands.test.mjs
git commit -m "feat: status/wait/output/logs commands with machine-readable exit codes"
```

---

### Task 9: write commands — send, followup, stop

**Files:**

- Modify: `src/commands.mjs` (add `cmdSend`, `cmdFollowup`, `cmdStop`), `src/cli.mjs` (register)
- Test: `tests/commands-write.test.mjs`

**Interfaces:**

- Consumes: `resolveRun` helper (Task 8), `appendControl` (state.mjs), `deriveStatus`, `TERMINAL_STATES`
- Produces:
  - `cmdSend(argv)` — brief required; refuses (exit 1, guidance printed) when `deriveStatus(state) ∈ TERMINAL_STATES`; else appends `{type:"steer", message: brief, source:"orchestrator"}` to control.jsonl, prints confirmation, exit 0
  - `cmdFollowup(argv)` — same with `type:"follow_up"`
  - `cmdStop(argv)` — refuses if already terminal (exit 1); appends `{type:"abort", source:"orchestrator"}` (message null), prints `abort requested`, exit 0

- [ ] **Step 1: Write failing tests**

`tests/commands-write.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "pi-fleet.mjs");
const FAKE_PI = path.join(ROOT, "tests", "fixtures", "fake-pi.mjs");
const FAST_ENV = {
  ...process.env,
  PI_FLEET_PI_BIN: `${process.execPath} ${FAKE_PI}`,
  FAKE_PI_DELAY_MS: "200",
};

function initRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

test("send to settled run refuses with guidance (exit 1)", async () => {
  const root = initRepo("pf-wr-1-");
  await run(process.execPath, [BIN, "spawn", "w", "--cwd", root, "--no-worktree", "--", "t"], { env: FAST_ENV });
  await run(process.execPath, [BIN, "wait", "w", "--cwd", root, "--timeout", "30"], { env: FAST_ENV });
  const code = await run(process.execPath, [BIN, "send", "w", "--cwd", root, "--", "try again"], { env: FAST_ENV })
    .then(() => 0).catch((e) => e.code);
  assert.equal(code, 1);
});

test("send to running run accepts; followup queued; stop aborts", async () => {
  const root = initRepo("pf-wr-2-");
  await run(process.execPath, [BIN, "spawn", "w", "--cwd", root, "--no-worktree", "--", "t"], {
    env: { ...FAST_ENV, FAKE_PI_DELAY_MS: "20000" },
  });
  // wait until running
  const fleetDir = path.join(fs.realpathSync(root), ".pi-fleet");
  let runId;
  for (let i = 0; i < 50 && !runId; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const e = fs.readdirSync(path.join(fleetDir, "runs"));
    if (e[0] && JSON.parse(fs.readFileSync(path.join(fleetDir, "runs", e[0], "state.json"), "utf8")).status === "running") runId = e[0];
  }
  assert.ok(runId);
  await run(process.execPath, [BIN, "send", "w", "--cwd", root, "--", "use tabs"], { env: FAST_ENV });
  await run(process.execPath, [BIN, "followup", "w", "--cwd", root, "--", "then summarize"], { env: FAST_ENV });
  const control = fs.readFileSync(path.join(fleetDir, "runs", runId, "control.jsonl"), "utf8");
  assert.match(control, /"steer"/);
  assert.match(control, /"follow_up"/);
  assert.match(control, /orchestrator/);
  await run(process.execPath, [BIN, "stop", "w", "--cwd", root], { env: FAST_ENV });
  const stopped = await run(process.execPath, [BIN, "wait", "w", "--cwd", root, "--timeout", "15"], { env: FAST_ENV })
    .then(() => 0).catch((e) => e.code);
  assert.equal(stopped, 4);
  const state = JSON.parse(fs.readFileSync(path.join(fleetDir, "runs", runId, "state.json"), "utf8"));
  assert.equal(state.status, "stopped");
}, { timeout: 60_000 });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/commands-write.test.mjs`
Expected: FAIL (send/followup/stop fall through to usage → exit 1)

- [ ] **Step 3: Implement**

Append to `src/commands.mjs`:

```js
import { appendControl } from "./state.mjs";

async function controlCommand(argv, type, message) {
  const { positionals, run } = await resolveRun(argv, {});
  if (!positionals[0]) throw new Error(`${type}: <name> required`);
  const derived = deriveStatus(run.state);
  if (TERMINAL_STATES.includes(derived)) {
    console.error(
      `${type}: run ${run.state.name} is ${derived} — steering refused.\n` +
      `Resume with: pi-fleet spawn ${run.state.name}-2 --session <session-path> -- "<new brief>"`
    );
    return 1;
  }
  await appendControl(run.runDir, { type, message, source: "orchestrator" });
  console.log(`${type} delivered to ${run.state.name}`);
  return 0;
}

export async function cmdSend(argv) {
  const { brief } = parseCommandArgs(argv, { string: ["cwd"] });
  if (brief === null || brief.trim() === "") throw new Error('send: message required after "--"');
  return controlCommand(argv, "steer", brief);
}

export async function cmdFollowup(argv) {
  const { brief } = parseCommandArgs(argv, { string: ["cwd"] });
  if (brief === null || brief.trim() === "") throw new Error('followup: message required after "--"');
  return controlCommand(argv, "follow_up", brief);
}

export async function cmdStop(argv) {
  return controlCommand(argv, "abort", null);
}
```

Note: `parseCommandArgs` here only extracts `brief`; `controlCommand` re-parses via `resolveRun` — harmless duplication, keep it.

Register in cli.mjs:

```js
import {
  cmdSpawn, cmdStatus, cmdWait, cmdOutput, cmdLogs,
  cmdSend, cmdFollowup, cmdStop,
} from "./commands.mjs";

// inside COMMANDS map:
  ["send", cmdSend],
  ["followup", cmdFollowup],
  ["stop", cmdStop],
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/commands-write.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/commands.mjs src/cli.mjs tests/commands-write.test.mjs
git commit -m "feat: send/followup/stop — steering with refusals and orchestrator provenance"
```

---

### Task 10: report.mjs — report lookup, steering-log appendix, report command

**Files:**

- Create: `src/report.mjs`
- Modify: `src/commands.mjs` (add `cmdReport`), `src/cli.mjs` (register)
- Test: `tests/report.test.mjs`

**Interfaces:**

- Consumes: `resolveRun` (Task 8), `recordSteering` (Task 3, to build fixtures)
- Produces:
  - `reportPath(piFleetDir, runId)` → `<piFleetDir>/reports/<runId>.md`
  - `buildSteeringAppendix(state)` → `""` when `steerCount === 0`, else `"\n---\n## Steering log (orchestrator-side, most recent last)\n" + one \"- [source] ts message\" line per steeringLog entry`
  - `readReport(piFleetDir, state)` → `{ kind: "report"|"fallback"|"missing", text }` — report file if present; else lastAssistantText prefixed with `[No report file — falling back to last assistant text]`; else missing
  - `cmdReport(argv)` — prints report (or fallback) + steering appendix; exit 0, or exit 2 when kind is `missing`

- [ ] **Step 1: Write failing tests**

`tests/report.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  resolveFleetDir, createRun,
} from "../src/spawn.mjs";
import { saveState, loadState, recordSteering } from "../src/state.mjs";
import { buildSteeringAppendix, readReport, reportPath } from "../src/report.mjs";

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "pi-fleet.mjs");

async function fixtureRun(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); // not a git repo → in-place
  const { runId, runDir, piFleetDir, state } = await createRun({
    name: "auth", opts: { cwd: dir, worktree: false }, brief: "b",
  });
  return { dir, runId, runDir, piFleetDir, state };
}

test("buildSteeringAppendix empty when no steering, lines otherwise", () => {
  const state = { steerCount: 0, steeringLog: [] };
  assert.equal(buildSteeringAppendix(state), "");
  const s2 = { steerCount: 2, steeringLog: [
    { source: "orchestrator", ts: "t1", message: "first" },
    { source: "console", ts: "t2", message: "second" },
  ] };
  const a = buildSteeringAppendix(s2);
  assert.match(a, /## Steering log/);
  assert.match(a, /\\[orchestrator\\] t1 first/);
  assert.match(a, /\\[console\\] t2 second/);
});

test("readReport: report file wins; fallback uses lastAssistantText; missing flagged", async () => {
  const f = await fixtureRun("pf-rep-1-");
  fs.writeFileSync(reportPath(f.piFleetDir, f.runId), "# Fleet Report\n## Status\ndone\n");
  assert.equal(readReport(f.piFleetDir, f.state).kind, "report");

  fs.unlinkSync(reportPath(f.piFleetDir, f.runId));
  f.state.lastAssistantText = "some final text";
  const fb = readReport(f.piFleetDir, f.state);
  assert.equal(fb.kind, "fallback");
  assert.match(fb.text, /falling back/);

  f.state.lastAssistantText = null;
  assert.equal(readReport(f.piFleetDir, f.state).kind, "missing");
});

test("CLI report: prints report + steering appendix; exit 2 when missing", async () => {
  const f = await fixtureRun("pf-rep-2-");
  fs.writeFileSync(reportPath(f.piFleetDir, f.runId), "## Status\ndone\n");
  f.state.steerCount = 1;
  f.state.steeringLog = [{ source: "console", ts: "t", message: "use tabs" }];
  await saveState(f.runDir, f.state);

  const out = await run(process.execPath, [BIN, "report", "auth", "--cwd", f.dir], { env: process.env });
  assert.match(out.stdout, /## Status/);
  assert.match(out.stdout, /use tabs/);
  assert.match(out.stdout, /Steering log/);

  fs.unlinkSync(reportPath(f.piFleetDir, f.runId));
  const code = await run(process.execPath, [BIN, "report", "auth", "--cwd", f.dir], { env: process.env })
    .then(() => 0).catch((e) => e.code);
  assert.equal(code, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/report.test.mjs`
Expected: FAIL (report.mjs missing)

- [ ] **Step 3: Implement src/report.mjs**

```js
import fsSync from "node:fs";
import path from "node:path";

export function reportPath(piFleetDir, runId) {
  return path.join(piFleetDir, "reports", `${runId}.md`);
}

export function buildSteeringAppendix(state) {
  if (!state.steerCount || !state.steeringLog || state.steeringLog.length === 0) return "";
  const lines = state.steeringLog.map((s) => `- [${s.source}] ${s.ts} ${s.message}`);
  return `\n---\n## Steering log (orchestrator-side, most recent last)\n${lines.join("\n")}\n`;
}

export function readReport(piFleetDir, state) {
  const p = reportPath(piFleetDir, state.id);
  if (fsSync.existsSync(p)) {
    return { kind: "report", text: fsSync.readFileSync(p, "utf8") };
  }
  if (state.lastAssistantText) {
    return {
      kind: "fallback",
      text: `[No report file — falling back to last assistant text]\n\n${state.lastAssistantText}`,
    };
  }
  return { kind: "missing", text: null };
}
```

- [ ] **Step 4: Add cmdReport and register**

Append to `src/commands.mjs`:

```js
import { readReport, buildSteeringAppendix } from "./report.mjs";

export async function cmdReport(argv) {
  const { run, piFleetDir } = await resolveRun(argv, {});
  const { kind, text } = readReport(piFleetDir, run.state);
  if (kind === "missing") {
    console.error(`report: no report file and no captured output for ${run.state.name}`);
    return 2;
  }
  console.log(text);
  const appendix = buildSteeringAppendix(run.state);
  if (appendix) console.log(appendix);
  return 0;
}
```

Register in cli.mjs: `["report", cmdReport]` (import it from commands.mjs).

- [ ] **Step 5: Run tests**

Run: `node --test tests/report.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/report.mjs src/commands.mjs src/cli.mjs tests/report.test.mjs
git commit -m "feat: report command — report lookup, fallback, steering-log appendix"
```

---

### Task 11: git ops — diff, merge, cleanup

**Files:**

- Modify: `src/commands.mjs` (add `cmdDiff`, `cmdMerge`, `cmdCleanup`), `src/cli.mjs` (register)
- Test: `tests/gitops.test.mjs`

**Interfaces:**

- Consumes: `resolveRun`, `worktree.mjs` (`git`, `removeWorktree`, `isGitRepo`), `state.mjs` (`listRuns`, `TERMINAL_STATES`, `appendControl`)
- Produces:
  - `cmdDiff(argv)` — non-worktree run: prints `not applicable (no worktree — run has no isolated worktree)`, exit 0. Worktree run: `git -C <worktree> diff --stat <base>...HEAD` (or `--name-only` with the flag), prints stdout, exit 0
  - `cmdMerge(argv)` — guardrails: run must be `settled` (refuse otherwise, exit 1, print current status); orchestrating cwd (`process.cwd()`) must be a git repo and must NOT be inside the worker's worktree (both exit 1 with reasons); runs `git merge <branch>` (`--no-commit --no-ff` when `--no-commit`); on non-zero exit prints conflicted files (`git diff --name-only --diff-filter=U`) and exits 5; success prints summary, exit 0
  - `cmdCleanup(argv)` — target `<name|all>`; per run: if not in `TERMINAL_STATES` and no `--force` → single-target refusal exit 1 (with `--force` on a running run: best-effort abort control line first); removes worktree + branch via `removeWorktree` (force deletes unmerged branch), sets `status:"archived"`, keeps reports/events; `all` archives every run it can and warns (stderr) on running ones, exit 0

- [ ] **Step 1: Write failing tests**

`tests/gitops.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "pi-fleet.mjs");
const FAKE_PI = path.join(ROOT, "tests", "fixtures", "fake-pi.mjs");
const HELLO_ENV = {
  ...process.env,
  PI_FLEET_PI_BIN: `${process.execPath} ${FAKE_PI}`,
  FAKE_PI_DELAY_MS: "200",
  FAKE_PI_WRITE_HELLO: "1",
};

function initRepo(prefix, seedHello = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  if (seedHello) fs.writeFileSync(path.join(root, "hello.txt"), "parent version\n");
  else fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

async function settledRun(prefix, env = HELLO_ENV) {
  const root = initRepo(prefix);
  await run(process.execPath, [BIN, "spawn", "worker", "--cwd", root, "--", "task"], { env });
  await run(process.execPath, [BIN, "wait", "worker", "--cwd", root, "--timeout", "30"], { env });
  return root;
}

test("diff shows worker changes; merge brings them into parent; cleanup archives", async () => {
  const root = await settledRun("pf-git-1-");
  const diff = await run(process.execPath, [BIN, "diff", "worker"], { env: process.env, cwd: root });
  assert.match(diff.stdout, /hello.txt/);

  await run(process.execPath, [BIN, "merge", "worker"], { env: process.env, cwd: root });
  assert.equal(fs.readFileSync(path.join(root, "hello.txt"), "utf8"), "hi\n");

  await run(process.execPath, [BIN, "cleanup", "worker"], { env: process.env, cwd: root });
  const fleetDir = path.join(fs.realpathSync(root), ".pi-fleet");
  const runId = fs.readdirSync(path.join(fleetDir, "runs"))[0];
  const state = JSON.parse(fs.readFileSync(path.join(fleetDir, "runs", runId, "state.json"), "utf8"));
  assert.equal(state.status, "archived");
  const worktreeGone = !fs.existsSync(state.worktree);
  assert.equal(worktreeGone, true);
  const branchList = execFileSync("git", ["branch", "--list", state.branch], { cwd: root }).toString().trim();
  assert.equal(branchList, "");
  // report survives cleanup (audit trail)
  assert.equal(fs.existsSync(path.join(fleetDir, "reports", `${runId}.md`)), true);
}, { timeout: 60_000 });

test("merge refuses non-settled runs (error state)", async () => {
  const root = initRepo("pf-git-2-");
  await run(process.execPath, [BIN, "spawn", "boom", "--cwd", root, "--", "x"], {
    env: { ...process.env, PI_FLEET_PI_BIN: "/bin/false" },
  });
  await run(process.execPath, [BIN, "wait", "boom", "--cwd", root, "--timeout", "20"], { env: {} }).catch(() => {});
  const code = await run(process.execPath, [BIN, "merge", "boom"], { env: process.env, cwd: root })
    .then(() => 0).catch((e) => e.code);
  assert.equal(code, 1);
}, { timeout: 60_000 });

test("merge conflict exits 5 with file list", async () => {
  const root = initRepo("pf-git-3-", true); // parent already has hello.txt "parent version"
  await run(process.execPath, [BIN, "spawn", "worker", "--cwd", root, "--", "task"], { env: HELLO_ENV });
  await run(process.execPath, [BIN, "wait", "worker", "--cwd", root, "--timeout", "30"], { env: HELLO_ENV });
  const code = await run(process.execPath, [BIN, "merge", "worker"], { env: process.env, cwd: root })
    .then(() => 0).catch((e) => e.code);
  assert.equal(code, 5);
  // resolve by aborting the merge so the repo is clean for later assertions
  execFileSync("git", ["merge", "--abort"], { cwd: root });
  await run(process.execPath, [BIN, "cleanup", "worker", "--force"], { env: process.env, cwd: root });
}, { timeout: 60_000 });

test("cleanup refuses running run without --force; works with it", async () => {
  const root = initRepo("pf-git-4-");
  await run(process.execPath, [BIN, "spawn", "slow", "--cwd", root, "--no-worktree", "--", "t"], {
    env: { ...HELLO_ENV, FAKE_PI_DELAY_MS: "20000" },
  });
  const code = await run(process.execPath, [BIN, "cleanup", "slow"], { env: process.env, cwd: root })
    .then(() => 0).catch((e) => e.code);
  assert.equal(code, 1);
  await run(process.execPath, [BIN, "cleanup", "slow", "--force"], { env: process.env, cwd: root });
  const fleetDir = path.join(fs.realpathSync(root), ".pi-fleet");
  const runId = fs.readdirSync(path.join(fleetDir, "runs"))[0];
  const state = JSON.parse(fs.readFileSync(path.join(fleetDir, "runs", runId, "state.json"), "utf8"));
  assert.equal(state.status, "archived");
}, { timeout: 60_000 });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gitops.test.mjs`
Expected: FAIL (diff/merge/cleanup fall through to usage → exit 1)

- [ ] **Step 3: Implement**

Append to `src/commands.mjs`:

```js
import { git, isGitRepo, removeWorktree } from "./worktree.mjs";

export async function cmdDiff(argv) {
  const { options, run } = await resolveRun(argv, { flags: ["name-only"] });
  if (!run.state.worktree) {
    console.log("not applicable (no worktree — run has no isolated worktree)");
    return 0;
  }
  const args = ["-C", run.state.worktree, "diff"];
  args.push(options["name-only"] ? "--name-only" : "--stat");
  args.push(`${run.state.base ?? "HEAD"}...HEAD`);
  const r = await git(args);
  if (r.stdout) process.stdout.write(r.stdout);
  return 0;
}

export async function cmdMerge(argv) {
  const { options, run } = await resolveRun(argv, { flags: ["no-commit"] });
  const derived = deriveStatus(run.state);
  if (derived !== "settled") {
    console.error(`merge: run ${run.state.name} is ${derived} — only settled runs can be merged.`);
    return 1;
  }
  if (!run.state.branch) {
    console.error(`merge: run ${run.state.name} has no branch (spawned without worktree).`);
    return 1;
  }
  const cwd = process.cwd();
  if (!(await isGitRepo(cwd))) {
    console.error(`merge: ${cwd} is not a git repo — run this from the orchestrating checkout.`);
    return 1;
  }
  const cwdRoot = (await repoRoot(cwd)) ?? "";
  if (run.state.worktree && (cwdRoot === run.state.worktree || cwdRoot.startsWith(run.state.worktree + path.sep))) {
    console.error("merge: refusing to merge into the worker's own worktree — run from the parent checkout.");
    return 1;
  }
  const args = ["merge", ...(options["no-commit"] ? ["--no-commit", "--no-ff"] : []), run.state.branch];
  const r = await git(args, cwd);
  if (r.code !== 0) {
    const conflicts = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
    console.error(`merge: conflicts — resolve these files, then commit:\n${conflicts.stdout}`);
    return 5;
  }
  console.log(`merged ${run.state.branch}${options["no-commit"] ? " (staged, not committed)" : ""}`);
  console.log("Run integration checks before cleanup.");
  return 0;
}

export async function cmdCleanup(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    flags: ["force"],
    string: ["cwd"],
  });
  const { piFleetDir } = await resolveFleetDir(options.cwd);
  const target = positionals[0];
  if (!target) throw new Error("cleanup: <name|all> required");

  const targets = target === "all"
    ? listRuns(piFleetDir).map((r) => ({ runId: r.runId, runDir: r.runDir, state: loadStateSync(r.runDir) }))
    : [(() => { const f = findRun(piFleetDir, target); return { runId: f.runId, runDir: f.runDir, state: f.state }; })()];

  let refused = false;
  for (const t of targets) {
    const derived = deriveStatus(t.state);
    if (!TERMINAL_STATES.includes(derived)) {
      if (options.force) {
        try { await appendControl(t.runDir, { type: "abort", message: null, source: "orchestrator" }); } catch {}
        await new Promise((r) => setTimeout(r, 500));
      } else {
        if (target !== "all") {
          console.error(`cleanup: run ${t.state.name} is ${derived} — use --force to abort and clean.`);
          refused = true;
          continue;
        }
        console.error(`cleanup: skipping ${t.state.name} (${derived}) — running; use --force`);
        continue;
      }
    }
    if (t.state.worktree && t.state.repoRoot) {
      await removeWorktree({
        repoRoot: t.state.repoRoot,
        worktreePath: t.state.worktree,
        branch: t.state.branch,
        force: Boolean(options.force),
      });
    }
    t.state.status = "archived";
    await saveState(t.runDir, t.state);
    console.log(`archived ${t.runId}`);
  }
  return refused ? 1 : 0;
}
```

Add `repoRoot` to the worktree.mjs import and `saveState` to the state import in commands.mjs:

```js
import { git, isGitRepo, repoRoot, removeWorktree } from "./worktree.mjs";
import {
  listRuns, findRun, loadState, loadStateSync, saveState, deriveStatus, runDirFor,
  TERMINAL_STATES, appendControl,
} from "./state.mjs";
```

Register in cli.mjs: `["diff", cmdDiff]`, `["merge", cmdMerge]`, `["cleanup", cmdCleanup]`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/gitops.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/commands.mjs src/cli.mjs tests/gitops.test.mjs
git commit -m "feat: diff/merge/cleanup — reviewed integration with conflict exit codes"
```

---

### Task 12: Console transcript model — events.jsonl → display lines (pure)

**Files:**

- Create: `src/console/transcript.ts`
- Test: `tests/console-transcript.test.ts`

**Interfaces:**

- Consumes: `util.ts` (`splitJsonLines`, `parseLineSafe`, `firstLine`, `resultTextOf`); the `events.jsonl` shapes written by the monitor (Tasks 6–7): fleet events `task_prompt {brief}`, `steering_delivered {source, message}`, `abort_requested`, and RPC events — note the monitor stores `message_update` as `{ type: "message_update", ev: { type, contentIndex, delta, content } }`
- Produces (Task 13 renders these):
  - `type LineKind = "steer" | "text" | "tool" | "tool_result" | "system"`; `interface TranscriptLine { kind: LineKind; text: string }`
  - `interface Transcript { lines: TranscriptLine[]; open: Map<number, string> }` — `open` holds in-flight streamed text per `contentIndex`
  - `createTranscript(): Transcript`, `applyEvent(t, ev): void`, `partialText(t): string | null`
  - `summarizeArgs(args: unknown): string` — first line of `command`/`path`/`file_path`/`pattern`/`url` (else JSON), clipped to 80 chars
  - `readNewEvents(filePath, offset): { events: any[]; offset: number }` — reads complete lines appended after byte `offset`; the returned offset always points just past the last `\n` (a partial trailing line is re-read next time)
  - `replay(filePath, keepLines): { transcript: Transcript; offset: number }` — full read, keeps the last `keepLines` lines

Rendering rules (spec §4.5): steering/user → `▶ <source>: <message>` (the task brief renders as `▶ task: <first line>`); assistant text → one line per non-empty line of the completed block; tool start → `⚙ <toolName> <args summary>`; tool end → `  ↳ <first line of result>` (or `(error)` / `(no output)`); `agent_settled` → `● settled`; `abort_requested` → `■ abort requested`; `extension_error` → `! extension error: …`; `auto_retry_start` → `↻ retry a/b`; `compaction_start` → `⌁ compacting context`. Every other event type is ignored.

- [ ] **Step 1: Write failing tests**

`tests/console-transcript.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createTranscript, applyEvent, partialText, summarizeArgs, readNewEvents, replay,
} from "../src/console/transcript.js";
import { tmpDir } from "./helpers.js";

const text = (t: ReturnType<typeof createTranscript>) => t.lines.map((l) => l.text);

test("applyEvent renders steering, tools, streamed text, and status markers", () => {
  const t = createTranscript();
  applyEvent(t, { type: "task_prompt", brief: "create hello.txt\nmore detail" });
  applyEvent(t, { type: "agent_start" });
  applyEvent(t, { type: "message_update", ev: { type: "text_start", contentIndex: 0 } });
  applyEvent(t, { type: "message_update", ev: { type: "text_delta", contentIndex: 0, delta: "Work" } });
  assert.equal(partialText(t), "Work");
  applyEvent(t, { type: "message_update", ev: { type: "text_delta", contentIndex: 0, delta: "ing\nline2" } });
  applyEvent(t, { type: "message_update", ev: { type: "text_end", contentIndex: 0, content: "Working\nline2" } });
  assert.equal(partialText(t), null);
  applyEvent(t, { type: "tool_execution_start", toolName: "bash", args: { command: "echo hi\necho there" } });
  applyEvent(t, { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "hi\nthere" }] } });
  applyEvent(t, { type: "tool_execution_end", toolName: "read", isError: true, result: { content: [] } });
  applyEvent(t, { type: "steering_delivered", source: "console", message: "use tabs" });
  applyEvent(t, { type: "abort_requested" });
  applyEvent(t, { type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
  applyEvent(t, { type: "compaction_start", reason: "threshold" });
  applyEvent(t, { type: "extension_error", error: "boom" });
  applyEvent(t, { type: "agent_settled" });
  assert.deepEqual(text(t), [
    "▶ task: create hello.txt",
    "Working",
    "line2",
    "⚙ bash echo hi",
    "  ↳ hi",
    "  ↳ (error)",
    "▶ console: use tabs",
    "■ abort requested",
    "↻ retry 1/3",
    "⌁ compacting context",
    "! extension error: boom",
    "● settled",
  ]);
  assert.equal(t.lines[0].kind, "steer");
  assert.equal(t.lines[3].kind, "tool");
  assert.equal(t.lines[4].kind, "tool_result");
  assert.equal(t.lines.at(-1)?.kind, "system");
});

test("applyEvent also accepts raw RPC message_update shape; text_end without content uses deltas", () => {
  const t = createTranscript();
  applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 2 } });
  applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "hey" } });
  applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 2 } });
  assert.deepEqual(text(t), ["hey"]);
});

test("summarizeArgs prefers command/path and clips long values", () => {
  assert.equal(summarizeArgs({ command: "ls -la" }), "ls -la");
  assert.equal(summarizeArgs({ path: "/a/b.ts", other: 1 }), "/a/b.ts");
  assert.equal(summarizeArgs({ x: 1 }), '{"x":1}');
  assert.equal(summarizeArgs(null), "");
  assert.equal(summarizeArgs({ command: "x".repeat(100) }).length, 80);
});

test("readNewEvents advances only past complete lines; replay keeps the tail", () => {
  const p = path.join(tmpDir("pf-tr-"), "events.jsonl");
  fs.writeFileSync(p, JSON.stringify({ type: "agent_settled" }) + "\n" + '{"type":"tool_execution_start","toolName":"ba');
  const first = readNewEvents(p, 0);
  assert.equal(first.events.length, 1);
  assert.equal(first.offset, Buffer.byteLength(JSON.stringify({ type: "agent_settled" }) + "\n"));
  fs.appendFileSync(p, 'sh","args":{"command":"é"}}\n');
  const second = readNewEvents(p, first.offset);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].toolName, "bash");
  assert.equal(second.offset, fs.statSync(p).size);
  assert.deepEqual(readNewEvents(p, second.offset), { events: [], offset: second.offset });
  assert.deepEqual(readNewEvents(path.join(p, "missing"), 0), { events: [], offset: 0 });

  for (let i = 0; i < 50; i++) fs.appendFileSync(p, JSON.stringify({ type: "steering_delivered", source: "s", message: `m${i}` }) + "\n");
  const { transcript, offset } = replay(p, 10);
  assert.equal(transcript.lines.length, 10);
  assert.equal(transcript.lines.at(-1)?.text, "▶ s: m49");
  assert.equal(offset, fs.statSync(p).size);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/console-transcript.test.ts`
Expected: FAIL (`Cannot find module '../src/console/transcript.js'`)

- [ ] **Step 3: Implement src/console/transcript.ts**

```ts
import fs from "node:fs";
import { firstLine, parseLineSafe, resultTextOf, splitJsonLines } from "../util.js";

export type LineKind = "steer" | "text" | "tool" | "tool_result" | "system";

export interface TranscriptLine {
  kind: LineKind;
  text: string;
}

export interface Transcript {
  lines: TranscriptLine[];
  /** in-flight streamed assistant text, keyed by contentIndex */
  open: Map<number, string>;
}

export function createTranscript(): Transcript {
  return { lines: [], open: new Map() };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const primary = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url;
  const raw = typeof primary === "string" ? primary : JSON.stringify(a);
  return clip(firstLine(raw), 80);
}

function push(t: Transcript, kind: LineKind, text: string): void {
  t.lines.push({ kind, text });
}

export function applyEvent(t: Transcript, ev: any): void {
  switch (ev?.type) {
    case "task_prompt":
      push(t, "steer", `▶ task: ${clip(firstLine(ev.brief ?? ""), 200)}`);
      return;
    case "steering_delivered":
      push(t, "steer", `▶ ${ev.source ?? "unknown"}: ${ev.message ?? ""}`);
      return;
    case "abort_requested":
      push(t, "system", "■ abort requested");
      return;
    case "message_update": {
      const a = ev.ev ?? ev.assistantMessageEvent;
      if (!a) return;
      const idx = Number(a.contentIndex ?? 0);
      if (a.type === "text_start") {
        t.open.set(idx, "");
      } else if (a.type === "text_delta") {
        t.open.set(idx, (t.open.get(idx) ?? "") + (a.delta ?? ""));
      } else if (a.type === "text_end") {
        const full = typeof a.content === "string" ? a.content : (t.open.get(idx) ?? "");
        t.open.delete(idx);
        for (const line of full.split("\n")) if (line.trim()) push(t, "text", line);
      }
      return;
    }
    case "tool_execution_start":
      push(t, "tool", `⚙ ${ev.toolName ?? "tool"} ${summarizeArgs(ev.args)}`.trimEnd());
      return;
    case "tool_execution_end": {
      const head = firstLine(resultTextOf(ev)) || (ev.isError ? "(error)" : "(no output)");
      push(t, "tool_result", `  ↳ ${clip(head, 120)}`);
      return;
    }
    case "agent_settled":
      push(t, "system", "● settled");
      return;
    case "extension_error":
      push(t, "system", `! extension error: ${clip(String(ev.error ?? ""), 120)}`);
      return;
    case "auto_retry_start":
      push(t, "system", `↻ retry ${ev.attempt}/${ev.maxAttempts}`);
      return;
    case "compaction_start":
      push(t, "system", "⌁ compacting context");
      return;
    default:
      return;
  }
}

export function partialText(t: Transcript): string | null {
  if (t.open.size === 0) return null;
  const joined = [...t.open.values()].join("");
  return joined.length > 0 ? joined : null;
}

export function readNewEvents(filePath: string, offset: number): { events: any[]; offset: number } {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { events: [], offset };
  }
  if (size <= offset) return { events: [], offset };
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return { events: [], offset };
  const complete = buf.subarray(0, lastNl + 1).toString("utf8");
  const events: any[] = [];
  for (const line of splitJsonLines(complete, "").lines) {
    if (!line.trim()) continue;
    const parsed = parseLineSafe(line);
    if (parsed.ok) events.push(parsed.value);
  }
  return { events, offset: offset + lastNl + 1 };
}

export function replay(filePath: string, keepLines: number): { transcript: Transcript; offset: number } {
  const transcript = createTranscript();
  const { events, offset } = readNewEvents(filePath, 0);
  for (const ev of events) applyEvent(transcript, ev);
  if (transcript.lines.length > keepLines) {
    transcript.lines.splice(0, transcript.lines.length - keepLines);
  }
  return { transcript, offset };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/console-transcript.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/console/transcript.ts tests/console-transcript.test.ts
git commit -m "feat: console transcript model — events.jsonl to display lines"
```

---

### Task 13: Console UI — `open` menu + `attach` live view (ink)

**Files:**

- Modify: `package.json` (deps), `tsconfig.json` (`jsx`), `src/cli.ts` (register `open`, `attach`)
- Create: `src/console/lock.ts`, `src/console/AttachView.tsx`, `src/console/OpenMenu.tsx`, `src/console/index.tsx`
- Test: `tests/console-lock.test.ts`, `tests/console-view.test.ts`, `tests/console-cli.test.ts`

**Interfaces:**

- Consumes: Task 12 (`replay`, `readNewEvents`, `applyEvent`, `partialText`, `Transcript`, `TranscriptLine`, `LineKind`), `state.ts` (`loadStateSync`, `deriveStatus`, `TERMINAL_STATES`, `appendControl`, `findRun`, `listRuns`, `RunState`, `RunRef`, `ControlType`), `spawn.ts` (`resolveFleetDir`), `util.ts` (`formatAge`, `nowIso`)
- Produces:
  - `lock.ts`: `LOCK_STALE_MS = 15_000`, `lockPath(runDir)`, `readActiveLock(runDir, now?) → { pid, ts } | null` (null when missing/invalid/stale/our own pid), `writeLock(runDir)`, `startLockHeartbeat(runDir, intervalMs = 5000) → stop()` (refreshes every interval; `stop()` removes the file if it is ours)
  - `AttachView` props: `{ runDir; writeControl(type: ControlType, message: string | null): void; onQuit(): void; pollMs?: number (250); tailLines?: number (40) }`; `resumeHint(state, runDir): string`
  - `OpenMenu` props: `{ runs: RunRow[]; onSelect(row); onQuit(); onRefresh(); now?: number }`; `interface RunRow { runId; runDir; state: RunState }`; `formatRow(row, now?): string`
  - `index.tsx`: `cmdOpen({ cwd? }) → Promise<number>`, `cmdAttach({ name; cwd? }) → Promise<number>`, `attachRun(run: RunRef, { interactive: boolean })`, `printStaticTail(runDir, n = 40)`
  - Behavior (spec §4.5, §8): interactive attach = live view + input line; terminal-state run = read-only transcript with resume hint and `q` to quit; `dead` monitor or non-TTY stdio = static tail printed to stdout, exit 0; `open` on non-TTY = exit 1 with guidance; second console → warning on stderr (lock), never a refusal

- [ ] **Step 1: Add dependencies and JSX**

```bash
pnpm add ink@^7.1.1 react@^19.2.8 ink-select-input@^6.2.0 ink-text-input@^6.0.0
pnpm add -D @types/react@^19.2.0 ink-testing-library@^4.0.0
```

`tsconfig.json` → add `"jsx": "react-jsx"` inside `compilerOptions` (ink 7 requires Node ≥ 22 and React ≥ 19.2; both satisfied). Also set `"engines": { "node": ">=22" }` in `package.json` (ink 7 requirement; the spec's Node >= 20 predates the TUI-library decision).

- [ ] **Step 2: Write failing lock + view tests**

`tests/console-lock.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { lockPath, readActiveLock, writeLock, startLockHeartbeat, LOCK_STALE_MS } from "../src/console/lock.js";
import { tmpDir } from "./helpers.js";

test("lock: missing/invalid/stale/own-pid → null; foreign fresh lock → returned", () => {
  const runDir = tmpDir("pf-lock-");
  assert.equal(readActiveLock(runDir), null);
  fs.writeFileSync(lockPath(runDir), "{nope");
  assert.equal(readActiveLock(runDir), null);
  writeLock(runDir);
  assert.equal(readActiveLock(runDir), null, "own pid is not a conflict");
  fs.writeFileSync(lockPath(runDir), JSON.stringify({ pid: 424242, ts: new Date().toISOString() }));
  assert.equal(readActiveLock(runDir)?.pid, 424242);
  assert.equal(readActiveLock(runDir, Date.now() + LOCK_STALE_MS + 1), null, "stale");
});

test("heartbeat writes, refreshes, and removes its own lock on stop", async () => {
  const runDir = tmpDir("pf-lock-");
  const stop = startLockHeartbeat(runDir, 20);
  const first = JSON.parse(fs.readFileSync(lockPath(runDir), "utf8"));
  assert.equal(first.pid, process.pid);
  await new Promise((r) => setTimeout(r, 60));
  const later = JSON.parse(fs.readFileSync(lockPath(runDir), "utf8"));
  assert.ok(Date.parse(later.ts) >= Date.parse(first.ts));
  stop();
  assert.equal(fs.existsSync(lockPath(runDir)), false);
});
```

`tests/console-view.test.ts` (uses `React.createElement` so the file stays `.ts` and matches the test glob):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { AttachView, resumeHint } from "../src/console/AttachView.js";
import { OpenMenu, formatRow, type RunRow } from "../src/console/OpenMenu.js";
import { newRunState, saveState, runDirFor, type RunState } from "../src/state.js";
import { tmpDir } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fixtureRun(status: RunState["status"]): Promise<{ runDir: string; state: RunState }> {
  const fleetDir = path.join(tmpDir("pf-view-"), ".pi-fleet");
  const runDir = runDirFor(fleetDir, "auth-20260828141530");
  fs.mkdirSync(runDir, { recursive: true });
  const state = newRunState({ fleetDir, runId: "auth-20260828141530", name: "auth", cwd: "/x", model: "glm" });
  state.status = status;
  state.pid = process.pid; // alive → deriveStatus keeps "running"
  await saveState(runDir, state);
  fs.writeFileSync(
    path.join(runDir, "events.jsonl"),
    [
      JSON.stringify({ type: "task_prompt", brief: "create hello.txt" }),
      JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "echo hi" } }),
      JSON.stringify({ type: "message_update", ev: { type: "text_end", contentIndex: 0, content: "Working: wrote hello.txt" } }),
    ].join("\n") + "\n",
  );
  return { runDir, state };
}

test("AttachView (running): replays, follows new events, sends steer/followup/stop, quits", async () => {
  const { runDir } = await fixtureRun("running");
  const controls: Array<{ type: string; message: string | null }> = [];
  let quit = false;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(AttachView, {
      runDir,
      pollMs: 40,
      writeControl: (type, message) => { controls.push({ type, message }); },
      onQuit: () => { quit = true; },
    }),
  );
  await sleep(120);
  const frame = lastFrame() ?? "";
  assert.match(frame, /auth · running · glm · no branch/);
  assert.match(frame, /▶ task: create hello.txt/);
  assert.match(frame, /⚙ bash echo hi/);
  assert.match(frame, /Working: wrote hello.txt/);
  assert.match(frame, /\/followup <msg> · \/stop · \/quit/);

  fs.appendFileSync(path.join(runDir, "events.jsonl"),
    JSON.stringify({ type: "steering_delivered", source: "orchestrator", message: "use tabs" }) + "\n");
  await sleep(150);
  assert.match(lastFrame() ?? "", /▶ orchestrator: use tabs/);

  stdin.write("use spaces"); await sleep(40); stdin.write("\r"); await sleep(60);
  assert.deepEqual(controls.at(-1), { type: "steer", message: "use spaces" });
  assert.match(lastFrame() ?? "", /→ steer queued: use spaces/);
  stdin.write("/followup then summarize"); await sleep(40); stdin.write("\r"); await sleep(60);
  assert.deepEqual(controls.at(-1), { type: "follow_up", message: "then summarize" });
  stdin.write("/stop"); await sleep(40); stdin.write("\r"); await sleep(60);
  assert.deepEqual(controls.at(-1), { type: "abort", message: null });
  stdin.write("/quit"); await sleep(40); stdin.write("\r"); await sleep(60);
  assert.equal(quit, true);
  unmount();
});

test("AttachView (settled): read-only with resume hint; q quits; typing sends nothing", async () => {
  const { runDir, state } = await fixtureRun("settled");
  const controls: unknown[] = [];
  let quit = false;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(AttachView, {
      runDir, pollMs: 40,
      writeControl: (type, message) => { controls.push({ type, message }); },
      onQuit: () => { quit = true; },
    }),
  );
  await sleep(120);
  const frame = lastFrame() ?? "";
  assert.match(frame, /read-only: run is settled/);
  assert.ok(frame.includes(resumeHint(state, runDir)));
  assert.doesNotMatch(frame, /\/stop · \/quit/);
  stdin.write("hello\r"); await sleep(60);
  assert.equal(controls.length, 0);
  stdin.write("q"); await sleep(60);
  assert.equal(quit, true);
  unmount();
});

test("OpenMenu: renders rows; Enter selects highlighted; r refreshes; q quits", async () => {
  const { runDir, state } = await fixtureRun("running");
  const rows: RunRow[] = [{ runId: state.id, runDir, state }];
  let selected: RunRow | null = null;
  let quit = 0;
  let refreshed = 0;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(OpenMenu, {
      runs: rows, now: Date.parse(state.createdAt) + 90_000,
      onSelect: (r) => { selected = r; }, onQuit: () => { quit++; }, onRefresh: () => { refreshed++; },
    }),
  );
  await sleep(60);
  const frame = lastFrame() ?? "";
  assert.match(frame, /NAME\s+STATE\s+LAST-ACTIVITY\s+LAST-TOOL\s+STEERED\s+AGE/);
  assert.ok(frame.includes(formatRow(rows[0], Date.parse(state.createdAt) + 90_000)));
  assert.match(frame, /auth\s+running\s+-\s+-\s+0\s+1m/);
  stdin.write("\r"); await sleep(60);
  assert.equal(selected?.runId, state.id);
  stdin.write("r"); await sleep(40);
  assert.equal(refreshed, 1);
  stdin.write("q"); await sleep(40);
  assert.equal(quit, 1);
  unmount();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --import tsx --test tests/console-lock.test.ts tests/console-view.test.ts`
Expected: FAIL (modules not found)

- [ ] **Step 4: Implement src/console/lock.ts**

```ts
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../util.js";

export interface ConsoleLock {
  pid: number;
  ts: string;
}

export const LOCK_STALE_MS = 15_000;

export function lockPath(runDir: string): string {
  return path.join(runDir, "console.lock");
}

export function readActiveLock(runDir: string, now: number = Date.now()): ConsoleLock | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath(runDir), "utf8");
  } catch {
    return null;
  }
  let lock: Partial<ConsoleLock>;
  try {
    lock = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof lock.pid !== "number" || typeof lock.ts !== "string") return null;
  if (now - Date.parse(lock.ts) > LOCK_STALE_MS) return null;
  if (lock.pid === process.pid) return null;
  return { pid: lock.pid, ts: lock.ts };
}

export function writeLock(runDir: string): void {
  fs.writeFileSync(lockPath(runDir), JSON.stringify({ pid: process.pid, ts: nowIso() }));
}

export function startLockHeartbeat(runDir: string, intervalMs = 5000): () => void {
  writeLock(runDir);
  const timer = setInterval(() => {
    try { writeLock(runDir); } catch { /* best effort */ }
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    try {
      const current = JSON.parse(fs.readFileSync(lockPath(runDir), "utf8"));
      if (current.pid === process.pid) fs.unlinkSync(lockPath(runDir));
    } catch { /* already gone */ }
  };
}
```

- [ ] **Step 5: Implement src/console/AttachView.tsx**

```tsx
import path from "node:path";
import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { deriveStatus, loadStateSync, TERMINAL_STATES, type ControlType, type RunState } from "../state.js";
import {
  applyEvent, partialText, readNewEvents, replay, type LineKind, type Transcript, type TranscriptLine,
} from "./transcript.js";

export interface AttachViewProps {
  runDir: string;
  writeControl: (type: ControlType, message: string | null) => void;
  onQuit: () => void;
  pollMs?: number;
  tailLines?: number;
}

const isTerminal = (status: string): boolean => (TERMINAL_STATES as readonly string[]).includes(status);

export function resumeHint(state: RunState, runDir: string): string {
  return `resume: pi-fleet spawn ${state.name}-2 --session ${path.join(runDir, "session")} -- "<new brief>"`;
}

function colorFor(kind: LineKind): string | undefined {
  switch (kind) {
    case "steer": return "yellow";
    case "tool": return "blue";
    case "system": return "magenta";
    default: return undefined;
  }
}

export function AttachView({ runDir, writeControl, onQuit, pollMs = 250, tailLines = 40 }: AttachViewProps) {
  const eventsPath = path.join(runDir, "events.jsonl");
  const initial = useRef(replay(eventsPath, tailLines));
  const transcriptRef = useRef<Transcript>(initial.current.transcript);
  const offsetRef = useRef<number>(initial.current.offset);
  const [lines, setLines] = useState<TranscriptLine[]>([...initial.current.transcript.lines]);
  const [partial, setPartial] = useState<string | null>(partialText(initial.current.transcript));
  const [state, setState] = useState<RunState>(() => loadStateSync(runDir));
  const [input, setInput] = useState("");

  const trimAndPublish = () => {
    const t = transcriptRef.current;
    if (t.lines.length > tailLines) t.lines.splice(0, t.lines.length - tailLines);
    setLines([...t.lines]);
    setPartial(partialText(t));
  };

  useEffect(() => {
    const tick = () => {
      const { events, offset } = readNewEvents(eventsPath, offsetRef.current);
      offsetRef.current = offset;
      if (events.length > 0) {
        for (const ev of events) applyEvent(transcriptRef.current, ev);
        trimAndPublish();
      }
      try { setState(loadStateSync(runDir)); } catch { /* keep last known state */ }
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return () => clearInterval(timer);
  }, [eventsPath, runDir, pollMs, tailLines]);

  const status = deriveStatus(state);
  const readOnly = isTerminal(status);

  useInput((ch) => { if (ch === "q") onQuit(); }, { isActive: readOnly });

  const echo = (text: string) => {
    transcriptRef.current.lines.push({ kind: "system", text });
    trimAndPublish();
  };

  const submit = (value: string) => {
    const text = value.trim();
    setInput("");
    if (!text) return;
    if (text === "/quit") { onQuit(); return; }
    if (text === "/stop") { writeControl("abort", null); echo("■ abort requested (console)"); return; }
    if (text.startsWith("/followup ")) {
      const message = text.slice("/followup ".length).trim();
      if (message) { writeControl("follow_up", message); echo(`→ follow-up queued: ${message}`); }
      return;
    }
    writeControl("steer", text);
    echo(`→ steer queued: ${text}`);
  };

  return (
    <Box flexDirection="column">
      <Text bold>{state.name} · {status} · {state.model ?? "default model"} · {state.branch ?? "no branch"}</Text>
      {lines.map((l, i) => (
        <Text key={i} color={colorFor(l.kind)} dimColor={l.kind === "tool_result"}>{l.text}</Text>
      ))}
      {partial ? <Text>{partial}<Text dimColor>▍</Text></Text> : null}
      {readOnly ? (
        <Text dimColor>read-only: run is {status} · {resumeHint(state, runDir)} · q to quit</Text>
      ) : (
        <>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <TextInput value={input} onChange={setInput} onSubmit={submit} />
          </Box>
          <Text dimColor>type to steer · /followup &lt;msg&gt; · /stop · /quit</Text>
        </>
      )}
    </Box>
  );
}
```

- [ ] **Step 6: Implement src/console/OpenMenu.tsx**

```tsx
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { deriveStatus, type RunState } from "../state.js";
import { formatAge } from "../util.js";

export interface RunRow {
  runId: string;
  runDir: string;
  state: RunState;
}

export interface OpenMenuProps {
  runs: RunRow[];
  onSelect: (row: RunRow) => void;
  onQuit: () => void;
  onRefresh: () => void;
  now?: number;
}

const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s.padEnd(n));

export const HEADER = `${pad("NAME", 18)} ${pad("STATE", 9)} ${pad("LAST-ACTIVITY", 24)} ${pad("LAST-TOOL", 10)} ${pad("STEERED", 7)} AGE`;

export function formatRow(row: RunRow, now: number = Date.now()): string {
  const s = row.state;
  return `${pad(s.name, 18)} ${pad(deriveStatus(s), 9)} ${pad(s.lastActivity ?? "-", 24)} ${pad(s.lastTool ?? "-", 10)} ${pad(String(s.steerCount), 7)} ${formatAge(Math.max(0, now - Date.parse(s.createdAt)))}`;
}

export function OpenMenu({ runs, onSelect, onQuit, onRefresh, now }: OpenMenuProps) {
  useInput((ch) => {
    if (ch === "q") onQuit();
    else if (ch === "r") onRefresh();
  });
  const items = runs.map((r, i) => ({ key: r.runId, label: formatRow(r, now), value: String(i) }));
  return (
    <Box flexDirection="column">
      <Text bold>{"  "}{HEADER}</Text>
      {runs.length === 0 ? (
        <Text dimColor>(no runs — spawn one with: pi-fleet spawn &lt;name&gt; -- "&lt;brief&gt;")</Text>
      ) : (
        <SelectInput items={items} onSelect={(item) => onSelect(runs[Number(item.value)])} />
      )}
      <Text dimColor>↑/↓ + Enter (or number) to attach · r refresh · q quit</Text>
    </Box>
  );
}
```

- [ ] **Step 7: Implement src/console/index.tsx and register commands**

```tsx
import path from "node:path";
import { render } from "ink";
import { resolveFleetDir } from "../spawn.js";
import {
  appendControl, deriveStatus, findRun, listRuns, loadStateSync, type ControlType, type RunRef,
} from "../state.js";
import { AttachView } from "./AttachView.js";
import { OpenMenu, type RunRow } from "./OpenMenu.js";
import { readActiveLock, startLockHeartbeat } from "./lock.js";
import { replay } from "./transcript.js";

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function nonArchivedRows(piFleetDir: string): RunRow[] {
  return listRuns(piFleetDir).flatMap(({ runId, runDir }) => {
    try {
      const state = loadStateSync(runDir);
      return state.status === "archived" ? [] : [{ runId, runDir, state }];
    } catch {
      return [];
    }
  });
}

export function printStaticTail(runDir: string, n = 40): void {
  const { transcript } = replay(path.join(runDir, "events.jsonl"), n);
  if (transcript.lines.length === 0) console.log("(no events captured yet)");
  for (const line of transcript.lines) console.log(line.text);
}

export async function attachRun(run: RunRef, opts: { interactive: boolean }): Promise<void> {
  const status = deriveStatus(run.state);
  if (!opts.interactive || status === "dead") {
    if (status === "dead") console.error(`${run.state.name}: monitor is dead — showing the captured tail`);
    printStaticTail(run.runDir);
    return;
  }
  const other = readActiveLock(run.runDir);
  if (other) console.error(`warning: another console (pid ${other.pid}) is attached to ${run.state.name}`);
  const stopHeartbeat = startLockHeartbeat(run.runDir);
  try {
    const app = render(
      <AttachView
        runDir={run.runDir}
        writeControl={(type: ControlType, message: string | null) => {
          void appendControl(run.runDir, { type, message, source: "console" });
        }}
        onQuit={() => app.unmount()}
      />,
      { exitOnCtrlC: true },
    );
    await app.waitUntilExit();
  } finally {
    stopHeartbeat();
  }
}

export async function cmdAttach(args: { name: string; cwd?: string }): Promise<number> {
  const { piFleetDir } = await resolveFleetDir(args.cwd);
  const run = findRun(piFleetDir, args.name);
  await attachRun(run, { interactive: isInteractiveTerminal() });
  return 0;
}

export async function cmdOpen(args: { cwd?: string }): Promise<number> {
  const { piFleetDir } = await resolveFleetDir(args.cwd);
  if (!isInteractiveTerminal()) {
    console.error("open: needs an interactive terminal — use `pi-fleet status` or `pi-fleet attach <name>` instead");
    return 1;
  }
  for (;;) {
    const rows = nonArchivedRows(piFleetDir);
    const choice = await new Promise<RunRow | "quit" | "refresh">((resolve) => {
      const app = render(
        <OpenMenu
          runs={rows}
          onSelect={(row) => { app.unmount(); resolve(row); }}
          onQuit={() => { app.unmount(); resolve("quit"); }}
          onRefresh={() => { app.unmount(); resolve("refresh"); }}
        />,
      );
    });
    if (choice === "quit") return 0;
    if (choice === "refresh") continue;
    await attachRun({ runId: choice.runId, runDir: choice.runDir, state: choice.state }, { interactive: true });
  }
}
```

Register in `src/cli.ts` (import `cmdOpen`, `cmdAttach` from `./console/index.js`):

```ts
program
  .command("open")
  .description("interactive run menu → attach to a worker")
  .option(...cwdOption)
  .action(async (options: OptionValues) => done(await cmdOpen({ cwd: options.cwd })));

program
  .command("attach <name>")
  .description("live view + steering console for one worker (non-TTY: prints the captured tail)")
  .option(...cwdOption)
  .action(async (name: string, options: OptionValues) => done(await cmdAttach({ name, cwd: options.cwd })));
```

- [ ] **Step 8: Write the CLI-level test**

`tests/console-cli.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { initRepo, runCli, readState, waitFor, TERMINAL } from "./helpers.js";

test("attach on a non-TTY prints the static tail and exits 0; open on non-TTY exits 1", async () => {
  const root = initRepo("pf-ccli-");
  const spawned = await runCli(["spawn", "worker", "--cwd", root, "--no-worktree", "--", "task"]);
  assert.equal(spawned.code, 0, spawned.stderr);
  await waitFor(() => (TERMINAL.includes(readState(root).status) ? true : undefined), { timeoutMs: 30_000 });
  const tail = await runCli(["attach", "worker", "--cwd", root]);
  assert.equal(tail.code, 0, tail.stderr);
  assert.match(tail.stdout, /▶ task: task/);
  assert.match(tail.stdout, /⚙ bash/);
  assert.match(tail.stdout, /● settled/);
  const open = await runCli(["open", "--cwd", root]);
  assert.equal(open.code, 1);
  assert.match(open.stderr, /interactive terminal/);
}, { timeout: 60_000 });
```

- [ ] **Step 9: Run typecheck + tests**

Run: `pnpm typecheck && node --import tsx --test tests/console-lock.test.ts tests/console-view.test.ts tests/console-cli.test.ts`
Expected: typecheck clean; PASS (6 tests)

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json src/cli.ts src/console tests/console-lock.test.ts tests/console-view.test.ts tests/console-cli.test.ts
git commit -m "feat: console — ink run menu (open) and live steering view (attach)"
```

---

### Task 14: pi side — `fleet-report` extension, `fleet-worker-report` skill, monitor loads both

**Files:**

- Create: `src/paths.ts`, `pi/extensions/fleet-report.ts`, `pi/skills/fleet-worker-report/SKILL.md`
- Modify: `src/commands.ts` (take `SRC_DIR`/`PACKAGE_ROOT` from `paths.ts`), `src/monitor.ts` (pass `--extension` + `--skill`), `tests/fixtures/fake-pi.mjs` (argv dump)
- Test: `tests/fleet-extension.test.ts`

**Interfaces:**

- Consumes: monitor env contract (Task 6): `PI_FLEET_RUN`, `PI_FLEET_DIR`; pi's `ExtensionAPI` (`before_agent_start` handler may return `{ systemPrompt }`); pi CLI flags `--extension <file>` and `--skill <dir>`
- Produces:
  - `src/paths.ts`: `SRC_DIR`, `PACKAGE_ROOT`, `FLEET_EXTENSION_PATH` (`<root>/pi/extensions/fleet-report.ts`), `FLEET_SKILL_PATH` (`<root>/pi/skills/fleet-worker-report`), `CLAUDE_SKILL_SOURCE` (`<root>/claude/skills/pi-orchestrator`) — Task 15 uses the last one
  - `pi/extensions/fleet-report.ts`: default export `fleetReport(pi)`; named exports `FLEET_PROTOCOL_MARKER`, `REPORT_TEMPLATE`, `buildFleetProtocol(env, cwd): string | null`
  - Monitor always passes `--extension FLEET_EXTENSION_PATH --skill FLEET_SKILL_PATH` (before any user `--skill`), so workers get the protocol even when the package was never `pi install`ed
  - Fake pi writes its argv to `$FAKE_PI_ARGV_FILE` when that env var is set

**Design note (refines spec §5.1):** the spec says "on session start, inject an agent-visible instruction message". This task injects the same instructions by appending to the **system prompt** in `before_agent_start` instead of `pi.sendMessage` on `session_start`, because (a) the system prompt survives compaction and `--session` resumes, where a custom message could be summarized away or duplicated, (b) it never races the monitor's first `prompt`, and (c) it is idempotent when the extension is loaded twice (package install + `--extension`) via the `FLEET_PROTOCOL_MARKER` guard. The visible effect for the model is identical: the protocol is in context from the first turn.

- [ ] **Step 1: Write failing tests**

`tests/fleet-extension.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import fleetReport, { buildFleetProtocol, FLEET_PROTOCOL_MARKER, REPORT_TEMPLATE } from "../pi/extensions/fleet-report.js";
import { FLEET_EXTENSION_PATH, FLEET_SKILL_PATH } from "../src/paths.js";
import { initRepo, runCli, fakePiEnv, readState, waitFor, tmpDir, TERMINAL } from "./helpers.js";

test("buildFleetProtocol: null without env; otherwise paths, rules, and template", () => {
  assert.equal(buildFleetProtocol({}, "/wt"), null);
  assert.equal(buildFleetProtocol({ PI_FLEET_RUN: "auth-1" }, "/wt"), null);
  const block = buildFleetProtocol({ PI_FLEET_RUN: "auth-1", PI_FLEET_DIR: "/f/.pi-fleet" }, "/wt")!;
  assert.ok(block.startsWith(FLEET_PROTOCOL_MARKER));
  assert.match(block, /\/f\/\.pi-fleet\/reports\/auth-1\.md/);
  assert.match(block, /\/f\/\.pi-fleet\/runs\/auth-1\/progress\.md/);
  assert.match(block, /Steering received/);
  assert.match(block, /never run `git merge`/i);
  assert.ok(block.includes(REPORT_TEMPLATE));
  for (const h of ["## Status", "## Summary", "## What I did", "## Files changed", "## Verification",
    "## Decisions & assumptions", "## Steering received", "## Open questions for orchestrator", "## Suggested next step"]) {
    assert.ok(REPORT_TEMPLATE.includes(h), `template missing ${h}`);
  }
});

test("extension appends the protocol once via before_agent_start (idempotent, env-gated)", async () => {
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  const pi = { on: (name: string, fn: any) => { handlers[name] = fn; } } as any;
  const saved = { run: process.env.PI_FLEET_RUN, dir: process.env.PI_FLEET_DIR };
  try {
    process.env.PI_FLEET_RUN = "auth-1";
    process.env.PI_FLEET_DIR = "/f/.pi-fleet";
    fleetReport(pi);
    assert.ok(handlers.before_agent_start, "registers before_agent_start");
    const first = await handlers.before_agent_start({ systemPrompt: "base" }, { cwd: "/wt" });
    assert.match(first.systemPrompt, /^base\n\n## Fleet worker protocol/);
    const second = await handlers.before_agent_start({ systemPrompt: first.systemPrompt }, { cwd: "/wt" });
    assert.equal(second, undefined, "does not append twice");
    delete process.env.PI_FLEET_RUN;
    delete process.env.PI_FLEET_DIR;
    assert.equal(await handlers.before_agent_start({ systemPrompt: "base" }, { cwd: "/wt" }), undefined);
  } finally {
    if (saved.run !== undefined) process.env.PI_FLEET_RUN = saved.run;
    if (saved.dir !== undefined) process.env.PI_FLEET_DIR = saved.dir;
  }
});

test("worker skill has valid frontmatter and the same template headings", () => {
  const skill = fs.readFileSync(path.join(FLEET_SKILL_PATH, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: fleet-worker-report\ndescription: .+\n---/);
  assert.match(skill, /## Steering received/);
  assert.equal(fs.existsSync(FLEET_EXTENSION_PATH), true);
});

test("monitor passes --extension and --skill for the fleet protocol", async () => {
  const root = initRepo("pf-ext-");
  const argvFile = path.join(tmpDir("pf-argv-"), "argv.json");
  const r = await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--skill", "/extra/skill", "--", "t"],
    { env: fakePiEnv({ FAKE_PI_ARGV_FILE: argvFile }) });
  assert.equal(r.code, 0, r.stderr);
  await waitFor(() => (TERMINAL.includes(readState(root).status) ? true : undefined), { timeoutMs: 30_000 });
  const argv: string[] = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.deepEqual(argv.slice(0, 2), ["--mode", "rpc"]);
  assert.equal(argv[argv.indexOf("--extension") + 1], FLEET_EXTENSION_PATH);
  assert.equal(argv[argv.indexOf("--skill") + 1], FLEET_SKILL_PATH);
  assert.ok(argv.includes("/extra/skill"), "user --skill still passed");
}, { timeout: 60_000 });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/fleet-extension.test.ts`
Expected: FAIL (`../pi/extensions/fleet-report.js` and `../src/paths.js` not found)

- [ ] **Step 3: Create src/paths.ts and switch commands.ts to it**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `src/` in development (tsx), `dist/` when built. */
export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.dirname(SRC_DIR);
export const FLEET_EXTENSION_PATH = path.join(PACKAGE_ROOT, "pi", "extensions", "fleet-report.ts");
export const FLEET_SKILL_PATH = path.join(PACKAGE_ROOT, "pi", "skills", "fleet-worker-report");
export const CLAUDE_SKILL_SOURCE = path.join(PACKAGE_ROOT, "claude", "skills", "pi-orchestrator");
```

In `src/commands.ts` delete the local `SRC_DIR`/`PACKAGE_ROOT` definitions and add `import { SRC_DIR } from "./paths.js";` plus `export { SRC_DIR, PACKAGE_ROOT } from "./paths.js";`.

- [ ] **Step 4: Write pi/extensions/fleet-report.ts**

```ts
/**
 * pi-fleet worker protocol.
 *
 * When pi runs as a fleet worker (PI_FLEET_RUN + PI_FLEET_DIR set by `pi-fleet`'s monitor),
 * append the report protocol to the system prompt so report-writing does not depend on the
 * model discovering the skill. Idempotent: safe if loaded both via `pi install` and `--extension`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FLEET_PROTOCOL_MARKER = "## Fleet worker protocol";

export const REPORT_TEMPLATE = `# Fleet Report: <run name>

## Status
done | blocked | failed

## Summary
(3-8 sentences: what was accomplished and the outcome)

## What I did
(numbered steps actually taken)

## Files changed
(path: one-line reason — from your actual edits)

## Verification
(command run → result, for each check performed)

## Decisions & assumptions
(any choice made without explicit instruction)

## Steering received
(mid-run course corrections you were given and how you handled them; "none" if none)

## Open questions for orchestrator
(things you could not resolve — empty if none; REQUIRED if Status: blocked)

## Suggested next step
(one concrete next action for the orchestrator)`;

export interface FleetEnv {
  PI_FLEET_RUN?: string;
  PI_FLEET_DIR?: string;
}

export function buildFleetProtocol(env: FleetEnv, cwd: string): string | null {
  const runId = env.PI_FLEET_RUN;
  const fleetDir = env.PI_FLEET_DIR;
  if (!runId || !fleetDir) return null;
  const reportPath = `${fleetDir}/reports/${runId}.md`;
  const progressPath = `${fleetDir}/runs/${runId}/progress.md`;
  return [
    FLEET_PROTOCOL_MARKER,
    "",
    `You are a fleet worker. Run id: \`${runId}\`. Working directory: \`${cwd}\`. The orchestrator (Claude Code) reads your results from files, not from this conversation.`,
    "",
    "Rules:",
    `1. Before you finish (before your final assistant turn), write your final report to \`${reportPath}\` using EXACTLY the template below — keep every heading, in order.`,
    `2. For long tasks, append one line per milestone to \`${progressPath}\`.`,
    "3. Stay scoped to your task brief. Do not touch files outside your working directory. Never run `git merge`, never modify the parent checkout, never push.",
    "4. If you receive steering messages mid-run (course corrections from the orchestrator or from the user's console), incorporate them immediately. Your final report MUST reflect the adjusted direction: list every steering message under \"Steering received\" and keep Status/Verification consistent with the work as finally done.",
    "5. If you are blocked, set `Status: blocked` and fill \"Open questions for orchestrator\" instead of guessing.",
    "",
    "Report template:",
    "",
    "```markdown",
    REPORT_TEMPLATE,
    "```",
  ].join("\n");
}

export default function fleetReport(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const block = buildFleetProtocol(process.env, ctx.cwd);
    if (!block) return;
    if (event.systemPrompt.includes(FLEET_PROTOCOL_MARKER)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}
```

(`pi/` is outside `tsconfig` `include`; pi loads it through jiti and `tsx` strips the type-only import in tests, so `@earendil-works/pi-coding-agent` is not a dependency of this package.)

- [ ] **Step 5: Write pi/skills/fleet-worker-report/SKILL.md**

```markdown
---
name: fleet-worker-report
description: How to write the final report for a pi-fleet worker run (exact markdown template, what each section needs, how to reflect mid-run steering). Use whenever PI_FLEET_RUN is set or a task brief asks for a fleet report.
---

# Fleet worker report

You are running as a worker for `pi-fleet`. The orchestrator never reads this chat; it reads
`$PI_FLEET_DIR/reports/$PI_FLEET_RUN.md`. Write that file **before your final turn**, every time,
even when the task failed or you are blocked.

## Template (copy verbatim, keep all headings in this order)

```markdown
# Fleet Report: <run name>

## Status
done | blocked | failed

## Summary
(3-8 sentences: what was accomplished and the outcome)

## What I did
(numbered steps actually taken)

## Files changed
(path: one-line reason — from your actual edits)

## Verification
(command run → result, for each check performed)

## Decisions & assumptions
(any choice made without explicit instruction)

## Steering received
(mid-run course corrections you were given and how you handled them; "none" if none)

## Open questions for orchestrator
(things you could not resolve — empty if none; REQUIRED if Status: blocked)

## Suggested next step
(one concrete next action for the orchestrator)
```

## Section guidance

- **Status** — exactly one word. `done` only if the definition of done in your brief is met and
  verified. `blocked` when you need a decision or missing input (then Open questions is mandatory).
  `failed` when you tried and could not make it work.
- **Summary** — outcome first, then how. No narration of dead ends unless they matter.
- **What I did** — numbered, past tense, concrete ("Added `parseArgs()` in src/cli.ts"), not intentions.
- **Files changed** — one line per file, from your real edits (`git status` / `git diff --stat` is
  your source of truth). Say "none" if you changed nothing.
- **Verification** — each check as `command → result`. If you ran nothing, say so; do not invent.
- **Decisions & assumptions** — anything the brief left open that you decided. The orchestrator
  reviews these.
- **Steering received** — list every steering / follow-up message you got, when relative to your
  work, and what changed because of it. The orchestrator compares this with its own steering log.
  Write `none` if there was none. Status and Verification must describe the work as finally done
  after steering, not the original plan.
- **Open questions for orchestrator** — precise, answerable questions. Empty when nothing is open.
- **Suggested next step** — one action ("merge the branch", "re-run with X clarified").

## Rules

- Stay inside your working directory; never `git merge`, never touch the parent checkout, never push.
- Commit your work in your worktree when the brief asks for commits (the orchestrator merges).
- For long tasks, append one-line milestones to `$PI_FLEET_DIR/runs/$PI_FLEET_RUN/progress.md`.
```

- [ ] **Step 6: Monitor passes the extension and skill; fake pi records argv**

`src/monitor.ts` — import `FLEET_EXTENSION_PATH`, `FLEET_SKILL_PATH` from `./paths.js` and, right after `"--session-dir", path.join(runDir, "session")` in `piArgs`, add:

```ts
    "--extension", FLEET_EXTENSION_PATH,
    "--skill", FLEET_SKILL_PATH,
```

(Keep the user's `if (state.skill) piArgs.push("--skill", state.skill)` after it — pi accepts `--skill` repeatedly.)

`tests/fixtures/fake-pi.mjs` — first statement after the imports:

```js
if (process.env.FAKE_PI_ARGV_FILE) {
  fsSync.writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
}
```

- [ ] **Step 7: Run typecheck + tests**

Run: `pnpm typecheck && node --import tsx --test tests/fleet-extension.test.ts tests/monitor.test.ts`
Expected: typecheck clean; PASS (4 + 2 tests)

- [ ] **Step 8: Commit**

```bash
git add src/paths.ts src/commands.ts src/monitor.ts pi tests/fixtures/fake-pi.mjs tests/fleet-extension.test.ts
git commit -m "feat: pi worker protocol — fleet-report extension, fleet-worker-report skill, monitor passthrough"
```

---

### Task 15: `install-claude-skill` + the Claude Code `pi-orchestrator` skill

**Files:**

- Create: `src/install.ts`, `claude/skills/pi-orchestrator/SKILL.md`, `claude/skills/pi-orchestrator/references/cli.md`
- Modify: `src/cli.ts` (register `install-claude-skill`)
- Test: `tests/install-claude-skill.test.ts`

**Interfaces:**

- Consumes: `CLAUDE_SKILL_SOURCE` from `paths.ts` (Task 14)
- Produces:
  - `installClaudeSkill({ home?, source? }): { status: "created" | "exists"; target: string; source: string }` — links `<home>/.claude/skills/pi-orchestrator` → `<source>`; throws `refusing to overwrite …` when the target exists and is not our symlink
  - `cmdInstallClaudeSkill(): Promise<number>` prints `linked <target> -> <source>` (or `already linked …`), exit 0
  - `~` resolution uses `os.homedir()` (honours `$HOME`, which the test overrides)

- [ ] **Step 1: Write failing tests**

`tests/install-claude-skill.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installClaudeSkill } from "../src/install.js";
import { CLAUDE_SKILL_SOURCE } from "../src/paths.js";
import { runCli, fakePiEnv, tmpDir } from "./helpers.js";

test("installClaudeSkill: creates symlink, is idempotent, refuses foreign paths", () => {
  const home = tmpDir("pf-home-");
  const first = installClaudeSkill({ home });
  assert.equal(first.status, "created");
  const target = path.join(home, ".claude", "skills", "pi-orchestrator");
  assert.equal(first.target, target);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(target), fs.realpathSync(CLAUDE_SKILL_SOURCE));
  assert.equal(fs.existsSync(path.join(target, "SKILL.md")), true);
  assert.equal(installClaudeSkill({ home }).status, "exists");

  const home2 = tmpDir("pf-home-");
  fs.mkdirSync(path.join(home2, ".claude", "skills", "pi-orchestrator"), { recursive: true });
  assert.throws(() => installClaudeSkill({ home: home2 }), /refusing to overwrite/);
});

test("CLI install-claude-skill honours $HOME and prints the link", async () => {
  const home = tmpDir("pf-home-");
  const r = await runCli(["install-claude-skill"], { env: fakePiEnv({ HOME: home }) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /linked .*pi-orchestrator -> /);
  assert.equal(fs.lstatSync(path.join(home, ".claude", "skills", "pi-orchestrator")).isSymbolicLink(), true);
});

test("skill files exist with frontmatter and a CLI reference", () => {
  const skill = fs.readFileSync(path.join(CLAUDE_SKILL_SOURCE, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: pi-orchestrator\ndescription: .+\n---/);
  assert.match(skill, /pi-fleet spawn/);
  assert.match(skill, /pi-fleet report/);
  assert.match(skill, /3 concurrent/);
  const ref = fs.readFileSync(path.join(CLAUDE_SKILL_SOURCE, "references", "cli.md"), "utf8");
  assert.match(ref, /exit 5/i);
  assert.match(ref, /steeringLog/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/install-claude-skill.test.ts`
Expected: FAIL (`../src/install.js` not found)

- [ ] **Step 3: Implement src/install.ts and register the command**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_SKILL_SOURCE } from "./paths.js";

export interface InstallResult {
  status: "created" | "exists";
  target: string;
  source: string;
}

export function installClaudeSkill(opts: { home?: string; source?: string } = {}): InstallResult {
  const home = opts.home ?? os.homedir();
  const source = fs.realpathSync(opts.source ?? CLAUDE_SKILL_SOURCE);
  const skillsDir = path.join(home, ".claude", "skills");
  const target = path.join(skillsDir, "pi-orchestrator");
  fs.mkdirSync(skillsDir, { recursive: true });

  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      let resolved: string | null = null;
      try {
        resolved = fs.realpathSync(target);
      } catch {
        resolved = null;
      }
      if (resolved === source) return { status: "exists", target, source };
    }
    throw new Error(`refusing to overwrite ${target}: it exists and is not a pi-fleet symlink — remove it first`);
  }
  fs.symlinkSync(source, target, "dir");
  return { status: "created", target, source };
}

export async function cmdInstallClaudeSkill(): Promise<number> {
  const r = installClaudeSkill();
  console.log(`${r.status === "created" ? "linked" : "already linked"} ${r.target} -> ${r.source}`);
  console.log("Claude Code picks up the pi-orchestrator skill in new sessions.");
  return 0;
}
```

`src/cli.ts`:

```ts
import { cmdInstallClaudeSkill } from "./install.js";

program
  .command("install-claude-skill")
  .description("symlink the pi-orchestrator skill into ~/.claude/skills")
  .action(async () => done(await cmdInstallClaudeSkill()));
```

- [ ] **Step 4: Write claude/skills/pi-orchestrator/SKILL.md**

```markdown
---
name: pi-orchestrator
description: Orchestrate headless pi coding agents with the pi-fleet CLI — decompose a goal into steps, spawn isolated pi workers (git worktrees), monitor and steer them, collect their fleet reports, merge and verify. Use when asked to delegate implementation work to pi, run pi workers/agents in parallel, or drive a multi-step plan with pi.
---

# pi-orchestrator

You are the orchestrator; `pi` agents are your workers. Everything goes through the `pi-fleet`
CLI (run it with Bash). Command reference, exit codes, and file formats: `references/cli.md`.
Workers see **nothing** except the brief you give them, so briefs must be self-contained.

## The loop

1. **Plan.** Turn the goal into ordered steps with dependencies. Keep a todo list. Mark which
   steps are independent (parallelizable) and which must be sequential.
2. **Brief.** One step = one worker. Each brief states: goal, relevant context (paths, conventions,
   commands), constraints, definition of done, verification commands, and "commit your work in
   your worktree and write your fleet report before finishing". Read-only steps (research, review)
   run with `--no-worktree`.
3. **Spawn.** `pi-fleet spawn <kebab-name> --cwd <repo> [--model <pattern>] -- "<brief>"`.
   Run in parallel only for independent steps; keep at most **3 concurrent workers** (tell the user
   this cap). Report what you started (names, what each does).
4. **Monitor.** Loop: `pi-fleet wait <name> --timeout 120`. Exit 0 = settled → collect. Exit 3 =
   still running → check `pi-fleet status` / `pi-fleet output <name> --tail 5` for liveness, then
   keep waiting; surface a stall to the user if activity stops for several rounds. Exit 4 =
   stopped/error/dead → read `pi-fleet logs <name>`, then decide (respawn with `--session`, rebrief,
   or escalate). Never poll in a tight loop.
5. **Collect.** `pi-fleet report <name>`. Summarize for the user in 2–4 sentences: Status, what was
   done, verification results, open questions. Exit 2 means no report and no output — treat as failed.
6. **Integrate.** `pi-fleet diff <name>` to review, then `pi-fleet merge <name>` from the
   orchestrating checkout. Exit 5 = conflicts: resolve them yourself with normal tools using the
   worker's report, then `git commit`. Run the project's integration checks after every merge.
7. **Console interventions.** The user may run `pi-fleet open` and steer a worker mid-run. The
   report's "Steering received" section and the appended steering log show this. After any
   console interaction, re-read the report, reconcile your plan with the adjusted direction, and do
   not undo console steering unless the result is actually wrong.
8. **Blocked / failed.** Read the report's open questions. If the worker is still running, answer
   with `pi-fleet send <name> -- "<answer>"`; if it settled, spawn a fresh run with the answer in
   the brief (`--session <path>` resumes its context). Diagnose repeated failures from `logs`
   before retrying. Escalate to the user after 2 failed attempts on the same step.
9. **Drive forward.** Update the todo list, spawn the next step(s), repeat. When done:
   `pi-fleet cleanup all`, then give the user a rollup — per-step outcomes, merged changes,
   verification results, anything left open.

## Guardrails

- Never merge a run that is not `settled`; never merge work whose report says `failed`.
- Never edit a worker's worktree yourself — steer (`send`) or respawn instead.
- Keep the user informed at every step transition (spawned / settled / merged / blocked).
- Workers are cheap: prefer a fresh, better-briefed worker over endless steering.
- `.pi-fleet/` lives in the target repo and is git-ignored; it is your audit trail (reports,
  events) — leave it until the user asks to remove it.
```

- [ ] **Step 5: Write claude/skills/pi-orchestrator/references/cli.md**

```markdown
# pi-fleet CLI reference

All commands accept `--cwd <dir>` (default: current directory) to locate the fleet: the git repo
root containing `<dir>`, or `<dir>` itself outside git. State lives in `<root>/.pi-fleet/`.

| Command | Purpose | Exit codes |
|---|---|---|
| `spawn <name> [--cwd d] [--model p] [--provider n] [--thinking l] [--no-worktree] [--base ref] [--skill path] [--append-system-prompt t] [--session path\|id] [--tools list] [--exclude-tools list] -- "<brief>"` | start a detached `pi --mode rpc` worker | 0 ok · 1 error |
| `status [<name>] [--json] [--all]` | fleet table (archived hidden unless `--all`) or one run's full state | 0 |
| `wait <name> [--timeout sec]` (default 600) | block until terminal state | 0 settled · 3 timeout · 4 stopped/error/dead |
| `output <name> [--tail n]` | last assistant text, or last n tool results | 0 |
| `logs <name> [--tail n]` | tail of raw RPC stream (`rpc.log`) | 0 |
| `send <name> -- "<msg>"` | steer a running worker (delivered after its current tool calls) | 0 · 1 refused (run terminal) |
| `followup <name> -- "<msg>"` | queue a message for after the worker finishes its current work | 0 · 1 refused |
| `stop <name>` | abort a running worker (state → `stopped`) | 0 · 1 refused |
| `report <name>` | final report (or last assistant text as fallback) + steering-log appendix | 0 · 2 no report and no output |
| `diff <name> [--name-only]` | `git diff --stat <base>...HEAD` in the worker's worktree | 0 |
| `merge <name> [--no-commit]` | merge the worker branch into the current checkout | 0 · 1 refused (not settled / not a repo / inside worker worktree) · 5 conflicts (file list printed) |
| `cleanup <name\|all> [--force]` | remove worktree + branch, mark `archived` (reports/events kept) | 0 · 1 refused (running, no `--force`) |
| `open` / `attach <name>` | human console: run menu / live view + steering input | 0 |
| `install-claude-skill` | symlink this skill into `~/.claude/skills` | 0 · 1 refused |

Run names are kebab-cased; a run id is `<name>-<YYYYMMDDHHMMSS>`; the worker branch is
`pi-fleet/<name>-<last 7 digits>`. `<name>` on the command line resolves to the newest
non-archived run with that name (or an exact run id).

## Run states

`starting → running → settled` (normal) · `stopped` (abort) · `error` (pi exited without settling;
`state.error` holds the stderr tail) · `dead` (monitor process gone without a terminal state) ·
`archived` (after cleanup). `wait` treats settled/stopped/error/dead/archived as terminal.

## Files under `.pi-fleet/`

- `runs/<id>/state.json` — `{ id, name, status, cwd, worktree, branch, base, model, provider,
  thinking, sessionArg, skill, appendSystemPrompt, tools, excludeTools, taskBrief, fleetDir,
  repoRoot, isGit, pid, createdAt, settledAt, lastTool, lastActivity, lastAssistantText,
  steerCount, steeringLog: [{ source, ts, message }] (last 20), error }`
- `runs/<id>/events.jsonl` — selected RPC events (`agent_start`, `agent_end`, `agent_settled`,
  `turn_end`, `tool_execution_start/end`, `extension_error`, `auto_retry_start/end`,
  `compaction_start/end`, text `message_update`s) plus fleet events `task_prompt`,
  `steering_delivered { source, message }`, `abort_requested`; each with `ts`
- `runs/<id>/control.jsonl` — `{ type: "steer" | "follow_up" | "abort", message, source: "orchestrator" | "console", ts }`
- `runs/<id>/rpc.log`, `runs/<id>/monitor.log`, `runs/<id>/session/` (pi session, resumable via `--session`)
- `runs/<id>/progress.md` — optional worker milestones
- `reports/<id>.md` — the worker's fleet report (template: Status / Summary / What I did /
  Files changed / Verification / Decisions & assumptions / Steering received / Open questions /
  Suggested next step)
- `worktrees/<id>/` — the worker's git worktree (removed by `cleanup`)

## Typical session

```bash
pi-fleet spawn add-auth --cwd . -- "Implement …; run pnpm test; commit; write your fleet report."
pi-fleet wait add-auth --timeout 120   # loop on exit 3
pi-fleet report add-auth
pi-fleet diff add-auth && pi-fleet merge add-auth && pnpm test
pi-fleet cleanup add-auth
```
```

- [ ] **Step 6: Run typecheck + tests**

Run: `pnpm typecheck && node --import tsx --test tests/install-claude-skill.test.ts tests/cli.test.ts`
Expected: typecheck clean; PASS (3 + 3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/install.ts src/cli.ts claude tests/install-claude-skill.test.ts
git commit -m "feat: install-claude-skill command and pi-orchestrator Claude Code skill"
```

---

### Task 16: Real-model end-to-end script

**Files:**

- Create: `tests/e2e.ts`

**Interfaces:**

- Consumes: the whole CLI via `tests/helpers.ts` (`runCli` with an env that has **no** `PI_FLEET_PI_BIN`, so the real `pi` on PATH runs), spec §9 scenarios
- Produces: `pnpm test:e2e` — exits 0 when every check passes, 1 otherwise; optional `PI_FLEET_E2E_MODEL=<pattern>` selects a cheap model. Not part of `pnpm test` (costs tokens, needs credentials).

- [ ] **Step 1: Write tests/e2e.ts**

```ts
// Real-model end-to-end for pi-fleet. Requires `pi` on PATH with a working default provider.
// Optional: PI_FLEET_E2E_MODEL=<pattern> (e.g. a cheap model) is passed to every spawn.
import fs from "node:fs";
import path from "node:path";
import { initRepo, runCli, readState, firstRunId, fleetDirOf, waitFor } from "./helpers.js";

const env: NodeJS.ProcessEnv = { ...process.env, PI_FLEET_DEV: "1" };
delete env.PI_FLEET_PI_BIN;
const modelArgs = process.env.PI_FLEET_E2E_MODEL ? ["--model", process.env.PI_FLEET_E2E_MODEL] : [];

let failures = 0;
function check(condition: unknown, label: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}`); }
}
const cli = (args: string[], cwd?: string) => runCli(args, { env, cwd });

async function scenarioHello(): Promise<void> {
  console.log("scenario 1: spawn → wait → report → diff → merge → cleanup");
  const root = initRepo("pf-e2e-1-");
  const spawn = await cli([
    "spawn", "hello", "--cwd", root, ...modelArgs, "--",
    "Create a file named hello.txt in the current directory containing exactly the text 'hi' (one line).",
    "Commit it with git (git add hello.txt && git commit -m 'add hello'). Verify with cat hello.txt.",
    "Then write your fleet report.",
  ]);
  check(spawn.code === 0, `spawn exit 0 ${spawn.stderr.trim()}`);
  const runId = firstRunId(root);
  const initial = readState(root, runId);
  check(initial.worktree && fs.existsSync(initial.worktree), "worktree created");
  const wait = await cli(["wait", "hello", "--cwd", root, "--timeout", "600"]);
  check(wait.code === 0, `wait settled (exit ${wait.code}) ${wait.stdout.trim()}`);
  const report = await cli(["report", "hello", "--cwd", root]);
  check(report.code === 0 && /## Status/.test(report.stdout), "report exists with ## Status");
  const diff = await cli(["diff", "hello", "--cwd", root]);
  check(/hello\.txt/.test(diff.stdout), "diff shows hello.txt");
  const merge = await cli(["merge", "hello", "--cwd", root], root);
  check(merge.code === 0, `merge exit 0 ${merge.stderr.trim()}`);
  check(fs.existsSync(path.join(root, "hello.txt")), "hello.txt present in parent after merge");
  const cleanup = await cli(["cleanup", "hello", "--cwd", root], root);
  check(cleanup.code === 0, `cleanup exit 0 ${cleanup.stderr.trim()}`);
  check(!fs.existsSync(initial.worktree), "worktree removed");
  check(readState(root, runId).status === "archived", "run archived");
}

async function scenarioSteering(): Promise<void> {
  console.log("scenario 2: console steering mid-run reaches the worker and its report");
  const root = initRepo("pf-e2e-2-");
  const spawn = await cli([
    "spawn", "steer", "--cwd", root, ...modelArgs, "--",
    "Step 1: run the bash command `sleep 25`. Step 2: create note.txt containing the single word 'done'.",
    "Step 3: write your fleet report.",
  ]);
  check(spawn.code === 0, `spawn exit 0 ${spawn.stderr.trim()}`);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);
  await waitFor(() => {
    try {
      return /tool_execution_start/.test(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8")) ? true : undefined;
    } catch {
      return undefined;
    }
  }, { timeoutMs: 300_000, intervalMs: 500 });
  fs.appendFileSync(path.join(runDir, "control.jsonl"), JSON.stringify({
    type: "steer",
    message: "Change of plan from the user's console: note.txt must contain the word STEERED instead of done.",
    source: "console",
    ts: new Date().toISOString(),
  }) + "\n");
  const wait = await cli(["wait", "steer", "--cwd", root, "--timeout", "600"]);
  check(wait.code === 0, `wait settled (exit ${wait.code})`);
  const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
  check(/steering_delivered/.test(events), "steering_delivered event recorded");
  const state = readState(root, runId);
  check(state.steerCount === 1 && state.steeringLog[0]?.source === "console", "steerCount=1 with console provenance");
  const report = await cli(["report", "steer", "--cwd", root]);
  const section = report.stdout.split("## Steering received")[1]?.split("\n## ")[0] ?? "";
  check(section.trim().length > 0 && !/^\s*none\s*$/i.test(section.trim()), "report's 'Steering received' is not 'none'");
  check(/Steering log/.test(report.stdout), "steering-log appendix present");
  const note = state.worktree ? path.join(state.worktree, "note.txt") : null;
  console.log(`  info note.txt: ${note && fs.existsSync(note) ? fs.readFileSync(note, "utf8").trim() : "(missing)"}`);
  const cleanup = await cli(["cleanup", "steer", "--force", "--cwd", root], root);
  check(cleanup.code === 0, "cleanup exit 0");
}

await scenarioHello();
await scenarioSteering();
console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it once against the real pi**

Run: `pnpm test:e2e` (optionally `PI_FLEET_E2E_MODEL=<cheap model> pnpm test:e2e`)
Expected: `E2E PASSED`, exit 0. If a check fails, read `.pi-fleet/runs/<id>/rpc.log` and `monitor.log` in the temp repo printed by the failing scenario, fix the CLI (not the script) and re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e.ts
git commit -m "test: real-model e2e — hello loop and console steering scenarios"
```

---

### Task 17: README + packaging verification

**Files:**

- Create: `README.md`
- Modify: `package.json` (only if verification finds a gap)

**Interfaces:**

- Consumes: everything above
- Produces: a README covering the three install surfaces (spec §3), quickstart, command table, console, report protocol, file layout, development; `pnpm build` yields a runnable `dist/cli.js`; `npm pack --dry-run` lists `dist/`, `pi/`, `claude/`, `README.md`

- [ ] **Step 1: Write README.md**

```markdown
# pi-claude-fleet

Claude Code orchestrates headless [pi](https://github.com/earendil-works/pi-mono) coding agents.
One package, three parts:

- **`pi-fleet`** CLI — spawns detached `pi --mode rpc` workers in git worktrees, monitors them,
  forwards steering, collects reports, merges.
- **pi package** — `fleet-report` extension + `fleet-worker-report` skill: every worker knows to
  write a structured report before finishing.
- **Claude Code skill** — `pi-orchestrator`: the spawn → monitor → report → merge loop.

Requires Node ≥ 22 (ink) and `pi` on `PATH`.

## Install

```bash
pnpm install && pnpm build          # or: npm install -g .   → `pi-fleet` on PATH
pi install /path/to/pi-claude-fleet # optional: pi loads the extension + skill globally
pi-fleet install-claude-skill       # symlinks claude/skills/pi-orchestrator → ~/.claude/skills
```

`pi-fleet` passes its extension and skill to every worker with `--extension`/`--skill`, so the
`pi install` step is optional.

## Quickstart

```bash
cd your-repo
pi-fleet spawn add-auth -- "Implement …; run the tests; commit; write your fleet report."
pi-fleet wait add-auth --timeout 120      # exit 0 settled · 3 timeout · 4 stopped/error/dead
pi-fleet report add-auth                  # the worker's report + steering log
pi-fleet diff add-auth && pi-fleet merge add-auth
pi-fleet cleanup add-auth
```

Watch or steer a worker from a terminal: `pi-fleet open` (menu) or `pi-fleet attach add-auth`.
Type to steer, `/followup <msg>`, `/stop`, `/quit`.

## Commands

| Command | Purpose |
|---|---|
| `spawn <name> [opts] -- "<brief>"` | start a worker (`--cwd`, `--model`, `--provider`, `--thinking`, `--no-worktree`, `--base`, `--skill`, `--append-system-prompt`, `--session`, `--tools`, `--exclude-tools`) |
| `status [<name>] [--json] [--all]` | fleet table or one run's state |
| `wait <name> [--timeout s]` | block until terminal state |
| `output <name> [--tail n]` · `logs <name> [--tail n]` | last assistant text / tool trail · raw RPC log |
| `send` · `followup` · `stop` | steer, queue a follow-up, abort |
| `report <name>` | final report (+ steering-log appendix); exit 2 if none |
| `diff <name> [--name-only]` · `merge <name> [--no-commit]` | review and integrate (exit 5 on conflicts) |
| `cleanup <name\|all> [--force]` | remove worktree + branch, archive run |
| `open` · `attach <name>` | interactive console |
| `install-claude-skill` | link the orchestrator skill for Claude Code |

Exit codes: `0` ok · `1` refusal/error · `2` no report · `3` wait timeout · `4` run ended
stopped/error/dead · `5` merge conflict.

## How it works

`spawn` creates `<repo>/.pi-fleet/runs/<id>/` (git-ignored) plus a worktree on branch
`pi-fleet/<name>-<short7>` and launches a detached monitor that owns `pi --mode rpc`. The monitor
records `events.jsonl`, `rpc.log`, and `state.json`; it forwards `control.jsonl` lines
(`steer`/`follow_up`/`abort`, tagged `orchestrator` or `console`) to pi. Workers see
`PI_FLEET_RUN`/`PI_FLEET_DIR` and the report protocol in their system prompt; their report lands in
`.pi-fleet/reports/<id>.md` with sections Status / Summary / What I did / Files changed /
Verification / Decisions & assumptions / Steering received / Open questions / Suggested next step.

## Development

```bash
pnpm typecheck && pnpm test   # hermetic: uses tests/fixtures/fake-pi.mjs
pnpm test:e2e                 # real pi + real model (costs tokens); PI_FLEET_E2E_MODEL=<pattern>
```

Design spec and plan: `docs/superpowers/`.
```

- [ ] **Step 2: Verify the package**

Run: `pnpm typecheck && pnpm test && pnpm build && node dist/cli.js --help && npm pack --dry-run 2>&1 | grep -E 'dist/cli.js|pi/extensions/fleet-report.ts|pi/skills/fleet-worker-report/SKILL.md|claude/skills/pi-orchestrator/SKILL.md|README.md'`
Expected: all green; `--help` lists the commands (no `__monitor`); all five files appear in the pack listing.

- [ ] **Step 3: Commit**

```bash
git add README.md package.json
git commit -m "docs: README with install surfaces, quickstart, command table"
```
