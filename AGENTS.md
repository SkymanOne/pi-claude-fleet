# AGENTS.md

Working notes for agents building this repository. Keep it factual and short; update it when you own a step.

## What this is

`pi-claude-fleet` is a terminal app that runs a fleet of headless [pi](https://github.com/earendil-works/pi-mono) coding agents with Claude Code as the orchestrator. You talk to the orchestrator; it spawns pi workers, each in its own git worktree; workers report back through files under the state directory; you watch, steer, and answer questions from the console. The `feature/rust` branch is a full rewrite of the original TypeScript implementation in Rust with `ratatui`; the TypeScript tree was deleted at cutover (2026-08-30) and the Rust build is the only implementation. The binary is **`parl`** — the project/repository is still called pi-claude-fleet, only the command is `parl`.

## Architecture

Single crate `parl`, lib + bin. The library is the contract; the binary only parses and dispatches.

| Module | Owns |
| --- | --- |
| `src/main.rs` | clap parsing + dispatch to every subcommand; the only file that touches every module. |
| `src/cli.rs` | the clap `Parser`/`Subcommand` definitions and the `ExitCode` enum (0 ok, 1 refusal/error, 2 no report, 3 wait timeout, 4 run ended stopped/error/dead, 5 merge conflict). The ops signatures `main.rs` calls are the contract between the CLI surface and the operation layer. |
| `src/util.rs` | ids (`m_`, `ev_` prefixes), RFC3339 timestamps with milliseconds, atomic JSON writes (tmp file + fsync + rename), JSONL framing (`split_json_lines`), `read_new_lines` offsets, `sanitize_name`, branch/run-id formats (`parl/<name>-<7>`). |
| `src/paths.rs` | the `.parl` layout as `FleetPaths`; `STATE_DIR_NAME` and `ENV_PREFIX` constants (every env var name derives from `ENV_PREFIX`); `ensure()` creates the layout and gitignores it. |
| `src/git.rs` | thin wrapper over the git CLI: `git_raw` real-exit-code execution, repo root discovery, worktree add/remove, branch delete, diff against a base commit, merge with conflict detection and `--abort`, dirty/merged checks. |
| `src/fleet/run.rs` | `RunState` (stored as `runs/<id>/run.json`, serde tolerant of unknown/missing fields, camelCase on disk), `RunStatus`, derived status/view (30 s starting grace, `kill(pid,0)` liveness with EPERM-alive), `find_run`/`list_runs`, steering log (capped at 20), `THINKING_LEVELS`. |
| `src/fleet/envelope.rs` | the mailbox envelope (`{"id","ts","from","to","type","payload"}`) shared by every `inbox.jsonl` and `outbox.jsonl` line; party parsing; typed builders/decoders for the six inbox types and three outbox types. Contract pinned byte-for-byte — see the module doc. |
| `src/fleet/event.rs` | `FleetEvent` and `<fleet-event>` rendering; `sanitize_field`/`attr` are the security boundary that stops worker text forging or closing a block. |
| `src/fleet/report.rs` | reading `runs/<id>/report.md` with the steering appendix, falling back to last assistant text. |
| `src/worker/` | the detached worker monitor (`monitor.rs`), pi RPC message types (`rpc.rs`), `pi --list-models` and model checking (`models.rs`). The monitor also materialises the embedded pi extension and skill into `.parl/pi/` at boot. |
| `src/orch/` | the claude side: stream-json wire types (`protocol.rs`), argv builder (`args.rs`), child process (`process.rs`), detached monitor (`monitor.rs`), transcript records (`records.rs`), console-side client (`client.rs`), embedded prompt (`prompt.rs`), the `.mcp.json` (`mcp_config.rs`), health (`health.rs`), the run-state watcher that turns state into fleet events (`watcher.rs`), and the session store for `fleet.json` (`session.rs`). |
| `src/ops/` | the shared operation layer both the CLI and the MCP tools call: `spawn.rs`, `query.rs` (status/output/logs/report/wait/attach), `steer.rs` (send/followup/answer/stop), `integrate.rs` (diff/merge/cleanup). The CLI-shaped signatures live beside `_core` variants that take a `Party` source, so the console and MCP can attribute actions honestly. |
| `src/mcp/` | the stdio MCP server (`server.rs`), one tool per op, built on `rmcp`. Server name stays `fleet` so tools stay `mcp__fleet__*`. |
| `src/tui/` | the console: app state and update loop (`app.rs`), view model (`model.rs`), modal keys (`keys.rs`), palette (`palette.rs`), completions (`completions.rs`), transcript (`transcript.rs`), markdown rendering (`markdown.rs`), theme (`theme.rs`), crossterm runtime (`runtime.rs`), and `view/` draw functions (dashboard, session, composer, overlay, statusline). |
| `pi/`, `prompts/` | TypeScript on purpose: `pi/extensions/fleet-worker.ts` and `pi/skills/fleet-worker-report/SKILL.md` are embedded into the binary with `include_str!` and materialised into `.parl/pi/` at worker boot; `prompts/orchestrator.md` is the embedded orchestrator prompt. |

## Key decisions

Dated; newest last. Record anything that did not work out here too.

- 2026-08-30 — Single crate `parl`, lib + bin; edition 2024; version 0.2.0. The binary is `parl` (renamed from `pi-fleet` mid-scaffold): greenfield rewrite, no migration path, so the command and its state directory share a name. The MCP server name stays `fleet` (`mcp__fleet__*`).
- 2026-08-30 — State directory is `.parl/` and env prefix is `PARL` (`PARL_DIR`, `PARL_RUN`, `PARL_PI_BIN`, `PARL_CLAUDE_BIN`, `PARL_PROMPT`, `PARL_ASK_TIMEOUT_MS`, `PARL_ASK_POLL_MS`), each name derived from `ENV_PREFIX` in `src/paths.rs`. The old `.pi-fleet/` is simply ignored by `parl` — no migration, no back-compat reader; it stays gitignored because a live orchestrator was still running out of it while the rewrite was carried out.
- 2026-08-30 — tokio for all async plumbing (process, fs, io, signal); `ratatui` with a dashboard + drill-down UI and modal (normal/insert) keys.
- 2026-08-30 — The git CLI rather than `git2`; every git interaction goes through `git_raw`, which trusts the real exit code (merge conflicts print to stdout, so stderr sniffing is wrong).
- 2026-08-30 — The orchestrator prompt override order (for `src/orch/prompt.rs`): `$PARL_PROMPT` (a path; set-but-missing is an *error*, it is explicit intent), then `<repo>/.parl/orchestrator.md`, then `~/.config/parl/orchestrator.md`, then the copy embedded in the binary with `include_str!`. Nothing is ever copied into a project.
- 2026-08-30 — `Cargo.lock` is committed (this is a binary).
- 2026-08-30 — `unsafe_code = "forbid"` makes `libc::kill` unusable for the liveness check, so pid liveness goes through `nix::sys::signal::kill` (EPERM counts as alive). `libc` stays in the tree for later FFI needs. `nix` was added beyond the original dependency list for this reason.
- 2026-08-30 — `tui-textarea 0.7.0` pins `ratatui ^0.29` (no release supports 0.30 yet), so `ratatui` is pinned to `0.29.0` with `crossterm 0.28.1` and `unicode-width 0.2.0` exactly. Verified with a throwaway example (render into `TestBackend`), then deleted.
- 2026-08-30 — `rmcp 3.1.4` verified to build and to serve a `ServerHandler` with `list_tools`/`call_tool` over `transport::stdio()` (throwaway example compiled and run, then deleted). Its `#[non_exhaustive]` model types are constructed via `Default` + field assignment.
- 2026-08-30 — Mailboxes carry the envelope shape directly (`inbox.jsonl` lines are envelopes addressed `to: worker:<runId>`); the old flat `control.jsonl` shape is gone. Unknown `type` values and unknown payload fields parse but decode to `None` and readers skip the line, so a newer writer cannot crash an older reader.
- 2026-08-30 — Steering provenance is the envelope's `from` party. The CLI wrappers attribute to `orchestrator` (the agent drives these tools); the console and MCP thread `Party::Console` through the `_core` variants, which the watcher reads to surface human interventions as events the orchestrator reconciles with instead of undoing.
- 2026-08-30 — `answer` targets the explicit `--question` id when given (the monitor routes by id, even when it is not the pending one), else the run's pending `fleet_ask` question, else a pending extension dialog (`pendingDialog`) — either kind of block is answerable.
- 2026-08-30 — `merge` always aborts on conflict (exit 5) and names the base commit in the error, telling the caller to have the worker rebase in its own worktree — the orchestrator never edits files itself. The TS CLI left conflicts in place; the Rust CLI does not.
- 2026-08-30 — The `ok()` helper zeroes `err`, so cores that carry stderr lines alongside a successful exit (diff/merge dirty warnings, attach's static-tail note, cleanup's kept-branch warning) must build the `CommandResult` by hand. Two warnings were silently dropped before a test caught it.
- 2026-08-30 — Worker dialogs are recorded as `pendingDialog` (the `PendingQuestion` shape plus `method`) rather than overloading `pendingQuestion`, so the console renders both identically but can tell them apart; `derive_view` treats either as blocked. `confirm` answers map yes-ish words (`y/yes/true/1/ok/confirm/allow/always`) to `confirmed: true`, an empty answer dismisses with `cancelled: true`, `select`/`input`/`editor` pass the text through as `value`. Dialogs auto-cancel at `timeout − 500 ms` (10 minutes when the request carries none) — shortly before pi's own timeout, so a worker can never hang on an unanswered prompt. Fire-and-forget UI requests are mirrored into `events.jsonl` but unknown future methods are never replied to (a reply would be a guess).
- 2026-08-30 — A `model` envelope with `provider: null` resolves against the cached `get_available_models` list; an unknown id, or the same id under several providers, produces a `model_unresolved` event and nothing is sent. An explicit provider passes through as-is for pi to validate (`model_rejected` on refusal). The rewritten extension writes outbox `to: "fleet"` per the pinned contract, not the TS extension's `to: "orchestrator"` (nothing reads that field).
- 2026-08-30 — Launch options travel in `fleet.json`'s `launch` record, not the CLI: the frozen monitor CLI takes only `--fleet-dir`, so the console records model/budget/permission-mode/remote-control/fresh there before spawning a monitor (never on attach — a running monitor keeps what it was launched or live-changed to); the monitor consumes `fresh` once at boot and writes permission-mode/remote-control changes back.
- 2026-08-30 — Rust does not reap detached children on drop (Node's `unref()` did it for free), so a spawned monitor lingered as a zombie whose pid kept looking alive. `spawn_monitor` (orch `client.rs`) and later `launch_monitor` (ops `spawn.rs`) both use `tokio::process::Command` (which has the safe `process_group(0)`; `pre_exec` is `unsafe` and forbidden) and reap via a background task. Apply the same care wherever a detached child is spawned.
- 2026-08-30 — The pending-permission list in `state.json` is derived; removing a request from the derived list instead of the pending map let the next flush resurrect it. The map is the source of truth. And `ProcEvent::Error` ends the monitor: Node emitted `error` (never `close`) for spawn failures, so the TS monitor hung forever on a bad binary.
- 2026-08-30 — The orphan reaper's matcher is a parameter (default constant `ORPHAN_MATCHER = "claude"`), since tests reap a stand-in; the TS default-parameter shape, made explicit.
- 2026-08-30 — `fleet_spawn`'s output schema declares `fleetDir`, not the TS `piFleetDir`: the schema must match what the ops `SpawnData` actually serialises (`fleet_dir` → `fleetDir`). `runId`/`runDir`/`worktree`/`branch` are unchanged. `fleet_wait` defaults to 120 s (the TS tool's default), not the CLI's 600 s, with `timeoutSec` validated 1..=600. rmcp's `tracing` gets no subscriber, so server diagnostics never pollute stdout; unparsable stdin lines are skipped and well-formed-but-invalid messages get a JSON-RPC protocol error — the TS server's input guard comes built in.
- 2026-08-30 — The palette ranks with `nucleo-matcher` into five labelled groups (console, agent, servers, models, sessions); agent commands are passed through verbatim and never filtered — they are the agent's surface, not ours. Worker model completions are real (`get_available_models`), not a hardcoded list. In normal mode any unbound printable falls through as `InsertChar` so starting to type is never punished, and the help overlay is generated from the same `NORMAL_KEYS`/`INSERT_KEYS` tables as the bindings, so they cannot drift.
- 2026-08-30 — Console prefs (`Prefs`, including `lastSession` and the `/rail` width) live in `fleet.json` under a `"console"` key with read-modify-write that preserves the watcher's cursors.
- 2026-08-30 — The renderer reads polled copies beside the state machine (`view::Feeds`: `&OrchestratorState`, `&[RunEntry]`) rather than widening it — same facts, same source, no state-machine changes. Ctrl-C is read as a key (raw mode never turns it into SIGINT), matching the ink console's `exitOnCtrlC`. `NO_COLOR` folds colours but keeps attributes, so emphasis survives monochrome. `/rail full` hides the session list (all transcript) rather than stretching it. Search highlighting is a per-span background patch over the block's own style; blank separators are renderer-owned, not stored. Transcript offsets start at zero on console open, so the first poll *is* the replay, through the same ingest path a live tail uses.
- 2026-08-30 — The console owns one `FleetWatcher` for its lifetime, cursors persisted to `fleet.json` after every forwarded batch, so a console that dies right after telling the orchestrator something does not tell it again on reopen. `FleetWatcher::start(snapshot: true)` only when attaching to a live monitor; a freshly spawned monitor learns the fleet itself. `Transcript::partial` returns an owned `Option<String>` — it used to `Box::leak` the joined stream per frame while a worker streamed.
- 2026-08-30 — Dashboard diff stats are fed on a 10 s cadence (`DIFF_STAT_MS`) because `diff_core` shells out to git; a stat clears when its diff stops applying (worktree gone, no changes). The non-interactive refusal checks that stdin/stdout are TTYs (`crossterm::tty::IsTty`), not `terminal::size()`, whose `tput` fallback answers even with no controlling terminal — the old check sailed past the friendly refusal and died in raw mode.
- 2026-08-30 — Test harness shapes: tests drive `parl monitor` as a real child process (via `assert_cmd`) so pid liveness, monitor exit and signals are exercised the way production runs; fake-pi/fake-claude tests serialise on a per-fixture `SERIAL` mutex and poll (150 ms) with 20–40 s deadlines tuned for concurrent builders. `fake-pi-session.mjs` is a wrapper over `fake-pi-parl.mjs` adding exactly one behaviour (pi writes session files into `--session-dir`); the base fixture stays byte-identical.
- 2026-08-30 — **`glm-5.3-flash` (openrouter) is the model this fleet works with.** `deepseek-v4-flash` is unusable for agentic work here: it emits tool calls as `<|DSML|>` markup inside a thinking block instead of structured tool calls, so pi sees prose, ends the turn, and the agent does nothing. Recorded so it is not rediscovered.

## Verified protocol facts

**1. Changing a model mid-session works on both sides (verified 2026-08-30 against the real binaries).**

- Orchestrator (claude): the control request `{"type":"control_request","request_id":"r","request":{"subtype":"set_model","model":"fable"}}` returns `{"subtype":"success"}` and switches the running session with no child restart and no conversation turn. It validates: an unknown id returns `{"subtype":"error","error":"Model \"…\" is not a recognized model id. Run /model to see available models."}` — that text is shown to the user verbatim rather than keeping our own model list. Accepted: the aliases `opus`, `sonnet`, `haiku`, `fable`, `opusplan` and full ids such as `claude-opus-5`, `claude-fable-5`. `apply_flag_settings {settings:{model}}` also succeeds but does not validate, so prefer `set_model`. There is no control request that lists models.
- Worker (pi): `{"type":"set_model","provider":"anthropic","modelId":"…"}`, and `{"type":"get_available_models"}` returns the full list, so worker model completions are real. See `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` under "Model".
- Consequence: `/model` is a console command that works for the selected session either way, mirroring `/thinking`.

**2. pi extensions can open blocking dialogs.**

pi emits `{"type":"extension_ui_request","id":"…","method":"…",…}` on stdout. Dialog methods `select` (`title`, `options`, `timeout`), `confirm` (`title`, `message`, `timeout`), `input`, `editor` block the agent until the client replies on stdin with `{"type":"extension_ui_response","id":"…","value":"…"}`, or `{"…","confirmed":true}`, or `{"…","cancelled":true}`. The `timeout` is in milliseconds and pi auto-resolves with `undefined` when it lapses. Fire-and-forget methods needing no reply: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.

The worker monitor treats a dialog request like a `fleet_ask` pending question — it is recorded on the run (`pendingDialog`) so the console shows the session as blocked and answers it, and if nobody answers, the monitor sends `cancelled: true` shortly before pi's own timeout so the worker never hangs. Reference: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`.

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

`inbox.jsonl`, `outbox.jsonl` and `session/` are created lazily, on first use — a run that is never steered has no `inbox.jsonl` on disk even though the tree lists it. Gone for good: the top-level `reports/` directory, `orchestrator.json`, the per-run `monitor.log`, `tui.lock`. There is no migration path and none is wanted — an old `.pi-fleet` is simply ignored.

## Known issues

- **The orchestrator monitor does not exit when its fleet directory disappears.** During the rewrite, 16 orphaned `parl orchestrator-monitor` processes accumulated from a deleted worktree, polling on timers for an hour against temp dirs that no longer existed. In real use, deleting `.parl` leaves a monitor running forever. The fix is a liveness check on the fleet dir in the monitor's poll loop.
- **`fleet_spawn`'s structured output field is `fleetDir`**, where the TypeScript emitted `piFleetDir`. Intentional — it follows `SpawnData`'s serialisation — but noted in case anything reads it.
- **Test flakes: one repair round merged, two sites open in frozen files.** The first repair run (rust-fixes, merged as `cf08a69`) fixed the zombie reap in `launch_monitor`, the git-subprocess-transient family (one shared bounded-retry `git::test_support::git_sync` helper), and the `run.json` flush races in `tests/worker_monitor.rs`; it sustained 11 consecutive clean full-suite runs. Still failing, same environmental family (fresh paths / transient subprocess results under heavy parallel load): `src/ops/mod.rs:157` (`canonicalize()` of the git-reported root → NotFound, ~3% per run) and `src/worker/models.rs:155/:176` (the `sh <script>` model listing transiently returns nothing and `list_models` caches the empty result). A follow-up run (rust-fixes2) was in flight at cutover; check its report before trusting the suite as flake-free. Note: this worktree's branch is based on `2193fee` and predates `cf08a69`; the two change sets touch disjoint files (the fixes are test-module-only in files the cutover never edited), so merging both is expected to be conflict-free.

## Conventions

- Borrow rather than clone; `Result` rather than panic; `thiserror` for typed library errors and `anyhow` at the binary edges; `?` over match chains; doc comments on public items explain *what*, `//` comments only explain *why*. Sparse comments with rationale — the TypeScript sources that once set the tone are gone, but the tone stays.
- Lints are the contract: `unsafe_code` forbidden; clippy `all`, `perf`, `unwrap_used`, `todo`, `dbg_macro` denied. Unit tests may unwrap via the crate-level `cfg_attr(test, allow(clippy::unwrap_used))`; integration tests under `tests/` need `#![allow(clippy::unwrap_used)]` at the top of each file.
- The CLI surface is the contract: `main.rs` dispatches, `cli.rs` parses, and the ops signatures they call are the seam — change all three together or none.
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
| orch (claude monitor, protocol, prompt, watcher) | done |
| ops (shared operation layer behind CLI + MCP) | done |
| mcp (stdio server) | done |
| tui-model (app state, view model, keys) | done |
| tui-render (views, markdown, theme, runtime) | done |
| tests (integration under `tests/`, driving the built `parl` binary) | done |
| cutover (delete TypeScript, README, install) | done |
