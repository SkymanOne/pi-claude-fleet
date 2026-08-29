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
┌───────────────────────────────────────────────────────────────────┐
│▸○ orchestrator      > add token refresh, then tests               │
│   idle                                                             │
│  ─────────────      I started add-auth. add-tests is asking which │
│ ● add-auth      2m  fixture style to use.                         │
│   ⚙ bash                                                           │
│ ? add-tests     1m  orchestrator >                                │
│   needs an answer                                                  │
├ claude-opus-5 · a1b2c3d4 · $0.12 · 3 turns · tab switch · esc ────┤
└───────────────────────────────────────────────────────────────────┘
```

Each rail row carries what that session is doing — the tool a worker is in, `needs an answer` when it is blocked, the first line of its error when it failed — with its age on the right. The glyph carries the state (`○` idle, `●` working, `?` blocked or waiting on you, `✓` done, `!` failed), the selected row is marked with `▸`, and the rail widens to fit your worker names.

The status line describes whatever is selected: for a worker its state, model, reasoning level and branch, so you always see the model that worker is actually running (what pi resolved, not just the pattern you asked for); for the orchestrator its model, session, spend and turns.

Remote Control is a launch flag rather than something the session can be told mid-conversation, so `/rc` has the monitor swap claude for a new process with the flag set. The monitor itself stays up and the conversation is resumed, so the orchestrator does not stop and no console sees the session end. `pi-fleet --remote-control [name]` starts that way, and the choice is remembered if the orchestrator restarts.

Tool calls are shown as written rather than clipped to fit, so a long command stays readable. Tool output is a preview: the first few lines, then a count of what was left out, since output can run to megabytes.

A line above the composer says what the selected session is doing while it works — `✻ thinking… 12s`, `✎ replying…`, or the tool it is in — and the rail says the same for every session at a glance.

Keys: `tab` / `shift-tab` (or `ctrl+n` / `ctrl+p`) switch between the orchestrator and the workers, `esc` interrupts the orchestrator's turn, `ctrl-c` quits. Only non-printable keys are bound, so a message that starts with "q" does not quit the app.

The composer at the bottom sends to whatever is selected. With the orchestrator selected it is a normal message. With a worker selected:

| You type | Short | Key | What happens |
|---|---|---|---|
| any text | | | steers that worker (delivered after its current tool call) |
| `/answer <text>` | `/a` | `ctrl+a` | answers the question it is blocked on (`/answer <questionId> <text>` to pick one) |
| `/followup <text>` | `/f` | `ctrl+f` | queues a message for when it finishes its current work |
| `/stop` | `/s` | `ctrl+x` | aborts it |
| `/remove` | `/rm` | `ctrl+r` | removes it: worktree, branch and rail row (asks first if that would destroy work) |
| `/thinking <level>` | `/t` | `ctrl+t` | set the reasoning level of the open session — pi's `off…max` for a worker, claude's `low…max` for the orchestrator. The key steps to the next level, each session keeps its own, and the change is a passing note rather than a turn in the conversation |
| `/permissions <mode>` | `/p` | `ctrl+o` | how the orchestrator's tool use is approved; with no argument it says what is in force |
| `/rc [name]` | | | put the orchestrator on Claude Code Remote Control so you can watch it from elsewhere |
| `/rail <mode>` | `/rw` | `ctrl+b` | width of the session list: `compact`, `auto`, `wide`, or `full`. The key steps through them, `full` gives the list the whole window with nothing clipped, and the choice is remembered |
| `/help` | `/h` | `ctrl+g` | keys and commands |
| `/quit` | `/q` | `ctrl+d` | leave the console; workers keep running |
| `/shutdown` | `/sd` | `ctrl+k` | stop the orchestrator and every worker, then exit (asks first; worktrees and branches are kept) |

Typing `/` lists the commands available for the selected session, and `@` lists the workers and then the repository's files. `tab` accepts the highlighted suggestion, `up` and `down` move through them, and with no suggestions open `up` recalls what you sent to that session before.

The list is not only the console's own commands: it also carries whatever the agent on the other end offers. For the orchestrator that is Claude Code's slash commands and skills (`/model`, `/usage`, any skill you have installed), learned from its handshake and passed through verbatim. For a worker it is pi's commands, skills and prompt templates (`/skill:some-skill`, extension commands), which the worker reports when it starts; the console delivers them as a pi `prompt`, the one form that runs extension commands as well as expanding skills.

When the orchestrator wants to run something outside its allowlist, or asks you a question, an overlay appears: `y` allows once, `a` allows it for the session, `n` denies with a reason, and questions get an option picker.

How often that happens is up to you. `/permissions auto` hands routine approvals to a classifier and only escalates what it is unsure about; `acceptEdits` lets file edits and common filesystem commands through; `dontAsk` denies anything not already allowed instead of asking; `plan` makes the orchestrator read-only. `default` asks about everything outside the allowlist. Start in a mode with `pi-fleet --permission-mode auto`; the mode is shown in the status line whenever it is not the default, survives a console restart, and `bypassPermissions` is deliberately not offered — it would skip the overlay altogether.

The transcript separates the parts of a turn: your prompts in cyan, the model's reasoning dimmed and abridged, its answer as rendered markdown (headings, emphasis, inline code, lists, links and tables laid out in columns), tool calls in blue with their results dimmed under them, and fleet events in yellow — each block set off by a blank line.

Workers disappear from the rail when they are done: the orchestrator removes each one after it merges and verifies it, and the console removes any settled worker whose branch is already merged. Nothing unmerged, dirty or still running is ever removed for you — that waits for `/remove`, which tells you exactly what would be lost before it does anything.

Quitting closes the console, nothing else. Reopening restores the conversation: if the orchestrator is still running you attach to it live, and if it is not — after a reboot, or a `/shutdown` — a new one resumes the same claude session under the transcript you already had, with a line marking the seam. `--fresh` is the way to start over.

The orchestrator and its workers are detached processes with their state on disk, so `pi-fleet` reopens where you left off: the same claude session, still mid-thought if it was working, with its transcript replayed. A permission prompt raised while no console was open is still waiting for you when you return. `--fresh` starts a new orchestrator instead of attaching.

`/shutdown` is the other exit: it stops the orchestrator and every worker, after telling you how many are running. Worktrees and branches are kept.

Options: `--cwd <dir>`, `--model <model>`, `--permission-mode <mode>`, `--remote-control [name]`, `--fresh`, `--budget <usd>`, `--progress-events` (forward workers' progress notes to the orchestrator, off by default because they are chatty).

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
| `spawn <name> [opts] -- "<brief>"` | start a worker (`--cwd`, `--model`, `--provider`, `--thinking`, `--no-worktree`, `--base`, `--skill`, `--append-system-prompt`, `--session`, `--tools`, `--exclude-tools`). A `--model` pi does not have is refused before a worktree exists, naming the closest models it does have |
| `status [<name>] [--json] [--all]` | fleet table, or one run's full state |
| `wait <name> [--timeout s]` | block until the run reaches a terminal state |
| `output <name> [--tail n]` | last assistant text, or the last n tool results |
| `logs <name> [--tail n]` | tail of the raw RPC log |
| `send`, `followup`, `answer`, `stop` | steer, queue a follow-up, answer a question, abort |
| `status --json` | includes each run's `activeModel`, `pendingQuestion` and the `commands` it offers |
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
| `runs/<id>/control.jsonl` | inbox: `steer`, `follow_up`, `abort`, `answer`, `command` lines from the orchestrator or from you |
| `runs/<id>/outbox.jsonl` | outbox: the worker's `question`, `progress` and `question_resolved` envelopes |
| `runs/<id>/rpc.log`, `monitor.log` | raw pi stream and the monitor's own output |
| `reports/<id>.md` | the worker's final report |
| `orchestrator/state.json` | the orchestrator's durable facts: monitor pid, claude session id, model, commands, cost, turns, what it is doing, and any permission prompt waiting for you |
| `orchestrator/events.jsonl` | its transcript: claude's messages, coalesced token deltas, activity and permission records |
| `orchestrator/control.jsonl` | inbox: your messages, permission answers, interrupts, effort changes, stop |
| `orchestrator/claude.log`, `monitor.log`, `prompt.md` | the raw protocol log, the monitor's own output, the rendered prompt |
| `orchestrator.json` | the claude session id and the watcher's cursors, so a reopened console does not replay old fleet events |

Status is derived, never stored: a run whose monitor is gone reads as `dead`, and a running worker waiting on `fleet_ask` reads as `blocked`.

One thing to know: `diff` and `merge` only see committed work. If a worker forgets to commit, `diff` warns on stderr and a non-forced `cleanup` refuses to delete the dirty worktree. Brief your workers to commit.

## How it fits together

```text
pi-fleet (ink TUI)                    ← comes and goes; owns no agent
 ├── attaches to .pi-fleet/orchestrator/{state,events,control}
 └── watcher  (tails every run's state and events → the rail, and → <fleet-event>)

orchestrator monitor (detached)       ← survives the console
 └── claude -p  (stream-json over stdio)
      └── pi-fleet mcp  (stdio MCP: the fleet_* tools, over .pi-fleet/)

worker monitors (detached, one each)  ← survive the console
 └── pi --mode rpc  in its own git worktree
```

Every agent is owned by a detached monitor that writes what happens to files, and the console is only a reader and a writer of those files. That is what lets you close it mid-run, come back, and find the session where you left it.

## Development

```bash
pnpm typecheck && pnpm test    # hermetic: fake pi and fake claude, no tokens spent
pnpm test:e2e                  # real pi and real claude, so it costs money
```

`pnpm test:e2e` runs three scenarios: a pi worker end to end, console steering mid-run, and the real orchestrator driving a worker through the MCP tools. Narrow it with `PI_FLEET_E2E_ONLY=pi|claude`, choose models with `PI_FLEET_E2E_MODEL` and `PI_FLEET_E2E_CLAUDE_MODEL` (default `haiku`), or skip the claude scenario with `PI_FLEET_E2E_NO_CLAUDE=1`.

`scripts/spike-claude-protocol.ts` probes the real `claude` binary for the protocol facts this app depends on (whether permission prompts need a handshake, whether `mcp__fleet__*` suppresses them, how a mid-turn message is delivered). Its findings are recorded at the top of the file; re-run it after a Claude Code upgrade.

Test knobs: `PI_FLEET_PI_BIN` and `PI_FLEET_CLAUDE_BIN` replace the two binaries, `PI_FLEET_DEV=1` makes the CLI re-invoke itself through tsx instead of `dist/`, and `PI_FLEET_ASK_TIMEOUT_MS` shortens a worker's `fleet_ask` wait.

Reading the code: `src/orchestrator/` is the claude side (the detached monitor, the console's client, and the stream-json protocol), `src/mcp/` the tools it drives the fleet with, `src/monitor.ts` and `src/commands.ts` the worker side, and `src/tui/` the console. `prompts/orchestrator.md` is the orchestrator's brief.
