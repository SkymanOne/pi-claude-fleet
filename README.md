# pi-claude-fleet

A terminal app that runs a fleet of [pi](https://github.com/earendil-works/pi-mono) coding agents with Claude Code as the orchestrator.

You run `pi-fleet` in a repository. It starts Claude Code as a child process, gives it a set of fleet tools, and shows you both sides: your conversation with the orchestrator on one pane, every worker on a rail beside it. The orchestrator plans the work and spawns pi workers, each in its own git worktree. Workers report back through files. You can watch any worker, steer it, or answer its questions yourself, and the orchestrator finds out what you did.

Nothing runs inside a Claude Code session, and there is no skill to install. The orchestrator is an ordinary `claude -p` process that this app owns.

Requirements: Node 22 or newer, `pi` on your PATH, and `claude` (Claude Code 2.1.x) on your PATH and logged in.

## Install

```bash
pnpm install && pnpm build   # compiles src/ to dist/
pnpm link --global           # puts `pi-fleet` on your PATH (npm users: npm install -g .)
pi-fleet --help              # verify
```

`pnpm unlink --global pi-claude-fleet` removes it.

The pi-side extension and skill travel with the CLI: every worker is spawned with `--extension pi/extensions/fleet-worker.ts --skill pi/skills/fleet-worker-report`, so there is nothing to install on the pi side. If you also want the worker tools and skill available in ordinary pi sessions, `pi install /absolute/path/to/pi-claude-fleet` registers the package (add `-l` for a project-local install); the extension does nothing unless `PI_FLEET_RUN` is set.

## Using it

```bash
cd your-repo
pi-fleet
```

Then talk to the orchestrator: *"Add token refresh to the auth module and update the tests."* It writes briefs, spawns workers, and reports back as they finish.

```text
┌ ○ orchestrator        > add token refresh, then tests ─────────────┐
│ ● add-auth              ⚙ mcp__fleet__fleet_spawn add-auth        │
│ ? add-tests             ↳ Spawned add-auth-20260829120000         │
│                       I started add-auth. add-tests is asking     │
│ blocked 2m            which fixture style to use.                 │
│                       orchestrator >                              │
├ sonnet · a1b2c3d4 · $0.12 · 3 turns · tab switch · esc interrupt ─┤
└────────────────────────────────────────────────────────────────────┘
```

Keys: `tab` / `shift-tab` or the arrow keys switch between the orchestrator and the workers, `esc` interrupts the orchestrator's turn (or closes help), `ctrl-c` quits. Only non-printable keys are bound, so a message that starts with "q" does not quit the app.

The composer at the bottom sends to whatever is selected. With the orchestrator selected it is a normal message. With a worker selected:

| You type | What happens |
|---|---|
| any text | steers that worker (delivered after its current tool call) |
| `/answer <text>` | answers the question it is blocked on (`/answer <questionId> <text>` to pick one) |
| `/followup <text>` | queues a message for when it finishes its current work |
| `/stop` | aborts it |
| `/help`, `/quit` | this help, and quit |

When the orchestrator wants to run something outside its allowlist, or asks you a question, an overlay appears: `y` allows once, `a` allows it for the session, `n` denies with a reason, and questions get an option picker.

Quitting stops the orchestrator but leaves workers running; they are detached processes with their state on disk. `pi-fleet` reopens the console and resumes the same orchestrator session (`--fresh` starts a new one).

Options: `--cwd <dir>`, `--model <model>`, `--fresh`, `--budget <usd>`, `--progress-events` (forward workers' progress notes to the orchestrator, off by default because they are chatty).

## What the orchestrator can and cannot do

It coordinates; it does not type code. `Edit`, `Write` and `NotebookEdit` are disabled for it. It can read the repository and run read-only git commands without asking; anything else prompts you. Merge conflicts go back to the worker as a rebase brief rather than being fixed in place.

Its tools, all backed by the same code as the CLI subcommands:

`fleet_spawn`, `fleet_status`, `fleet_wait`, `fleet_output`, `fleet_logs`, `fleet_send`, `fleet_followup`, `fleet_answer`, `fleet_stop`, `fleet_report`, `fleet_diff`, `fleet_merge`, `fleet_cleanup`.

They are served by `pi-fleet mcp`, a stdio MCP server that Claude Code spawns itself. The orchestrator's role, the tool semantics and the event format live in [prompts/orchestrator.md](prompts/orchestrator.md).

## How a worker talks back

A worker never sees your conversation. It gets a brief, and it answers through files in `.pi-fleet/`:

- Its **report** (`reports/<runId>.md`) with fixed sections: Status, Summary, What I did, Files changed, Verification, Decisions & assumptions, Steering received, Open questions, Suggested next step.
- **`fleet_ask`**, a tool that posts a question and blocks until someone answers. The rail shows the worker as `?`, the orchestrator gets a `question` event, and either it or you can answer. If nobody answers within ten minutes the worker proceeds on its own judgment and records that under Decisions.
- **`fleet_progress`**, one-line milestones.

Everything a worker does becomes a fleet event, and the app injects those into the orchestrator's conversation as they happen:

```text
<fleet-event kind="settled" run="add-auth-20260829120000" name="add-auth" id="ev_…" ts="…">
status: settled
report: /repo/.pi-fleet/reports/add-auth-20260829120000.md (present)
branch: pi-fleet/add-auth-9120000
next: fleet_report name="add-auth"; then fleet_diff and fleet_merge, then the integration checks
</fleet-event>
```

Kinds: `settled`, `stopped`, `error`, `dead`, `question`, `question_resolved`, `answered_by_console`, `console_steer`, `progress`, `snapshot`. Events that come from you (an answer or a steer you typed) are labelled as such, so the orchestrator reconciles instead of undoing your work. Worker text can never forge or close one of these blocks.

## Headless commands

The TUI is one client; the same fleet is driveable from scripts.

| Command | What it does |
|---|---|
| `spawn <name> [opts] -- "<brief>"` | start a worker (`--cwd`, `--model`, `--provider`, `--thinking`, `--no-worktree`, `--base`, `--skill`, `--append-system-prompt`, `--session`, `--tools`, `--exclude-tools`) |
| `status [<name>] [--json] [--all]` | fleet table, or one run's full state |
| `wait <name> [--timeout s]` | block until the run reaches a terminal state |
| `output <name> [--tail n]` | last assistant text, or the last n tool results |
| `logs <name> [--tail n]` | tail of the raw RPC log |
| `send`, `followup`, `answer`, `stop` | steer, queue a follow-up, answer a question, abort |
| `report <name>` | the final report with the steering log appended; exit 2 if there is none |
| `diff <name> [--name-only]` | what the worker changed against its base commit |
| `merge <name> [--no-commit]` | merge the worker's branch; exit 5 on conflicts |
| `cleanup <name\|all> [--force]` | remove the worktree and branch, archive the run |
| `attach <name> [--tail n]` | print a worker's transcript tail |
| `mcp` | serve the fleet tools over stdio (what the orchestrator runs) |

Exit codes: 0 ok, 1 refusal or error, 2 no report, 3 wait timed out, 4 the run ended stopped/error/dead, 5 merge conflict.

## Files under `.pi-fleet/`

`spawn` creates `<repo>/.pi-fleet/` and adds it to `.gitignore`. It is the audit trail; nothing else needs to read it.

| Path | What it holds |
|---|---|
| `runs/<id>/state.json` | the run's durable facts: status, worktree, branch, base commit, last tool and activity, steering log, pending question |
| `runs/<id>/events.jsonl` | the transcript: selected pi RPC events plus fleet events (`steering_delivered`, `worker_question`, `worker_progress`, `answer_delivered`, …) |
| `runs/<id>/control.jsonl` | inbox: `steer`, `follow_up`, `abort`, `answer` lines from the orchestrator or from you |
| `runs/<id>/outbox.jsonl` | outbox: the worker's `question`, `progress` and `question_resolved` envelopes |
| `runs/<id>/rpc.log`, `monitor.log` | raw pi stream and the monitor's own output |
| `reports/<id>.md` | the worker's final report |
| `orchestrator.json`, `orchestrator.log`, `orchestrator.prompt.md` | the claude session id and watcher cursors, the raw protocol log, the rendered prompt |

Status is derived, never stored: a run whose monitor is gone reads as `dead`, and a running worker waiting on `fleet_ask` reads as `blocked`.

One thing to know: `diff` and `merge` only see committed work. If a worker forgets to commit, `diff` warns on stderr and a non-forced `cleanup` refuses to delete the dirty worktree. Brief your workers to commit.

## How it fits together

```text
pi-fleet (ink TUI)
 ├── claude -p  (stream-json over stdio: messages in, transcript and permission
 │              prompts out; the orchestrator's session id is saved for --resume)
 │    └── pi-fleet mcp  (stdio MCP: the fleet_* tools, over .pi-fleet/)
 ├── monitors  (detached; each owns one `pi --mode rpc` worker in its worktree)
 └── watcher   (tails every run's state and events → the rail, and → <fleet-event>)
```

Each piece keeps its own state on disk, so the console can come and go without disturbing the workers.

## Development

```bash
pnpm typecheck && pnpm test    # hermetic: fake pi and fake claude, no tokens spent
pnpm test:e2e                  # real pi and real claude, so it costs money
```

`pnpm test:e2e` runs three scenarios: a pi worker end to end, console steering mid-run, and the real orchestrator driving a worker through the MCP tools. Narrow it with `PI_FLEET_E2E_ONLY=pi|claude`, choose models with `PI_FLEET_E2E_MODEL` and `PI_FLEET_E2E_CLAUDE_MODEL` (default `haiku`), or skip the claude scenario with `PI_FLEET_E2E_NO_CLAUDE=1`.

`scripts/spike-claude-protocol.ts` probes the real `claude` binary for the protocol facts this app depends on (whether permission prompts need a handshake, whether `mcp__fleet__*` suppresses them, how a mid-turn message is delivered). Its findings are recorded at the top of the file; re-run it after a Claude Code upgrade.

Test knobs: `PI_FLEET_PI_BIN` and `PI_FLEET_CLAUDE_BIN` replace the two binaries, `PI_FLEET_DEV=1` makes the CLI re-invoke itself through tsx instead of `dist/`, and `PI_FLEET_ASK_TIMEOUT_MS` shortens a worker's `fleet_ask` wait.

The design spec and the implementation plan are in `docs/superpowers/`; the plan's "Deviations from the spec" table is the quickest way to see where the code and the spec differ.
