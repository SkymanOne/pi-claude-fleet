# pi-claude-fleet — Design Spec

- **Date:** 2026-08-28
- **Status:** Approved (pending implementation)
- **Author:** Collaborative design session (Claude orchestrator + skymanone)

## 1. Problem & Goal

Claude Code and pi are both capable coding agents, but they don't interoperate as
orchestrator/worker. Existing bridges go the other way (`pi-claude-bridge` embeds Claude
Code inside pi as a provider or `AskClaude` delegate; `pi-subagents` lets pi spawn pi
children). Nothing lets **Claude Code act as the orchestrator of pi agents**.

Goal: Claude Code decomposes a plan into execution steps, instructs headless pi agents to
execute them, monitors their progress, receives structured summary reports back, and
drives the plan forward step by step.

## 2. Decisions (from design session)

| Decision | Choice |
| --- | --- |
| Integration mechanism | CLI (`pi-fleet`) invoked by Claude Code via Bash + skills teaching the loop |
| Worker execution model | Headless `pi --mode rpc` background processes managed by the CLI |
| Packaging | One npm package containing CLI + pi resources + Claude Code skill |
| Concurrency safety | Git worktree isolation per worker by default |
| Direction | Claude Code = orchestrator; pi = workers; reports flow back; Claude drives forward |

## 3. Deliverable: `pi-claude-fleet`

One repository at `~/Projects/pi-claude-fleet`, one npm package named `pi-claude-fleet`
(keyword `pi-package`). Node >= 20, ESM, **zero runtime dependencies** (Node stdlib only:
`node:child_process`, `node:fs`, `node:path`, `node:os`, `node:test`).

```text
pi-claude-fleet/
├── package.json                  # name pi-claude-fleet, bin pi-fleet, pi manifest
├── bin/pi-fleet.mjs              # CLI entrypoint (bin: pi-fleet)
├── src/                          # CLI implementation (ESM, split by concern)
│   ├── cli.mjs                   # arg parsing + command dispatch
│   ├── spawn.mjs                 # spawn/monitor launcher
│   ├── monitor.mjs               # __monitor: owns pi subprocess, captures events
│   ├── console.mjs               # open (run menu) + attach (live view/steering TUI)
│   ├── state.mjs                 # state.json read/write, status derivation
│   ├── worktree.mjs              # git worktree add/remove, branch naming
│   ├── report.mjs                # report file lookup + fallback
│   └── util.mjs                  # rpc line framing, misc helpers
├── pi/
│   ├── extensions/fleet-report.ts
│   └── skills/fleet-worker-report/SKILL.md
├── claude/skills/pi-orchestrator/
│   ├── SKILL.md
│   └── references/cli.md
└── docs/superpowers/specs/       # this spec + implementation plan
```

**Installation surfaces (3):**

1. `npm install -g .` (or `npm link` in dev) → `pi-fleet` on PATH
2. `pi install <path-to-repo>` → loads `pi/` resources via the `pi` manifest
   (`"pi": {"extensions": ["pi/extensions"], "skills": ["pi/skills"]}`)
3. `pi-fleet install-claude-skill` → symlinks `claude/skills/pi-orchestrator` into
   `~/.claude/skills/pi-orchestrator` (prints where it linked; refuses with clear message
   if the path exists and is not our symlink)

## 4. The `pi-fleet` CLI

### 4.1 Commands

```text
pi-fleet spawn <name> [--cwd <dir>] [--model <pattern>] [--provider <name>]
              [--thinking <level>] [--no-worktree] [--base <ref>]
              [--skill <path>] [--append-system-prompt <text>] [--session <path|id>]
              [--tools <list>] [-xt <list>] -- "<task brief>"
pi-fleet status [<name>] [--json]
pi-fleet wait <name> [--timeout <sec>]
pi-fleet open                             # interactive run menu → attach
pi-fleet attach <name>                    # live chat view + steering input
pi-fleet send <name> -- "<steer message>"
pi-fleet followup <name> -- "<message>"
pi-fleet output <name> [--tail <n>]
pi-fleet report <name>
pi-fleet diff <name> [--name-only]
pi-fleet merge <name> [--no-commit]
pi-fleet stop <name>
pi-fleet logs <name> [--tail <n>]
pi-fleet cleanup <name|all> [--force]
pi-fleet install-claude-skill
pi-fleet __monitor <run-id>           # internal; not advertised in help
```

### 4.2 spawn

1. Resolve `--cwd` (default `.`); refuse if it doesn't exist. Determine the **fleet dir**:
   the git repo root containing the target (via `git rev-parse --show-toplevel`), or the
   target dir itself if not a git repo. All `.pi-fleet/` state (runs, reports, worktrees)
   lives in `<fleetDir>/.pi-fleet/` — i.e. state lives where the work happens, so Claude
   can read it from the project it's orchestrating.
2. **Worktree** (unless `--no-worktree`):
   - If target is a git repo (or inside one): create
     `git worktree add <fleetDir>/.pi-fleet/worktrees/<runId> -b pi-fleet/<name>-<short7> <base>`
     where `<base>` is `--base` or current HEAD of the orchestrating checkout.
   - If NOT a git repo: print a warning to stderr and run in place (no worktree).
3. Create run dir `<fleetDir>/.pi-fleet/runs/<runId>/` with initial `state.json`:
   `{id, name, status:"starting", cwd, worktree|null, branch|null, base, model, provider,
   thinking, pid:null, createdAt, settledAt:null, lastTool:null, lastActivity:null,
   lastAssistantText:null, error:null}`
4. Launch **detached** monitor: `node <cliPath> __monitor <runId>` via
   `child_process.spawn` with `detached: true`, stdio piped to run-dir files, `unref()` —
   so the run survives the orchestrating process exiting.
5. Print a short confirmation: run id, name, worktree path, branch, log paths. Exit 0.

Monitor loop (`__monitor`):

1. Spawn `pi --mode rpc --session-dir <runDir>/session` plus passthrough of `--provider`,
   `--model`, `--thinking`, `--skill`, `--append-system-prompt`, `--tools`, `-xt`, and
   `--session` when supplied. Sessions always persist (never `--no-session`) so runs are
   resumable. Child cwd = worktree or target dir; env `PI_FLEET_RUN=<runId>`,
   `PI_FLEET_DIR=<fleetDir>/.pi-fleet`.
2. On stdout, read JSONL (split strictly on `\n`, strip trailing `\r`) and append every
   raw line to `rpc.log`; parse each and append selected events to `events.jsonl`
   (`agent_start`, `agent_end`, `agent_settled`, `turn_end`, `tool_execution_start`,
   `tool_execution_end`, `extension_error`, `auto_retry_start/end`,
   `compaction_start/end`). From these derive `lastTool`, `lastActivity` timestamps.
3. Send `{"type":"prompt","message":"<task brief + report-protocol reminder>"}`.
4. On `agent_settled`: send `get_last_assistant_text`, store it in state, set
   `status:"settled"`, `settledAt`.
5. On process exit without `agent_settled`: set `status:"error"` with tail of stderr in
   `state.error`.
6. Also handle `abort` initiated externally (`stop` command): mark `stopped`.
7. Store the **monitor's own pid** in `state.pid` at startup (the monitor owns the pi
   child; liveness of the monitor implies liveness of the pair, and it is the process an
   external `stop`/kill must target first).

### 4.3 Progress, wait, status

- `status` prints a compact table:
  `NAME  STATE  LAST-ACTIVITY  LAST-TOOL  AGE` where STATE ∈
  `starting|running|settled|stopped|error|dead` (dead = pid no longer alive and no
  settled marker). `--json` emits the full state objects. `status <name>` prints one
  run's full state.
- `wait` polls state.json every 2s until status ∈ {settled, stopped, error, dead} or
  `--timeout` (default 600s). Exit 0 on settled, exit 3 on timeout, exit 4 on
  stopped/error/dead. This gives the orchestrator a machine-readable way to adapt.
- `output` prints the stored last assistant text; `--tail <n>` prints the last n
  `tool_execution_end` summaries (tool name + first line of result) as an activity trail.
- `logs` tails `rpc.log` / prints recent `events.jsonl` lines.

### 4.4 Steering & follow-up

- Control channel: `send`, `followup`, and the live console (§4.5) all append control
  messages to the run's `control.jsonl`: `{type:"steer"|"follow_up"|"abort", message,
  source:"orchestrator"|"console", ts}`. The monitor watches the file (fs.watch on the
  run dir, fallback 500ms poll) and forwards steer/follow_up to the pi child's stdin as
  the matching RPC command; `abort` triggers the `abort` RPC command.
- Provenance is recorded: on delivery the monitor appends a `steering_delivered` entry
  to `events.jsonl`, increments `state.steerCount`, and appends `{source, ts, message}`
  (last 20) to `state.steeringLog`.
- If the agent has settled, `send`/`followup`/console steering refuse and print guidance
  to `spawn` a new run with `--session` to resume, or answer open questions first.

### 4.5 Console: live view + steering (`open` / `attach`)

Human-in-the-loop console. Zero-dependency implementation (node:readline raw mode + ANSI
escape codes; no TUI frameworks).

**`pi-fleet open`** — interactive menu:

- Lists all non-archived runs: `#  NAME  STATE  LAST-ACTIVITY  LAST-TOOL  STEERED  AGE`
  (STEERED shows steer count). Keys: number to attach, `r` refresh, `q` quit; arrow/Enter
  selection when the terminal supports it (fallback: type the number).
- Also reachable non-interactively: `pi-fleet attach <name>` attaches directly.

**Live view (`attach`)** — a follow-style renderer over the run's captured stream:

- Replays the last ~40 lines of `events.jsonl` (assistant text, tool activity, steering
  delivered), then follows new events by polling the file every ~250ms (fs.watch with
  poll fallback). Renders:
  - steering/user messages: `▶ <source>: <message>`
  - assistant streaming text (from `message_update` text deltas, assembled per
    contentIndex)
  - tool calls: `⚙ <toolName> <args summary>` on start; first line of result on end
  - state header line (name, state, model, branch) + footer hint line
- Input line at the bottom (always visible): typing text + Enter sends a **steer**
  (source `console`) via `control.jsonl`; slash commands: `/followup <msg>`, `/stop`
  (abort the run), `/quit` (detach; the run keeps running in the background).
- If the run is settled/stopped/error/dead: view is read-only transcript mode with a
  footer hint (`resume: pi-fleet spawn <name>-2 --session <path> -- "<new brief>"`), and
  steering input is disabled.
- Concurrent attaches are allowed (multiple viewers are just file readers); a warning is
  printed when a run already has an active console (marker file `runs/<id>/console.lock`
  with pid + timestamp, refreshed every 5s, expired entries ignored).

### 4.6 diff / merge / cleanup

- `diff <name>`: `git -C <worktree> diff --stat <base>...HEAD` (plus `--name-only` mode).
  Non-worktree runs print "not applicable".
- `merge <name>`: from the orchestrating checkout, `git merge pi-fleet/<name>-<short7>`
  (`--no-commit` passes `--no-commit --no-ff`). On conflict: exit 5 with the conflict
  file list; the orchestrator (Claude) resolves with normal tooling, then completes the
  merge itself. Never auto-push; never merge when state is `error` (refuse, print state).
- `cleanup <name|all>`: only for runs whose state ∈ {settled, stopped, error, dead}
  (unless `--force`): `git worktree remove` (then `git branch -D` the run branch if
  merged; keep branch if unmerged unless `--force`), delete worktree dir, set
  `status:"archived"`. Runs' reports and events are kept for the audit trail.

## 5. Report protocol (pi side)

Env contract set by monitor for every run: `PI_FLEET_RUN=<runId>`, `PI_FLEET_DIR=<abs
path to .pi-fleet>`.

### 5.1 Extension `fleet-report.ts`

Loaded via the package `pi` manifest. On session start, if `process.env.PI_FLEET_RUN` is
set, injects an agent-visible instruction message containing:

- You are a fleet worker (run id, worktree cwd).
- Before finishing, write your final report to
  `<PI_FLEET_DIR>/reports/<PI_FLEET_RUN>.md` using the exact template in §5.2.
- For long tasks, append brief progress notes (one line per milestone) to
  `<PI_FLEET_DIR>/runs/<PI_FLEET_RUN>/progress.md`.
- Stay scoped to your task brief; do not touch files outside the worktree; do not run
  `git merge` or modify the parent checkout.
- If you receive steering messages mid-run (course corrections from the orchestrator or
  the user's console), incorporate them immediately, and your final report MUST reflect
  the adjusted direction — note any steering you received under "Steering received" and
  keep Status/Verification consistent with the work as finally done.

This makes report-writing deterministic regardless of model skill-following.

### 5.2 Skill `fleet-worker-report`

Detailed writing guidance for the report template:

```markdown
# Fleet Report: <run name>

## Status
done | blocked | failed

## Summary
(3-8 sentences: what was accomplished and the outcome)

## What I did
(numbered steps actually taken)

## Files changed
(path: one-line reason — from the worker's actual edits)

## Verification
(command run → result, for each check performed)

## Decisions & assumptions
(any choice made without explicit instruction)

## Steering received
(mid-run course corrections you were given and how you handled them; "none" if none)

## Open questions for orchestrator
(thing I could not resolve — empty if none; REQUIRED if Status: blocked)

## Suggested next step
(one concrete next action for the orchestrator)
```

Both the skill and the injected message point to the same template.

### 5.3 Report read side

- `pi-fleet report <name>`: if `reports/<id>.md` exists, print it; else print captured
  `lastAssistantText` labeled as fallback; exit 2 if neither exists.
- The command then appends an orchestrator-side **steering log** appendix rendered from
  `state.steeringLog` (source, timestamp, message — console vs orchestrator), so the
  orchestrator always sees who steered the worker and when, even if the worker's own
  "Steering received" section is thin.

## 6. Claude Code orchestrator skill `pi-orchestrator`

`claude/skills/pi-orchestrator/SKILL.md` with `references/cli.md` (command reference +
JSON schemas of state). Skill content (concise, imperative):

1. **Plan**: turn the user's goal into ordered steps with dependencies; make a todo list;
   identify which steps are independent (parallelizable) and which need sequencing.
2. **Brief**: for each step write a task brief — goal, relevant context, constraints,
   definition of done, verification commands, and "write your fleet report before
   finishing". One step = one worker; keep briefs self-contained (workers see nothing
   else).
3. **Spawn**: `pi-fleet spawn <kebab-name> --cwd <repo> [--model ...] -- "<brief>"`.
   Parallel only for independent steps; default cap **3 concurrent workers** (state it to
   the user). Read-only steps (research/review) use `--no-worktree`.
4. **Monitor**: after spawning, report to the user what's running; then loop: `pi-fleet
   wait <name> --timeout 120` → on timeout check `status`/`output` for liveness, keep
   waiting or surface a stall to the user; never busy-poll in a tight loop.
5. **Collect**: on settle, `pi-fleet report <name>` → summarize the outcome for the user
   in 2-4 sentences (status, what was done, verification results).
6. **Integrate**: `pi-fleet diff <name>` to review the change; `pi-fleet merge <name>`;
   run integration checks in the parent checkout; resolve conflicts from worker reports
   if any (exit 5).
7. **Human console interventions**: the user may open `pi-fleet open` and steer a worker
   mid-run. The worker's report (and the steering-log appendix) reflects those
   interventions — always re-read the report after any console interaction, reconcile
   your plan with the adjusted direction, and don't undo console steering decisions
   unless the work is actually wrong.
8. **Blocked handling**: if a report says `blocked` or `failed`, read its open questions;
   either answer them yourself and `pi-fleet send` (if still running) or spawn a fresh
   resumed run (`--session` + new brief). Diagnose repeated failures from `logs` before
   retrying; escalate to the user after 2 failed attempts on the same step.
9. **Drive forward**: update the todo list, spawn the next step(s), and repeat until the
   plan is complete. Then `cleanup all` and give the user a final rollup (per-step
   outcomes, merged changes, verification results).

Guardrails stated in the skill: never merge a failed worker; never edit a worker's
worktree directly (steer instead); keep the user informed at each step transition;
workers are cheap — prefer a fresh, better-briefed worker over endless steering.

## 7. Data & file formats

- `state.json` — single JSON object, written atomically (tmp file + rename). Schema as in
  §4.2 step 3 plus `status` extensions `archived`, plus steering fields `steerCount`
  (number) and `steeringLog` (last 20 `{source, ts, message}`).
- `events.jsonl` — one JSON object per line: a subset of pi RPC events (documented in
  `references/cli.md`) plus fleet events `steering_delivered` and `abort_requested`.
- `control.jsonl` — orchestrator/console→monitor control messages:
  `{type:"steer"|"follow_up"|"abort", message, source:"orchestrator"|"console", ts}`.
- `reports/<id>.md` — §5.2 template.
- `.pi-fleet/` is project-local and must be added to the repo's `.gitignore` by `spawn`
  if not present (one-time, appended with a `# pi-fleet` marker comment).
- Run IDs: `<name>-<YYYYMMDD-HHMMSS>`; branches: `pi-fleet/<name>-<short7 of id>`.

## 8. Error handling

- pi process dies unexpectedly → `status:"error"`, `error` = last stderr lines; `wait`
  exits 4; orchestrator skill says: check `logs`, then respawn with `--session <id>` to
  resume the worker's session.
- Non-zero pi RPC responses (e.g. prompt rejected) → logged to `events.jsonl`, surfaced
  in `output`/`logs`; monitor marks `error` if it prevents settling.
- `spawn` on non-git dir with worktree default → warning + in-place run (documented).
- Refusals (merge on error state, cleanup of running run, send to settled run) exit
  non-zero with explicit guidance text.
- Attaching to a non-running run → read-only transcript mode with resume hint (not an
  error); steering into a settled run refuses with resume guidance.
- Monitor itself crashes → stale run detected by `dead` state (pid liveness + no
  settled marker); `cleanup --force` recovers the worktree. `attach` to a run whose
  monitor is dead falls back to a static tail of the captured logs.

## 9. Testing

- **Unit (node:test):** state transitions & atomic writes; JSONL framing (CRLF, unicode
  separators inside strings); worktree module against a temp git repo (add/branch/remove,
  dirty-unmerged protection); report fallback logic; control.jsonl parsing incl.
  provenance field; steeringLog/steerCount updates.
- **E2E (script):** temp git repo → `pi-fleet spawn hello --cwd <tmp> --model
  <cheap-model> -- "Create hello.txt containing 'hi', verify, write your fleet report."`
  → assert worktree created, `wait` settles, report exists with `## Status`, `diff`
  shows hello.txt, `merge` succeeds, file exists in parent, `cleanup` removes worktree +
  branch. Second scenario: append a `control.jsonl` steer (source `console`) mid-run and
  assert a `steering_delivered` event lands, `state.steerCount` increments, and the final
  report carries a non-"none" "Steering received" section. Cheap default model: the
  user's pi default (openrouter glm-5.3-flash) is acceptable for tests.
- **Manual:** real orchestration run on a small repo via the `pi-orchestrator` skill;
  `pi-fleet open` menu → attach → live view updates while working → steer from the
  console → detach → verify final report reflects the steering.

## 10. Out of scope (v1)

- MCP server surface (CLI-first; can be added later on the same state files)
- Automatic conflict resolution (Claude resolves via the skill)
- Cross-machine fleets / remote workers
- pi→Claude live questioning mid-run (covered async via report open-questions + steering)
