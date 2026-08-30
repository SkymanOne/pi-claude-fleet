# pi-claude-fleet

A terminal app that runs a fleet of [pi](https://github.com/earendil-works/pi-mono) coding agents with Claude Code as the orchestrator.

You run `parl` in a repository. It starts Claude Code as a child process, gives it a set of fleet tools, and shows you both sides: your conversation with the orchestrator in a drill-down transcript, every worker on a dashboard beside it. The orchestrator plans the work and spawns pi workers, each in its own git worktree. Workers report back through files. You can watch any worker, steer it, or answer its questions yourself, and the orchestrator finds out what you did.

Nothing runs inside a Claude Code session, and there is no skill to install. The orchestrator is an ordinary `claude -p` process that this app owns.

Requirements: a Rust toolchain (the crate is edition 2024, so a current stable), `pi` on your PATH, and `claude` (Claude Code 2.1.x) on your PATH and logged in.

## Install

```bash
cargo install --path .       # or: cargo build --release  →  target/release/parl
parl --help                  # verify
```

There is nothing to install on the pi side. The worker extension and the report skill are TypeScript files embedded in the binary and materialised into `<repo>/.parl/pi/` when a worker starts, so every worker gets the current version whether or not the checkout you installed from still exists.

## Using it

```bash
cd your-repo
parl
```

Then talk to the orchestrator: *"Add token refresh to the auth module and update the tests."* It writes briefs, spawns workers, and reports back as they finish.

## The console

The console is a dashboard with drill-down, and it has two key modes.

The **dashboard** is the home view: the whole fleet at a glance, the orchestrator first, one two-line row per session. The primary line carries the state glyph, the name, and — for workers — the branch and diff stat, with the age on the right; the dimmed second line is what the session is doing right now. Nothing is clipped to a narrow column, so a dozen workers stay readable.

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ parl · orchestrator + 2 workers · ● running 1 · ? needs an answer 1      │
│                                                                          │
│ ▸ ○ orchestrator                                                   3m    │
│     ✻ thinking… 12s                                                      │
│   ● add-auth      parl/add-auth-9123456  +12 −3                    2m    │
│     ⚙ bash                                                               │
│ ? add-tests       parl/add-tests-9123457                           1m    │
│     needs an answer                                                      │
│                                                                          │
│ j/k move · enter open · a answer · s stop · i compose · : palette · …    │
├ add-tests · needs an answer · sonnet-4.5 · high · parl/add-tests-9123457 ┤
└──────────────────────────────────────────────────────────────────────────┘
```

The glyph carries the state: `○` idle, `…` starting, `●` running, `?` blocked or waiting on you, `✓` done, `■` stopped, `!` failed, `·` archived. The detail line says what the session is in — `✻ thinking… 12s`, `✎ replying…`, `⚙ bash` for a tool call, `needs an answer`, the first line of its error, or `monitor gone` when a worker's monitor is no longer alive. The bottom row describes whatever is selected: for a worker its state, model, reasoning level and branch (what pi resolved, not just the pattern you asked for); for the orchestrator its model, session, spend and turns; plus the mode indicator on the right.

**Enter** opens the selected session's drill-down: a slim session list on the left, the selected session's transcript filling the rest, the composer below it. **Esc** is back to the dashboard.

The two key modes exist so a message that starts with "q" does not quit the app:

- **Normal mode** — the composer does not have focus, so single-letter keys are free: `j`/`k` move, `a` answers, `s` stops, `:` opens the palette. Any printable key that binds to nothing starts a message and enters insert mode keeping the key, so starting to type is never punished. `i` enters insert mode without typing anything.
- **Insert mode** — the composer has focus and types freely; only the composer's own keys are bound. `Esc` is back to normal mode.

Keys in normal mode:

| Keys | What they do |
| --- | --- |
| `j` `k` / arrows | move the selection |
| `g` / `G` | first / last row, or top / bottom of the transcript |
| `enter` | open the selected session |
| `esc` | back to the dashboard |
| `tab` / `shift-tab` | next / previous session |
| `1`–`9` | jump to the nth session |
| `/` | search this session (`n`/`N` next / previous match) |
| `:` or `ctrl-k` | the command palette |
| `?` | help — generated from the same tables as this list, so they cannot drift |
| `a` | answer the pending question or dialog |
| `s` | stop the selected worker |
| `x` | remove the selected worker (asks first) |
| `t` | cycle the thinking level |
| `m` | switch the model (palette, over models) |
| `p` | permission mode (orchestrator only) |
| `ctrl-d` / `ctrl-u` | scroll half a page down / up |
| `ctrl-f` / `ctrl-b` | scroll a page down / up |
| `q` | close the console; workers keep running |
| `Q` | stop the orchestrator and every worker, then exit (asks first) |

Keys in insert mode:

| Keys | What they do |
| --- | --- |
| type + `enter` | message the orchestrator, or steer the selected worker |
| `alt-enter` (or `ctrl-j`) | a newline, not a send |
| `/` | commands and skills |
| `@` | workers and repository files |
| `tab` | accept the highlighted suggestion |
| `up` / `down` | move through suggestions, or recall what you sent that session before |
| `ctrl-k` | the command palette |
| `esc` | back to normal mode |

## The command palette

`:` or `ctrl-k` opens a fuzzy palette over everything the selected session can do, ranked as you type. It carries, grouped in this order:

- **console** — the commands below, the ones the console runs itself.
- **agent** — whatever the agent on the other end offers, passed through verbatim, never filtered. For the orchestrator that is Claude Code's slash commands and skills (`/model`, `/usage`, any skill you have installed), learned from its handshake. For a worker it is pi's commands, skills, prompt templates and extension commands, reported when it starts and labelled by source (`skill`, `prompt`, `extension`); the console delivers them as a pi `prompt`, the one form that runs extension commands as well as expanding skills. An entry that takes an argument prefills the composer so you can type it.
- **mcp** — the orchestrator's MCP servers and their `mcp__server__tool` tools with each server's connection status, shown for reference.
- **models** — for a worker, its real list from pi (`get_available_models`) with the provider named; for the orchestrator, the model aliases claude accepts. Selecting one switches the selected session's model, live.
- **sessions** — jump to another dashboard row.

`m` opens the palette directly over models.

### `/model`

`/model <model>` (or the palette's models group) changes the model of the running session without restarting it and without spending a turn — either side. For the orchestrator the request goes to claude itself, which validates the name: an unknown model shows claude's own error text verbatim (`Model "…" is not a recognized model id. Run /model to see available models.`) rather than a list of our own. For a worker the console resolves the id against the model list pi reported; an unknown or ambiguous id sends nothing and tells you so, while an explicit `provider:model` passes through and pi can refuse it.

## Answering for your agents

With the orchestrator selected the composer is a normal message. With a worker selected:

| You type | Short | What happens |
| --- | --- | --- |
| any text | | steers that worker (delivered after its current tool call) |
| `/answer <text>` | `/a` | answers the question or dialog it is blocked on |
| `/followup <text>` | `/f` | queues a message for after it finishes its current work |
| `/stop` | `/s` | aborts it |
| `/remove` | `/rm` | removes it: worktree, branch and dashboard row (asks first if that would destroy work) |
| `/thinking <level>` | `/t` | sets the reasoning level — pi's `off…max` for a worker, claude's `low…max` for the orchestrator; each session keeps its own, and the change is a passing note rather than a turn |
| `/model <model>` | | switches its model, live (above) |
| `/permissions <mode>` | `/perm` | how the orchestrator's tool use is approved; with no argument it says what is in force |
| `/rail <mode>` | `/rw` | width of the drill-down's session list: `compact`, `auto`, `wide`, or `full` (`full` is all transcript) |
| `/help` | `/h` | keys and commands |
| `/quit` | `/q` | leave the console; workers keep running |
| `/shutdown` | `/sd` | stop the orchestrator and every worker, then exit (asks first; worktrees and branches are kept) |

When the orchestrator wants to run something outside its allowlist, or asks you a question, an overlay appears: `y` allows once, `a` allows it for the session, `n` denies with a reason, and questions get an option picker.

How often that happens is up to you. `auto` hands routine approvals to a classifier and only escalates what it is unsure about; `acceptEdits` lets file edits and common filesystem commands through; `dontAsk` denies anything not already allowed instead of asking; `plan` makes the orchestrator read-only; `default` asks about everything outside the allowlist. Start in a mode with `parl --permission-mode auto`. The mode is shown in the status line whenever it is not the default, it survives a console restart, `p` cycles it mid-session, and `bypassPermissions` is deliberately not offered — it would skip the overlay altogether.

### pi dialogs

A worker can open a pi extension dialog — `select`, `confirm`, `input` or `editor` — which blocks the agent until someone answers it. The console treats that like a `fleet_ask` question: the dashboard shows the worker as `needs an answer`, `a` (or `/answer`) answers it from the console, and if nobody answers, the console cancels the dialog a half-second before pi's own timeout (ten minutes when the dialog carries none) so a worker can never stall on an unanswered prompt. A `confirm` maps a yes-ish answer to confirmation, and an empty answer dismisses the dialog as cancelled.

## The transcript

The transcript separates the parts of a turn: your prompts in cyan, the model's reasoning dimmed and abridged, its answer as rendered markdown (headings, emphasis, inline code, lists, links and tables laid out in columns), tool calls in blue with their results dimmed under them, fleet events in yellow, errors red — each block set off by a blank line. Tool calls are shown as written rather than clipped to fit, so a long command stays readable. Tool output is a preview: the first few lines, then a count of what was left out, since output can run to megabytes. `/` searches it; scrolling follows the tail until you scroll up, and pins there while you read.

Workers disappear from the dashboard when they are done: the orchestrator cleans each one up after it merges and verifies it, and the console removes any settled worker whose branch is already merged. Nothing unmerged, dirty or still running is ever removed for you — that waits for `/remove` or `parl cleanup`, which tell you exactly what would be lost before they do anything.

Quitting closes the console, nothing else. Reopening restores the conversation: if the orchestrator is still running you attach to it live, and if it is not — after a reboot, or a `/shutdown` — a new one resumes the same claude session under the transcript you already had, with a line marking the seam. `--fresh` is the way to start over.

The orchestrator and its workers are detached processes with their state on disk, so `parl` reopens where you left off: the same claude session, still mid-thought if it was working, with its transcript replayed. A permission prompt raised while no console was open is still waiting for you when you return.

Options: `--cwd <dir>`, `--model <model>`, `--permission-mode <mode>`, `--remote-control [name]`, `--fresh`, `--budget <usd>`, `--progress-events` (forward workers' progress notes to the orchestrator, off by default because they are chatty). The launch choices are remembered, so a restarted orchestrator comes back with the same model, permission mode and Remote Control setting.

## What the orchestrator can and cannot do

It coordinates; it does not type code. `Edit`, `Write` and `NotebookEdit` are disabled for it. It can read the repository and run read-only git commands without asking; anything else prompts you. Merge conflicts go back to the worker as a rebase brief rather than being fixed in place — `fleet_merge` aborts on conflict (exit 5) and names the base commit, and the checkout is left clean.

Its tools, all backed by the same code as the CLI subcommands:

`fleet_spawn`, `fleet_status`, `fleet_wait`, `fleet_output`, `fleet_logs`, `fleet_send`, `fleet_followup`, `fleet_answer`, `fleet_stop`, `fleet_report`, `fleet_diff`, `fleet_merge`, `fleet_cleanup`.

They are served by `parl mcp`, a stdio MCP server that Claude Code spawns itself. The orchestrator's role, the tool semantics and the event format live in [prompts/orchestrator.md](prompts/orchestrator.md), which is embedded in the binary — see below.

## How a worker talks back

A worker never sees your conversation. It gets a brief, and it answers through files in `.parl/`:

- Its **report** (`runs/<runId>/report.md`) with fixed sections: Status, Summary, What I did, Files changed, Verification, Decisions & assumptions, Steering received, Open questions, Suggested next step.
- **`fleet_ask`**, a tool that posts a question and blocks until someone answers. The dashboard shows the worker as `?`, the orchestrator gets a `question` event, and either it or you can answer. If nobody answers within ten minutes the worker proceeds on its own judgment and records that under Decisions.
- **`fleet_progress`**, one-line milestones.

Everything a worker does becomes a fleet event, and the app injects those into the orchestrator's conversation as they happen:

```text
<fleet-event kind="settled" run="add-auth-20260829120000" name="add-auth" id="ev_…" ts="…">
status: settled
report: /repo/.parl/runs/add-auth-20260829120000/report.md (present)
branch: parl/add-auth-9120000
next: fleet_report name="add-auth"; then fleet_diff and fleet_merge, then the integration checks
</fleet-event>
```

Kinds: `settled`, `stopped`, `error`, `dead`, `question`, `question_resolved`, `answered_by_console`, `console_steer`, `progress`, `snapshot`. Events that come from you (an answer or a steer you typed) are labelled as such, so the orchestrator reconciles instead of undoing your work. The text inside these blocks is sanitised: worker output can never forge or close one.

## The orchestrator's prompt

The orchestrator's brief ships inside the binary. To run a different one, no file is ever copied into your project — `parl` looks for an override, in order: `$PARL_PROMPT` (a path; setting it to something that does not exist is an error, because it is explicit intent), then `<repo>/.parl/orchestrator.md`, then `~/.config/parl/orchestrator.md`, then the embedded copy. The rendered prompt (with the fleet's placeholders filled in) lands in `.parl/orchestrator/prompt.md`, where you can read what the orchestrator was actually told.

## Headless commands

The TUI is one client; the same fleet is driveable from scripts.

| Command | What it does |
| --- | --- |
| `spawn <name> [opts] -- "<brief>"` | start a worker (`--cwd`, `--model`, `--provider`, `--thinking`, `--no-worktree`, `--base`, `--skill`, `--append-system-prompt`, `--session`, `--tools`, `--exclude-tools`). A `--model` pi does not have is refused before a worktree exists, naming the closest models it does have |
| `status [<name>] [--json] [--all]` | fleet table, or one run's full state |
| `wait <name> [--timeout s]` | block until the run reaches a terminal state |
| `output <name> [--tail n]` | last assistant text, or the last n tool results |
| `logs <name> [--tail n]` | tail of the raw RPC log |
| `send`, `followup`, `answer`, `stop` | steer, queue a follow-up, answer a question, abort |
| `status --json` | includes each run's `activeModel`, `pendingQuestion` and the `commands` it offers |
| `report <name>` | the final report with the steering log appended; exit 2 if there is none |
| `diff <name> [--name-only]` | what the worker changed against its base commit |
| `merge <name> [--no-commit]` | merge the worker's branch; exit 5 on conflicts, with the merge aborted and the checkout clean |
| `cleanup <name\|all> [--force]` | remove the worktree and branch, archive the run |
| `attach <name> [--tail n]` | print a worker's transcript tail |
| `mcp` | serve the fleet tools over stdio (what the orchestrator runs) |

Exit codes: 0 ok, 1 refusal or error, 2 no report, 3 wait timed out, 4 the run ended stopped/error/dead, 5 merge conflict.

## Files under `.parl/`

`spawn` creates `<repo>/.parl/` and adds it to `.gitignore`. It is the audit trail; nothing else needs to read it.

| Path | What it holds |
| --- | --- |
| `fleet.json` | the claude session id, the console's and watcher's cursors, remembered prefs — launch choices and your `/rail` width |
| `console.lock` | single-instance lock for the TUI |
| `orchestrator/state.json` | the orchestrator's durable facts: monitor pid, claude session id, model, commands, cost, turns, what it is doing, and any permission prompt waiting for you |
| `orchestrator/events.jsonl` | its transcript: claude's messages, coalesced token deltas, activity and permission records |
| `orchestrator/inbox.jsonl` | inbox: your messages, permission answers, interrupts, thinking and model changes, stop |
| `orchestrator/claude.log` | the raw protocol, both directions, plus the monitor's own diagnostics |
| `orchestrator/prompt.md` | the rendered prompt the orchestrator was started with |
| `runs/<id>/run.json` | the run's durable facts: status, worktree, branch, base commit, last tool and activity, steering log, pending question or dialog |
| `runs/<id>/events.jsonl` | the transcript: selected pi RPC events plus fleet events (`steering_delivered`, `worker_question`, `worker_progress`, `answer_delivered`, …) |
| `runs/<id>/inbox.jsonl` | orchestrator/console → monitor: `steer`, `follow_up`, `abort`, `answer`, `command` envelopes |
| `runs/<id>/outbox.jsonl` | worker → monitor: its `question`, `progress` and `question_resolved` envelopes |
| `runs/<id>/report.md` | the worker's final report |
| `runs/<id>/pi.log` | the raw pi RPC stream, plus the monitor's own diagnostics |
| `runs/<id>/session/` | pi's own session files |
| `pi/extensions/fleet-worker.ts`, `pi/skills/fleet-worker-report/SKILL.md` | the worker extension and report skill, materialised from the binary at spawn |

One thing to know: `runs/<id>/inbox.jsonl`, `outbox.jsonl` and `session/` are created lazily, on first use — the first steer, the worker's first outbox line, pi's first session write — so a run that was never steered has no `inbox.jsonl` on disk even though the table lists it.

Status is derived, never stored: a run whose monitor is gone reads as `dead`, and a running worker waiting on `fleet_ask` (or a pi dialog) reads as `blocked`.

One more: `diff` and `merge` only see committed work. If a worker forgets to commit, `diff` warns on stderr and a non-forced `cleanup` refuses to delete the dirty worktree. Brief your workers to commit.

## How it fits together

```text
parl (ratatui TUI)                    ← comes and goes; owns no agent
 ├── attaches to .parl/orchestrator/{state,events,inbox}
 └── watcher  (tails every run's state and events → the dashboard, and → <fleet-event>)

orchestrator monitor (detached)       ← survives the console
 └── claude -p  (stream-json over stdio)
      └── parl mcp  (stdio MCP: the fleet_* tools, over .parl/)

worker monitors (detached, one each)  ← survive the console
 └── pi --mode rpc  in its own git worktree
```

Every agent is owned by a detached monitor that writes what happens to files, and the console is only a reader and a writer of those files. That is what lets you close it mid-run, come back, and find the session where you left it.

## Development

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo build --release
```

The suite is hermetic: the pi and claude sides are driven by Node fakes in `tests/fixtures/` (`fake-pi-parl.mjs`, `fake-claude.mjs` and friends), so the full run spends no tokens and talks to no network. It still needs `node` on your PATH, since the fakes are Node scripts.

Test knobs: `PARL_PI_BIN` and `PARL_CLAUDE_BIN` replace the two binaries (`PARL_PI_BIN` is an executable spec split on spaces, e.g. `node /path/fake-pi-parl.mjs`), `PARL_PROMPT` points the orchestrator's prompt override at a file, and `PARL_DIR` points the fleet at a directory other than `<cwd>/.parl`. `PARL_ASK_TIMEOUT_MS` shortens a worker's `fleet_ask` wait.

Reading the code: `src/orch/` is the claude side (the detached monitor, the console's client, the stream-json protocol, the run-state watcher), `src/worker/` the pi side (the worker monitor and RPC types), `src/ops/` the operations both the CLI and the MCP tools call, `src/mcp/` the stdio server, `src/fleet/` the on-disk contract (runs, envelopes, events, reports), and `src/tui/` the console. `prompts/orchestrator.md` is the orchestrator's brief, embedded with `include_str!`.
