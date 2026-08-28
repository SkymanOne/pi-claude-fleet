# pi-fleet CLI reference

Every command takes `--cwd <dir>` (default: the current directory) to find the fleet. The fleet dir is the git repo root that contains `<dir>`, or `<dir>` itself when it is not inside a git repo. State lives in `<root>/.pi-fleet/`.

| Command | Purpose | Exit codes |
|---|---|---|
| `spawn <name> [--cwd d] [--model p] [--provider n] [--thinking l] [--no-worktree] [--base ref] [--skill path] [--append-system-prompt t] [--session path\|id] [--tools list] [--exclude-tools list] -- "<brief>"` | start a detached `pi --mode rpc` worker | 0 ok, 1 error |
| `status [<name>] [--json] [--all]` | fleet table (archived runs hidden unless `--all`), or one run's full state | 0 |
| `wait <name> [--timeout sec]` (default 600) | block until the run reaches a terminal state | 0 settled, 3 timeout, 4 stopped/error/dead |
| `output <name> [--tail n]` | last assistant text, or the last n tool results | 0 |
| `logs <name> [--tail n]` | tail of the raw RPC stream (`rpc.log`) | 0 |
| `send <name> -- "<msg>"` | steer a running worker; delivered after its current tool calls finish | 0; 1 refused because the run is terminal (the message prints the resume command) |
| `followup <name> -- "<msg>"` | queue a message for after the worker finishes its current work | 0; 1 refused |
| `stop <name>` | abort a running worker (state becomes `stopped`) | 0; 1 refused |
| `report <name>` | the final report, or the last assistant text as a fallback, with the steering log appended | 0; 2 no report and no output |
| `diff <name> [--name-only]` | `git diff --stat <baseCommit>...HEAD` in the worker's worktree. Uncommitted worker changes are not in the diff or the merge; the command warns about them on stderr | 0; 1 git failure |
| `merge <name> [--no-commit]` | merge the worker branch into the run's orchestrating checkout (`state.repoRoot`, the repo it was spawned from, no matter where you invoke the command) | 0; 1 refused (not settled, no branch, or no repo); 5 conflicts, with the file list printed |
| `cleanup <name\|all> [--force]` | remove the worktree and branch and mark the run `archived` (reports and events are kept). Refuses a running run or a dirty worktree unless `--force` | 0; 1 refused |
| `open`, `attach <name>` | the human console: a run menu, and a live view with a steering input (`attach` on a non-TTY prints the captured tail instead) | 0; `open` exits 1 on a non-TTY |
| `install-claude-skill` | symlink this skill into `~/.claude/skills` | 0; 1 refused |

`--cwd <repo>/sub` still runs a worktree worker at the worktree root, because the worker's cwd is the whole isolated checkout. Put the sub-path in the brief instead.

Run names are kebab-cased. A run id is `<name>-<YYYYMMDDHHMMSS>` (UTC) and the worker branch is `pi-fleet/<name>-<last 7 digits>`. On the command line, `<name>` resolves to the newest non-archived run with exactly that name; a full run id also works.

## Run states

The normal path is `starting`, then `running`, then `settled`. The other outcomes: `stopped` after an abort; `error` when pi exited without settling (`state.error` holds the reason and the stderr tail); `dead` when the monitor process is gone without leaving a terminal state; `archived` after cleanup. `wait` treats settled, stopped, error, dead, and archived as terminal.

## Files under `.pi-fleet/`

- `runs/<id>/state.json`: `{ id, name, status, cwd, worktree, branch, base, baseCommit, model, provider, thinking, sessionArg, skill, appendSystemPrompt, tools, excludeTools, taskBrief, fleetDir, repoRoot, isGit, pid, createdAt, settledAt, lastTool, lastActivity, lastAssistantText, steerCount, steeringLog: [{ source, ts, message }] (last 20), error }`
- `runs/<id>/events.jsonl`: selected RPC events (`agent_start`, `agent_end`, `agent_settled`, `turn_end`, `tool_execution_start/end`, `extension_error`, `auto_retry_start/end`, `compaction_start/end`, and text `message_update`s stored as `{ type, ev: { type, contentIndex, delta, content } }`) plus the fleet's own events: `task_prompt { brief }`, `steering_delivered { source, message }`, `abort_requested { source }`, `control_dropped { control, source, reason }`. Every line carries a `ts`.
- `runs/<id>/control.jsonl`: `{ type: "steer" | "follow_up" | "abort", message, source: "orchestrator" | "console", ts }`
- `runs/<id>/rpc.log` (raw pi stdout), `runs/<id>/monitor.log` (the monitor's own stdio), `runs/<id>/session/` (pi session files; resume one with `--session <file>`), `runs/<id>/console.lock` (marker for a live console)
- `runs/<id>/progress.md`: optional milestones the worker appends
- `reports/<id>.md`: the worker's fleet report, with the sections Status, Summary, What I did, Files changed, Verification, Decisions & assumptions, Steering received, Open questions, Suggested next step
- `worktrees/<id>/`: the worker's git worktree (removed by `cleanup`)

## Typical session

```bash
pi-fleet spawn add-auth --cwd . -- "Implement …; run pnpm test; commit; write your fleet report."
pi-fleet wait add-auth --timeout 120   # loop while it exits 3
pi-fleet report add-auth
pi-fleet diff add-auth && pi-fleet merge add-auth && pnpm test
pi-fleet cleanup add-auth
```
