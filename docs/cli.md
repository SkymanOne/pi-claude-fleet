# Headless commands

The TUI is one client. The same fleet is driveable from scripts.

| Command | What it does |
| --- | --- |
| `spawn <name> [opts] -- "<brief>"` | start a worker (`--cwd`, `--model`, `--provider`, `--thinking`, `--no-worktree`, `--base`, `--skill`, `--append-system-prompt`, `--session`, `--tools`, `--exclude-tools`). A `--model` pi does not have is refused before a worktree exists, naming the closest models it does have |
| `status [<name>] [--json] [--all]` | fleet table, or one run's full state. `--json` includes each run's `activeModel`, `pendingQuestion` and the commands it offers |
| `wait <name> [--timeout s]` | block until the run reaches a terminal state |
| `output <name> [--tail n]` | last assistant text, or the last n tool results |
| `logs <name> [--tail n]` | tail of the raw RPC log |
| `send`, `followup`, `answer`, `stop` | steer, queue a follow-up, answer a question, abort |
| `report <name>` | the final report with the steering log appended. Exit 2 if there is none |
| `diff <name> [--name-only]` | what the worker changed against its base commit |
| `merge <name> [--no-commit]` | merge the worker's branch. Exit 5 on conflicts, with the merge aborted and the checkout clean |
| `cleanup <name\|all> [--force]` | remove the worktree and branch, archive the run |
| `attach <name> [--tail n]` | print a worker's transcript tail |
| `mcp` | serve the fleet tools over stdio (what the orchestrator runs) |

Exit codes: 0 ok, 1 refusal or error, 2 no report, 3 wait timed out, 4 the run ended stopped/error/dead, 5 merge conflict.

`diff` and `merge` only see committed work. If a worker forgets to commit, `diff` warns on stderr and a non-forced `cleanup` refuses to delete the dirty worktree. Brief your workers to commit.
