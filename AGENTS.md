# AGENTS.md

Working notes for agents building this repository. Keep it factual and short; update it when you own a step.

## What this is

`pi-claude-fleet` is a terminal app that runs a fleet of headless [pi](https://github.com/earendil-works/pi-mono) coding agents with Claude Code as the orchestrator. You talk to the orchestrator; it spawns pi workers, each in its own git worktree; workers report back through files under the state directory; you watch, steer, and answer questions from the console. The `feature/rust` branch is a full rewrite of the TypeScript implementation (kept in `src/*.ts` until cutover) in Rust with `ratatui`. The binary is **`parl`** — the project/repository is still called pi-claude-fleet, only the command is `parl`.

## Architecture

Single crate `parl`, lib + bin. The library is the contract; the binary only parses and dispatches.

| Module | Owns |
| --- | --- |
| `src/main.rs` | clap parsing + dispatch to every subcommand. **Frozen**: later steps never edit it. |
| `src/cli.rs` | the clap `Parser`/`Subcommand` definitions and the `ExitCode` enum (0 ok, 1 refusal/error, 2 no report, 3 wait timeout, 4 run ended stopped/error/dead, 5 merge conflict). **Frozen**. |
| `src/util.rs` | ids (`m_`, `ev_` prefixes), RFC3339 timestamps with milliseconds, atomic JSON writes (tmp file + fsync + rename), JSONL framing (`split_json_lines`), `read_new_lines` offsets, `sanitize_name`, branch/run-id formats (`parl/<name>-<7>`). |
| `src/paths.rs` | the `.parl` layout as `FleetPaths`; `STATE_DIR_NAME` and `ENV_PREFIX` constants (every env var name derives from `ENV_PREFIX`); `ensure()` creates the layout and gitignores it. |
| `src/git.rs` | thin wrapper over the git CLI: `git_raw` real-exit-code execution, repo root discovery, worktree add/remove, branch delete, diff against a base commit, merge with conflict detection and `--abort`, dirty/merged checks. |
| `src/fleet/run.rs` | `RunState` (stored as `runs/<id>/run.json`, serde tolerant of unknown/missing fields, camelCase on disk), `RunStatus`, derived status/view (30 s starting grace, `kill(pid,0)` liveness with EPERM-alive), `find_run`/`list_runs`, steering log (capped at 20), `THINKING_LEVELS`. |
| `src/fleet/envelope.rs` | the mailbox envelope (`{"id","ts","from","to","type","payload"}`) shared by every `inbox.jsonl` and `outbox.jsonl` line; party parsing; typed builders/decoders for the six inbox types and three outbox types. Contract pinned byte-for-byte — see the module doc. |
| `src/fleet/event.rs` | `FleetEvent` and `<fleet-event>` rendering; `sanitize_field`/`attr` are the security boundary that stops worker text forging or closing a block. |
| `src/fleet/report.rs` | reading `runs/<id>/report.md` with the steering appendix, falling back to last assistant text. |
| `src/worker/` | the detached worker monitor (`monitor.rs`), pi RPC message types (`rpc.rs`), `pi --list-models` and model checking (`models.rs`). Implemented in the worker step. |
| `src/orch/` | the claude side: stream-json wire types (`protocol.rs`), argv builder (`args.rs`), child process (`process.rs`), detached monitor (`monitor.rs`), transcript records (`records.rs`), console-side client (`client.rs`), embedded prompt (`prompt.rs`), the `.mcp.json` (`mcp_config.rs`), health (`health.rs`), and the run-state watcher that turns state into fleet events (`watcher.rs`). Most files landed in the orch step; `client.rs`, `health.rs`, `monitor.rs` and `watcher.rs` are still stubs. |
| `src/ops/` | the shared operation layer both the CLI and the MCP tools call: `spawn.rs`, `query.rs` (status/output/logs/report/wait/attach), `steer.rs` (send/followup/answer/stop), `integrate.rs` (diff/merge/cleanup). Signatures taking CLI-parsed values are frozen with `main.rs`; the `_core` variants take a `Party` source so the console and MCP can attribute actions honestly. Implemented in the ops step. |
| `src/mcp/` | *(stub — mcp step)* the stdio MCP server (`server.rs`), one tool per op, built on `rmcp`. Server name stays `fleet` so tools stay `mcp__fleet__*`. |
| `src/tui/` | *(stub — tui-model and tui-render steps)* app state and update loop (`app.rs`), view model (`model.rs`), modal keys (`keys.rs`), palette (`palette.rs`), completions (`completions.rs`), transcript (`transcript.rs`), markdown rendering (`markdown.rs`), theme (`theme.rs`), crossterm runtime (`runtime.rs`), and `view/` draw functions (dashboard, session, composer, overlay, statusline). |

## Key decisions

Dated; newest last. Record anything that did not work out here too.

- 2026-08-30 — Single crate `parl`, lib + bin; edition 2024; version 0.2.0. The binary is `parl` (renamed from `pi-fleet` mid-scaffold): greenfield rewrite, no migration path, so the command and its state directory share a name. The MCP server name stays `fleet` (`mcp__fleet__*`).
- 2026-08-30 — State directory is `.parl/` and env prefix is `PARL` (`PARL_DIR`, `PARL_RUN`, `PARL_PI_BIN`, `PARL_CLAUDE_BIN`, `PARL_PROMPT`, `PARL_ASK_TIMEOUT_MS`, `PARL_ASK_POLL_MS`), each name derived from `ENV_PREFIX` in `src/paths.rs`. The old `.pi-fleet/` is simply ignored by `parl` — no migration, no back-compat reader — and the TypeScript build keeps using it until cutover; neither side may read the other's directory.
- 2026-08-30 — tokio for all async plumbing (process, fs, io, signal); `ratatui` with a dashboard + drill-down UI and modal (normal/insert) keys.
- 2026-08-30 — The git CLI rather than `git2`; every git interaction goes through `git_raw`, which trusts the real exit code (merge conflicts print to stdout, so stderr sniffing is wrong).
- 2026-08-30 — The orchestrator prompt override order (for `src/orch/prompt.rs`): `$PARL_PROMPT` (a path), then `<repo>/.parl/orchestrator.md`, then `~/.config/parl/orchestrator.md`, then the copy embedded in the binary with `include_str!`. Nothing is ever copied into a project.
- 2026-08-30 — `Cargo.lock` is committed (this is a binary).
- 2026-08-30 — `unsafe_code = "forbid"` makes `libc::kill` unusable for the liveness check, so pid liveness goes through `nix::sys::signal::kill` (EPERM counts as alive). `libc` stays in the tree for later FFI needs. `nix` was added beyond the original dependency list for this reason.
- 2026-08-30 — `tui-textarea 0.7.0` pins `ratatui ^0.29` (no release supports 0.30 yet), so `ratatui` is pinned to `0.29.0` with `crossterm 0.28.1` and `unicode-width 0.2.0` exactly. Verified with a throwaway example (render into `TestBackend`), then deleted.
- 2026-08-30 — `rmcp 3.1.4` verified to build and to serve a `ServerHandler` with `list_tools`/`call_tool` over `transport::stdio()` (throwaway example compiled and run, then deleted). Its `#[non_exhaustive]` model types are constructed via `Default` + field assignment.
- 2026-08-30 — Mailboxes carry the envelope shape directly (`inbox.jsonl` lines are envelopes addressed `to: worker:<runId>`); the old flat `control.jsonl` shape is gone. Unknown `type` values and unknown payload fields parse but decode to `None` and readers skip the line, so a newer writer cannot crash an older reader.
- 2026-08-30 — Steering provenance is the envelope's `from` party. The CLI wrappers attribute to `orchestrator` (the agent drives these tools); the console and future MCP callers thread `Party::Console` through the `_core` variants, which the watcher reads to surface human interventions as events the orchestrator reconciles with instead of undoing.
- 2026-08-30 — `answer` targets the explicit `--question` id when given (the monitor routes by id, even when it is not the pending one), else the run's pending `fleet_ask` question, else a pending extension dialog (`pendingDialog`) — either kind of block is answerable.
- 2026-08-30 — `merge` always aborts on conflict (exit 5) and names the base commit in the error, telling the caller to have the worker rebase in its own worktree — the orchestrator never edits files itself. The TS CLI left conflicts in place; the Rust CLI does not.
- 2026-08-30 — The `ok()` helper zeroes `err`, so cores that carry stderr lines alongside a successful exit (diff/merge dirty warnings, attach's static-tail note, cleanup's kept-branch warning) must build the `CommandResult` by hand. Two warnings were silently dropped before a test caught it.
- 2026-08-30 — The obsolete `stubs_report_not_implemented` test in `main.rs` was removed as wave-B ops work landed; dispatch coverage returns later as an integration test driving the built `parl` binary.

## Verified protocol facts

**1. Changing a model mid-session works on both sides (verified 2026-08-30 against the real binaries).**

- Orchestrator (claude): the control request `{"type":"control_request","request_id":"r","request":{"subtype":"set_model","model":"fable"}}` returns `{"subtype":"success"}` and switches the running session with no child restart and no conversation turn. It validates: an unknown id returns `{"subtype":"error","error":"Model \"…\" is not a recognized model id. Run /model to see available models."}` — that text is worth showing to the user verbatim rather than keeping our own model list. Accepted: the aliases `opus`, `sonnet`, `haiku`, `fable`, `opusplan` and full ids such as `claude-opus-5`, `claude-fable-5`. `apply_flag_settings {settings:{model}}` also succeeds but does not validate, so prefer `set_model`. There is no control request that lists models.
- Worker (pi): `{"type":"set_model","provider":"anthropic","modelId":"…"}`, and `{"type":"get_available_models"}` returns the full list, so worker model completions can be real. See `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` under "Model".
- Consequence: `/model` will be a console command that works for the selected session either way, mirroring `/thinking`.

**2. pi extensions can open dialogs, and the TypeScript monitor ignores them — a worker that hits one stalls.**

pi emits `{"type":"extension_ui_request","id":"…","method":"…",…}` on stdout. Dialog methods `select` (`title`, `options`, `timeout`), `confirm` (`title`, `message`, `timeout`), `input`, `editor` block the agent until the client replies on stdin with `{"type":"extension_ui_response","id":"…","value":"…"}`, or `{"…","confirmed":true}`, or `{"…","cancelled":true}`. The `timeout` is in milliseconds and pi auto-resolves with `undefined` when it lapses. Fire-and-forget methods needing no reply: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.

Intended design for the worker-monitor step: treat a dialog request like a `fleet_ask` pending question — record it on the run so the console can show the session as blocked and answer it, and if nobody answers, send `cancelled: true` shortly before pi's own timeout so the worker never hangs. Reference: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`.

**3. The claude stream-json / control protocol, spiked against the real binary (claude 2.1.251, 2026-08-29).** The spike script that produced these (`scripts/spike-claude-protocol.ts`) was deleted at cutover; its findings are recorded here because they were not written down anywhere else.

- `can_use_tool` arrives without any `initialize` handshake (`echo` never prompts — it is in the built-in read-only set — so probe with a writing command). The handshake is sent at startup anyway: its response carries the command/skill list. A bare `{subtype:"initialize"}` is acknowledged with success but is not needed.
- `--allowedTools "mcp__fleet__*"` suppresses permission prompts for the fleet tools.
- `updatedPermissions` built from the request's `permission_suggestions` is honored: after an allow-always, the same command does not prompt again.
- `--append-system-prompt-file` is a hidden flag and works. `system/init` arrives only after the FIRST user message and is re-emitted after every user message; nothing at all is written before the first message. Extra stream messages observed: `system/status {status:"requesting"}`, thinking deltas, `system/task_started|task_notification|background_tasks_changed`.
- A user message injected mid-turn is delivered inside the running turn as a system-reminder right after the next tool result; whether the model acts on it is up to the model (haiku once folded it in, once ignored it as a possible prompt injection). This is why the orchestrator prompt states that `<fleet-event>` messages arriving mid-turn are legitimate and must be acted on.
- Permission modes: `--help` advertises acceptEdits, auto, bypassPermissions, manual, dontAsk, plan; `default` is NOT in that list but the flag accepts it (a hidden alias for `manual`; `bogus` is rejected, so the choice is validated). Over the control protocol, `set_permission_mode` succeeds for every one of default/auto/acceptEdits/dontAsk/plan/manual — the modes the console offers work both at launch and mid-session. The claude Agent SDK type definitions still exist, at `~/Library/Application Support/Code/agent-host/sdk-cache/claude/0.3.220/darwin-arm64/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (only the old path went away); its `PermissionMode` type lags the flag reality.

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
  runs/<runId>/
    run.json            the run's durable facts       (was state.json)
    events.jsonl        the run transcript
    inbox.jsonl         orchestrator/console -> monitor  (was control.jsonl)
    outbox.jsonl        worker -> monitor
    report.md           the worker's final report     (was ../../reports/<runId>.md)
    pi.log              raw pi RPC stream, plus the monitor's own diagnostics
    session/            pi session files
```

Gone for good: the top-level `reports/` directory, `orchestrator.json`, the per-run `monitor.log`, `tui.lock`. There is no migration path and none is wanted — an old `.pi-fleet` is simply ignored.

## Conventions

- Borrow rather than clone; `Result` rather than panic; `thiserror` for typed library errors and `anyhow` at the binary edges; `?` over match chains; doc comments on public items explain *what*, `//` comments only explain *why*. Match the tone of the TypeScript sources — sparse comments with rationale.
- Lints are the contract: `unsafe_code` forbidden; clippy `all`, `perf`, `unwrap_used`, `todo`, `dbg_macro` denied. Unit tests may unwrap via the crate-level `cfg_attr(test, allow(clippy::unwrap_used))`; integration tests under `tests/` need `#![allow(clippy::unwrap_used)]` at the top of each file.
- A worker only edits files it owns. `src/main.rs` and `src/cli.rs` are frozen — the ops signatures they call are the contract.
- Verification before you finish (all four must pass):

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo build --release
```

## Progress

| Step | Status |
| --- | --- |
| scaffold (crate, module tree, CLI surface, util/paths/git/fleet core) | done |
| worker (monitor, rpc, models) | done |
| orch (claude monitor, protocol, prompt, watcher) | pending |
| ops (shared operation layer behind CLI + MCP) | done |
| mcp (stdio server) | pending |
| tui-model (app state, view model, keys) | pending |
| tui-render (views, markdown, theme, runtime) | pending |
| tests (integration under `tests/`, porting the TS suites) | pending |
| cutover (delete TypeScript, README, install) | pending |
