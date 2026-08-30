# Notes for agents

Working notes for whoever builds on this repository, human or agent. Keep it factual and short, and update it when you own a step.

## What this is

`parl` is a terminal app that runs a fleet of headless [pi](https://github.com/earendil-works/pi-mono) coding agents with Claude Code as the orchestrator. You talk to the orchestrator, it spawns pi workers into their own git worktrees, and they report back through files under the state directory. You watch, steer, and answer questions from the console.

The `feature/rust` branch is a full rewrite of the original TypeScript implementation in Rust with `ratatui`. The TypeScript tree was deleted at cutover on 2026-08-30 and the Rust build is the only implementation. Repository, crate, binary and state directory all share the name, which was pi-claude-fleet until 2026-08-30 and `pi-fleet` before that. The MCP server name stays `fleet`, so its tools stay `mcp__fleet__*`.

The user-facing docs are [README.md](README.md) and [docs/](docs/) (getting started, the console, the CLI). Keep product behaviour documented there and the contracts here. Neither should repeat the other.

Every agent is owned by a detached monitor that writes what happens to files. The console only reads and writes those files.

## Architecture

Single crate `parl`, lib + bin. The library is the contract, and the binary only parses and dispatches.

| Module | Owns |
| --- | --- |
| `src/main.rs` | clap parsing and dispatch to every subcommand. The only file that touches every module. |
| `src/cli.rs` | the clap `Parser`/`Subcommand` definitions and the `ExitCode` enum (0 ok, 1 refusal/error, 2 no report, 3 wait timeout, 4 run ended stopped/error/dead, 5 merge conflict). The ops signatures `main.rs` calls are the contract between the CLI surface and the operation layer. |
| `src/util.rs` | ids (`m_`, `ev_` prefixes), RFC3339 timestamps with milliseconds, atomic JSON writes (tmp file + fsync + rename), JSONL framing (`split_json_lines`), `read_new_lines` offsets, `sanitize_name`, branch/run-id formats (`parl/<name>-<7>`). |
| `src/paths.rs` | the `.parl` layout as `FleetPaths`, the `STATE_DIR_NAME` and `ENV_PREFIX` constants (every env var name derives from `ENV_PREFIX`), and `ensure()`, which creates the layout and gitignores it. |
| `src/git.rs` | thin wrapper over the git CLI: `git_raw` real-exit-code execution, repo root discovery, worktree add/remove, branch delete, diff against a base commit, merge with conflict detection and `--abort`, dirty/merged checks. |
| `src/fleet/run.rs` | `RunState` (stored as `runs/<id>/run.json`, serde tolerant of unknown/missing fields, camelCase on disk), `RunStatus`, derived status/view (30 s starting grace, `kill(pid,0)` liveness with EPERM-alive), `find_run`/`list_runs`, steering log (capped at 20), `THINKING_LEVELS`. |
| `src/fleet/envelope.rs` | the mailbox envelope (`{"id","ts","from","to","type","payload"}`) shared by every `inbox.jsonl` and `outbox.jsonl` line, plus party parsing and typed builders/decoders for the six inbox types and three outbox types. The contract is pinned byte-for-byte, see the module doc. |
| `src/fleet/event.rs` | `FleetEvent` and `<fleet-event>` rendering. `sanitize_field`/`attr` are the security boundary that stops worker text forging or closing a block. |
| `src/fleet/report.rs` | reading `runs/<id>/report.md` with the steering appendix, falling back to last assistant text. |
| `src/worker/` | the detached worker monitor (`monitor.rs`), pi RPC message types (`rpc.rs`), `pi --list-models` and model checking (`models.rs`). The monitor also materialises the embedded pi extension and skill into `.parl/pi/` at boot. |
| `src/orch/` | the claude side: stream-json wire types (`protocol.rs`), argv builder (`args.rs`), child process (`process.rs`), detached monitor (`monitor.rs`), transcript records (`records.rs`), console-side client (`client.rs`), embedded prompt (`prompt.rs`), the `.mcp.json` (`mcp_config.rs`), health (`health.rs`), the run-state watcher that turns state into fleet events (`watcher.rs`), and the session store for `fleet.json` (`session.rs`). |
| `src/ops/` | the shared operation layer both the CLI and the MCP tools call: `spawn.rs`, `query.rs` (status/output/logs/report/wait/attach), `steer.rs` (send/followup/answer/stop), `integrate.rs` (diff/merge/cleanup). The CLI-shaped signatures live beside `_core` variants that take a `Party` source, so the console and MCP can attribute actions honestly. |
| `src/mcp/` | the stdio MCP server (`server.rs`), one tool per op, built on `rmcp`. Server name stays `fleet` so tools stay `mcp__fleet__*`. |
| `src/tui/` | the console: app state and update loop (`app.rs`), view model (`model.rs`), modal keys (`keys.rs`), palette (`palette.rs`), completions (`completions.rs`), transcript (`transcript.rs`), markdown rendering (`markdown.rs`), theme (`theme.rs`), crossterm runtime (`runtime.rs`), and `view/` draw functions (dashboard, session, composer, overlay, statusline). |
| `pi/`, `prompts/` | TypeScript on purpose: `pi/extensions/fleet-worker.ts` and `pi/skills/fleet-worker-report/SKILL.md` are embedded into the binary with `include_str!` and materialised into `.parl/pi/` at worker boot. `prompts/orchestrator.md` is the embedded orchestrator prompt. |

## The orchestrator contract

The orchestrator is a `claude -p` child of its monitor, given the fleet tools over stdio MCP (`parl mcp`, server name `fleet`, so the tools are `mcp__fleet__*`) and nothing else that writes: `Edit`, `Write` and `NotebookEdit` are disabled for it, reads and read-only git are allowlisted, everything else raises a permission prompt the human answers in the console.

Tools, all thin wrappers over the same `ops` functions the CLI subcommands call: `fleet_spawn`, `fleet_status`, `fleet_wait`, `fleet_output`, `fleet_logs`, `fleet_send`, `fleet_followup`, `fleet_answer`, `fleet_stop`, `fleet_report`, `fleet_diff`, `fleet_merge`, `fleet_cleanup`. Every result ends with an `exit: N` line carrying the CLI exit code, so the agent branches on the same numbers a script would. `fleet_merge` aborts on conflict (exit 5) and names the base commit: conflicts go back to the worker as a rebase brief, because the orchestrator cannot edit files. `fleet_wait` defaults to 120 s with `timeoutSec` validated 1..=600, where the CLI's default is 600 s.

Its brief lives in `prompts/orchestrator.md`, embedded with `include_str!` and rendered with the fleet's placeholders into `.parl/orchestrator/prompt.md`. The override order is `$PARL_PROMPT` (set-but-missing is an error), `<repo>/.parl/orchestrator.md`, `~/.config/parl/orchestrator.md`, then the embedded copy. Nothing is ever copied into a project. Change the prompt and the tool semantics together: the prompt is where the tool contract is actually stated to the agent.

## The worker contract

A worker never sees the human's conversation. It gets a brief, and it answers through files under `.parl/`:

- Its report (`runs/<runId>/report.md`) with fixed sections: Status, Summary, What I did, Files changed, Verification, Decisions & assumptions, Steering received, Open questions, Suggested next step. The shape is enforced by the embedded skill `pi/skills/fleet-worker-report/SKILL.md`.
- `fleet_ask`, a tool from the embedded extension (`pi/extensions/fleet-worker.ts`) that posts a question and blocks until someone answers. After ten minutes (`PARL_ASK_TIMEOUT_MS`) the worker proceeds on its own judgment and records that under Decisions.
- `fleet_progress`, one-line milestones. Forwarded to the orchestrator only under `--progress-events`.

The watcher turns run state and events into `<fleet-event>` blocks injected into the orchestrator's conversation:

```text
<fleet-event kind="settled" run="add-auth-20260829120000" name="add-auth" id="ev_..." ts="...">
status: settled
report: /repo/.parl/runs/add-auth-20260829120000/report.md (present)
branch: parl/add-auth-9120000
next: fleet_report name="add-auth"; then fleet_diff and fleet_merge, then the integration checks
</fleet-event>
```

Kinds: `settled`, `stopped`, `error`, `dead`, `question`, `question_resolved`, `answered_by_console`, `console_steer`, `progress`, `snapshot`. Events caused by the human are labelled as such so the orchestrator reconciles with the intervention instead of undoing it. `sanitize_field`/`attr` in `src/fleet/event.rs` are the security boundary: worker text can never forge or close one of these blocks.

## Stack

Single crate `parl`, lib + bin, edition 2024, version 0.2.0. `Cargo.lock` is committed, since this is a binary. Everything async is tokio (process, fs, io, sync, time, signal).

| Area | Crates | Worth knowing |
| --- | --- | --- |
| CLI | `clap` (derive, env) | `cli.rs` parses, `main.rs` dispatches, `ops` does the work |
| TUI | `ratatui` 0.29.0, `crossterm` 0.28.1, `tui-textarea` 0.7, `unicode-width` 0.2 | pinned exactly: `tui-textarea 0.7` requires `ratatui ^0.29`, so the three move together or not at all |
| MCP | `rmcp` 3.1.4 (`server`, `transport-io`) | its model types are `#[non_exhaustive]`, so build them with `Default` + field assignment. Tool schemas are hand-built JSON in `src/mcp/server.rs` |
| Data | `serde`, `serde_json`, `time` (RFC3339 with milliseconds) | on-disk JSON is camelCase and tolerant of unknown/missing fields |
| Errors | `thiserror` in the library, `anyhow` at the binary edges | |
| Console | `nucleo-matcher` (palette ranking), `pulldown-cmark` (transcript markdown) | wrapping is hand-rolled in `markdown.rs` and `view/overlay.rs` |
| Process | `nix` (`signal`, `process`) | `unsafe_code = "forbid"` rules out `libc::kill`, so pid liveness is `nix::sys::signal::kill`, where EPERM counts as alive |
| Misc | `regex`, `dirs` (`~/.config` lookup), `rand` (the random segment of ids), `futures` (`StreamExt` over the crossterm event stream) | |
| Tests | `assert_cmd`, `predicates`, `tempfile` | |

git is the git CLI, not `git2`: everything goes through `git_raw`, which trusts the real exit code, because merge conflicts print to stdout and sniffing stderr gets it wrong.

The two agents are subprocesses, not libraries: `claude -p` over stream-json, `pi --mode rpc` over its own RPC. Neither SDK is linked in.

## Verified protocol facts

**1. Changing a model mid-session works on both sides (verified 2026-08-30 against the real binaries).**

- Orchestrator (claude): the control request `{"type":"control_request","request_id":"r","request":{"subtype":"set_model","model":"fable"}}` returns `{"subtype":"success"}` and switches the running session with no child restart and no conversation turn. It validates: an unknown id returns `{"subtype":"error","error":"Model \"…\" is not a recognized model id. Run /model to see available models."}`, and that text is shown to the user verbatim rather than keeping our own model list. Accepted: the aliases `opus`, `sonnet`, `haiku`, `fable`, `opusplan` and full ids such as `claude-opus-5`, `claude-fable-5`. `apply_flag_settings {settings:{model}}` also succeeds but does not validate, so prefer `set_model`. There is no control request that lists models.
- Worker (pi): `{"type":"set_model","provider":"anthropic","modelId":"…"}`, and `{"type":"get_available_models"}` returns the full list, so worker model completions are real. See `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` under "Model".
- Consequence: `/model` is a console command that works for the selected session either way, mirroring `/thinking`.

**2. pi extensions can open blocking dialogs.**

pi emits `{"type":"extension_ui_request","id":"…","method":"…",…}` on stdout. Dialog methods `select` (`title`, `options`, `timeout`), `confirm` (`title`, `message`, `timeout`), `input`, `editor` block the agent until the client replies on stdin with `{"type":"extension_ui_response","id":"…","value":"…"}`, or `{"…","confirmed":true}`, or `{"…","cancelled":true}`. The `timeout` is in milliseconds and pi auto-resolves with `undefined` when it lapses. Fire-and-forget methods needing no reply: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.

The worker monitor treats a dialog request like a `fleet_ask` pending question. It is recorded on the run (`pendingDialog`) so the console shows the session as blocked and can answer it, and if nobody answers, the monitor sends `cancelled: true` shortly before pi's own timeout so the worker never hangs. Reference: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`.

**3. The claude stream-json / control protocol, spiked against the real binary (claude 2.1.251, 2026-08-29).** The spike script that produced these (`scripts/spike-claude-protocol.ts`) was deleted at cutover, so its findings are recorded here. They were not written down anywhere else.

- `can_use_tool` arrives without any `initialize` handshake (`echo` never prompts, being in the built-in read-only set, so probe with a writing command). The handshake is sent at startup anyway: its response carries the command/skill list. A bare `{subtype:"initialize"}` is acknowledged with success but is not needed.
- `--allowedTools "mcp__fleet__*"` suppresses permission prompts for the fleet tools.
- `updatedPermissions` built from the request's `permission_suggestions` is honored: after an allow-always, the same command does not prompt again.
- `--append-system-prompt-file` is a hidden flag and works. `system/init` arrives only after the FIRST user message and is re-emitted after every user message. Nothing at all is written before the first message. Extra stream messages observed: `system/status {status:"requesting"}`, thinking deltas, `system/task_started|task_notification|background_tasks_changed`.
- A user message injected mid-turn is delivered inside the running turn as a system-reminder right after the next tool result. Whether the model acts on it is up to the model (haiku once folded it in, once ignored it as a possible prompt injection). This is why the orchestrator prompt states that `<fleet-event>` messages arriving mid-turn are legitimate and must be acted on.
- Permission modes: `--help` advertises acceptEdits, auto, bypassPermissions, manual, dontAsk and plan. `default` is not in that list but the flag accepts it, as a hidden alias for `manual`. (`bogus` is rejected, so the choice is validated.) Over the control protocol, `set_permission_mode` succeeds for every one of default/auto/acceptEdits/dontAsk/plan/manual, so the modes the console offers work both at launch and mid-session. The claude Agent SDK type definitions still exist, at `~/Library/Application Support/Code/agent-host/sdk-cache/claude/0.3.220/darwin-arm64/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (only the old path went away). Its `PermissionMode` type lags the flag reality.

## The `.parl` layout

```text
.parl/
  fleet.json            console + watcher cursors, the claude session id, remembered prefs
  console.lock          single-instance lock for the TUI
  orchestrator/
    state.json          monitor pid, session id, model, commands, cost, turns, activity, pending permission
    events.jsonl        the orchestrator transcript
    inbox.jsonl         console -> monitor
    claude.log          raw protocol both directions, plus the monitor's own diagnostics
    prompt.md           the rendered prompt the orchestrator was started with
  runs/<runId>/
    run.json            the run's durable facts
    events.jsonl        the run transcript
    inbox.jsonl         orchestrator/console -> monitor   (created lazily, on first steer)
    outbox.jsonl        worker -> monitor                (created lazily, on first worker outbox line)
    report.md           the worker's final report
    pi.log              raw pi RPC stream, plus the monitor's own diagnostics
    session/            pi session files                 (created lazily, by pi's first session write)
  pi/
    extensions/fleet-worker.ts        materialised from the binary at worker boot
    skills/fleet-worker-report/SKILL.md
```

What each file actually holds:

| Path | Contents |
| --- | --- |
| `fleet.json` | the claude session id, the console's and watcher's cursors, remembered prefs (the `launch` record and the console's `/rail` width, under a `"console"` key) |
| `console.lock` | single-instance lock for the TUI |
| `orchestrator/state.json` | monitor pid, claude session id, model, commands, cost, turns, current activity, and any permission prompt waiting for the human |
| `orchestrator/events.jsonl` | the transcript: claude's messages, coalesced token deltas, activity and permission records |
| `orchestrator/inbox.jsonl` | console -> monitor: messages, permission answers, interrupts, thinking and model changes, stop |
| `orchestrator/claude.log` | the raw protocol both directions, plus the monitor's own diagnostics |
| `orchestrator/prompt.md` | the rendered prompt the orchestrator was started with |
| `runs/<id>/run.json` | the run's durable facts: status, worktree, branch, base commit, last tool and activity, steering log, pending question or dialog |
| `runs/<id>/events.jsonl` | selected pi RPC events plus fleet events (`steering_delivered`, `worker_question`, `worker_progress`, `answer_delivered`, ...) |
| `runs/<id>/inbox.jsonl` | orchestrator/console -> monitor: `steer`, `follow_up`, `abort`, `answer`, `command` envelopes |
| `runs/<id>/outbox.jsonl` | worker -> monitor: `question`, `progress`, `question_resolved` envelopes |
| `runs/<id>/report.md` | the worker's final report |
| `runs/<id>/pi.log` | the raw pi RPC stream, plus the monitor's own diagnostics |
| `runs/<id>/session/` | pi's own session files |

`inbox.jsonl`, `outbox.jsonl` and `session/` are created lazily, on first use, so a run that is never steered has no `inbox.jsonl` on disk even though the tree lists it. Status is derived, never stored: a run whose monitor is gone reads as `dead`, and a running worker waiting on `fleet_ask` or a pi dialog reads as `blocked`.

Gone for good: the top-level `reports/` directory, `orchestrator.json`, the per-run `monitor.log`, `tui.lock`. There is no migration path and none is wanted. An old `.pi-fleet` is simply ignored.

## Known issues

- **The orchestrator monitor does not exit when its fleet directory disappears.** During the rewrite, 16 orphaned `parl orchestrator-monitor` processes accumulated from a deleted worktree, polling on timers for an hour against temp dirs that no longer existed. In real use, deleting `.parl` leaves a monitor running forever. The fix is a liveness check on the fleet dir in the monitor's poll loop.
- **`fleet_spawn`'s structured output field is `fleetDir`**, where the TypeScript emitted `piFleetDir`. Intentional, since it follows `SpawnData`'s serialisation, but noted in case anything reads it.
- **Test flakes: one repair round merged, two sites still open.** The merged round (`cf08a69`) fixed the zombie reap in `launch_monitor`, the transient git-subprocess family (now one shared bounded-retry `git::test_support::git_sync` helper) and the `run.json` flush races in `tests/worker_monitor.rs`, then held for 11 consecutive clean full-suite runs. Two sites still fail under heavy parallel load, both the same environmental family of fresh paths and transient subprocess results: `src/ops/mod.rs:157`, where `canonicalize()` of the git-reported root returns NotFound about 3% of runs, and `src/worker/models.rs:155/:176`, where the model listing transiently returns nothing and `list_models` caches the empty result.

## Traps

Each of these cost a debugging session once already.

- Rust does not reap detached children on drop the way Node's `unref()` did, so a spawned monitor lingers as a zombie whose pid still looks alive. Spawn through `tokio::process::Command` (it has the safe `process_group(0)`, while `pre_exec` is `unsafe` and forbidden) and reap in a background task, as `spawn_monitor` and `launch_monitor` do.
- `ok()` in `ops` zeroes `err`, so anything that carries stderr text alongside a successful exit (diff/merge dirty warnings, attach's static-tail note, cleanup's kept-branch warning) has to build its `CommandResult` by hand. Two warnings were silently dropped before a test caught it.
- The orchestrator's pending-permission map is the source of truth, and the list in `state.json` is derived from it. Remove a request from the list and the next flush resurrects it.
- `ProcEvent::Error` has to end the orchestrator monitor: a bad binary produces an error and no close, and the old TypeScript monitor hung forever on it.
- The non-interactive refusal tests stdin/stdout with `crossterm::tty::IsTty`, not `terminal::size()`, whose `tput` fallback answers even with no controlling terminal. The old check sailed past the friendly refusal and died in raw mode.
- Envelope readers stay tolerant on purpose: an unknown `type` or an unknown payload field parses, decodes to `None`, and the line is skipped, so a newer writer can never crash an older reader. Keep it that way.

## Conventions

- Borrow rather than clone, and return `Result` rather than panic. `thiserror` for typed library errors, `anyhow` at the binary edges, `?` over match chains. Doc comments on public items explain *what*, `//` comments only explain *why*, and both stay sparse.
- Lints are the contract: `unsafe_code` is forbidden, and clippy `all`, `perf`, `unwrap_used`, `todo` and `dbg_macro` are denied. Unit tests may unwrap through the crate-level `cfg_attr(test, allow(clippy::unwrap_used))`. Integration tests under `tests/` need `#![allow(clippy::unwrap_used)]` at the top of each file.
- The CLI surface is the contract: `main.rs` dispatches, `cli.rs` parses, and the ops signatures they call are the seam. Change all three together or none.
- Verification before you finish (all four must pass):

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo build --release
```

## Tests

The suite is hermetic: the pi and claude sides are driven by Node fakes in `tests/fixtures/` (`fake-pi-parl.mjs`, `fake-claude.mjs` and friends), so a full run spends no tokens and touches no network. It does need `node` on PATH. Integration tests drive the built `parl` binary through `assert_cmd`, including `parl monitor` as a real child process, so pid liveness, monitor exit and signals are exercised the way production runs.

Knobs, all derived from `ENV_PREFIX`:

| Variable | Effect |
| --- | --- |
| `PARL_PI_BIN` | replaces the pi binary, as an executable spec split on spaces, e.g. `node /path/fake-pi-parl.mjs` |
| `PARL_CLAUDE_BIN` | replaces the claude binary |
| `PARL_DIR` | points the fleet at a directory other than `<cwd>/.parl` |
| `PARL_PROMPT` | the orchestrator prompt override (set-but-missing is an error) |
| `PARL_ASK_TIMEOUT_MS`, `PARL_ASK_POLL_MS` | shorten a worker's `fleet_ask` wait and its poll interval |
| `PARL_RUN` | the run a worker's extension reports into |
