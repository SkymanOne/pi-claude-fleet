# pi-fleet CLI reference

All commands accept `--cwd <dir>` (default: current directory) to locate the fleet: the git repo
root containing `<dir>`, or `<dir>` itself outside git. State lives in `<root>/.pi-fleet/`.

| Command | Purpose | Exit codes |
|---|---|---|
| `spawn <name> [--cwd d] [--model p] [--provider n] [--thinking l] [--no-worktree] [--base ref] [--skill path] [--append-system-prompt t] [--session path\|id] [--tools list] [--exclude-tools list] -- "<brief>"` | start a detached `pi --mode rpc` worker | 0 ok · 1 error |
| `status [<name>] [--json] [--all]` | fleet table (archived hidden unless `--all`) or one run's full state | 0 |
| `wait <name> [--timeout sec]` (default 600) | block until a terminal state | 0 settled · 3 timeout · 4 stopped/error/dead |
| `output <name> [--tail n]` | last assistant text, or last n tool results | 0 |
| `logs <name> [--tail n]` | tail of the raw RPC stream (`rpc.log`) | 0 |
| `send <name> -- "<msg>"` | steer a running worker (delivered after its current tool calls) | 0 · 1 refused (run terminal; prints the resume command) |
| `followup <name> -- "<msg>"` | queue a message for after the worker finishes its current work | 0 · 1 refused |
| `stop <name>` | abort a running worker (state → `stopped`) | 0 · 1 refused |
| `report <name>` | final report (or last assistant text as fallback) + steering-log appendix | 0 · 2 no report and no output |
| `diff <name> [--name-only]` | `git diff --stat <baseCommit>...HEAD` in the worker's worktree | 0 |
| `merge <name> [--no-commit]` | merge the worker branch into the current checkout | 0 · 1 refused (not settled / no branch / not a repo / inside the worker worktree) · 5 conflicts (file list printed) |
| `cleanup <name\|all> [--force]` | remove worktree + branch, mark `archived` (reports/events kept) | 0 · 1 refused (running without `--force`) |
| `open` / `attach <name>` | human console: run menu / live view + steering input (non-TTY `attach` prints the captured tail) | 0 |
| `install-claude-skill` | symlink this skill into `~/.claude/skills` | 0 · 1 refused |

Run names are kebab-cased; a run id is `<name>-<YYYYMMDDHHMMSS>` (UTC); the worker branch is
`pi-fleet/<name>-<last 7 digits>`. `<name>` on the command line resolves to the newest
non-archived run with that name (or an exact run id).

## Run states

`starting → running → settled` (normal) · `stopped` (abort) · `error` (pi exited without settling;
`state.error` holds the reason + stderr tail) · `dead` (monitor process gone without a terminal
state) · `archived` (after cleanup). `wait` treats settled/stopped/error/dead/archived as terminal.

## Files under `.pi-fleet/`

- `runs/<id>/state.json` — `{ id, name, status, cwd, worktree, branch, base, baseCommit, model,
  provider, thinking, sessionArg, skill, appendSystemPrompt, tools, excludeTools, taskBrief,
  fleetDir, repoRoot, isGit, pid, createdAt, settledAt, lastTool, lastActivity, lastAssistantText,
  steerCount, steeringLog: [{ source, ts, message }] (last 20), error }`
- `runs/<id>/events.jsonl` — selected RPC events (`agent_start`, `agent_end`, `agent_settled`,
  `turn_end`, `tool_execution_start/end`, `extension_error`, `auto_retry_start/end`,
  `compaction_start/end`, text `message_update`s stored as `{ type, ev: { type, contentIndex,
  delta, content } }`) plus fleet events `task_prompt { brief }`, `steering_delivered { source,
  message }`, `abort_requested { source }`; every line carries `ts`
- `runs/<id>/control.jsonl` — `{ type: "steer" | "follow_up" | "abort", message, source: "orchestrator" | "console", ts }`
- `runs/<id>/rpc.log` (raw pi stdout), `runs/<id>/monitor.log` (monitor's own stdio),
  `runs/<id>/session/` (pi session files, resumable with `--session <file>`),
  `runs/<id>/console.lock` (live console marker)
- `runs/<id>/progress.md` — optional worker milestones
- `reports/<id>.md` — the worker's fleet report (template: Status / Summary / What I did /
  Files changed / Verification / Decisions & assumptions / Steering received / Open questions /
  Suggested next step)
- `worktrees/<id>/` — the worker's git worktree (removed by `cleanup`)

## Typical session

```bash
pi-fleet spawn add-auth --cwd . -- "Implement …; run pnpm test; commit; write your fleet report."
pi-fleet wait add-auth --timeout 120   # loop while it exits 3
pi-fleet report add-auth
pi-fleet diff add-auth && pi-fleet merge add-auth && pnpm test
pi-fleet cleanup add-auth
```
