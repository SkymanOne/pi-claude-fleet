# pi-claude-fleet

Lets Claude Code run [pi](https://github.com/earendil-works/pi-mono) coding agents as workers. Claude plans and writes the briefs; pi does the typing in an isolated git worktree; a structured report comes back; Claude reviews it and merges.

Three pieces ship in this package:

- The `pi-fleet` CLI. It starts detached `pi --mode rpc` workers, watches them, forwards steering messages, collects their reports, and merges their branches.
- A pi extension and skill (`fleet-report`, `fleet-worker-report`) that tell every worker how and where to write its report.
- A Claude Code skill (`pi-orchestrator`) that teaches the spawn, monitor, report, merge loop.

You need Node 22 or newer and `pi` on your `PATH`.

## Install

There are three things to install, and only the first is required. Run everything from a clone of this repo.

### 1. The `pi-fleet` CLI (required)

```bash
pnpm install && pnpm build   # compiles src/ to dist/
pnpm link --global           # puts `pi-fleet` on your PATH (npm users: npm install -g .)
pi-fleet --help              # verify
```

The orchestrator skill runs `pi-fleet` from Claude Code's Bash tool, so it has to be on the PATH of the shell Claude Code uses. `pnpm unlink --global pi-claude-fleet` removes it.

### 2. The Claude Code skill (`pi-orchestrator`)

```bash
pi-fleet install-claude-skill                 # symlinks claude/skills/pi-orchestrator into ~/.claude/skills/
ls -la ~/.claude/skills/pi-orchestrator       # verify: a symlink back into this repo
```

Claude Code reads personal skills from `~/.claude/skills/<name>/SKILL.md`. Start a new Claude Code session; the skill is then available as `/pi-orchestrator` and Claude also loads it on its own when you ask it to delegate work to pi. Because it is a symlink, `git pull` in this repo updates the skill in place. The command refuses to overwrite anything at that path that it did not create; remove the old directory first if you have one.

Prefer a per-project skill instead? Copy it into the repo you are orchestrating: `cp -R claude/skills/pi-orchestrator <repo>/.claude/skills/`. To uninstall the personal one: `rm ~/.claude/skills/pi-orchestrator` (it is only a link).

### 3. The pi package (optional)

You can skip this. `pi-fleet` already passes the worker extension and skill to every worker it spawns (`--extension pi/extensions/fleet-report.ts --skill pi/skills/fleet-worker-report`), so workers get the report protocol without any pi-side install.

Install it anyway if you want to run pi as a worker by hand (`PI_FLEET_RUN=... PI_FLEET_DIR=... pi`) or want the `fleet-worker-report` skill visible in ordinary pi sessions:

```bash
pi install /absolute/path/to/pi-claude-fleet      # global: ~/.pi/agent/settings.json
pi install -l /absolute/path/to/pi-claude-fleet   # or project-local: <repo>/.pi/settings.json
pi list                                          # verify: the path appears under packages
```

pi references the directory in place (no copy), so edits here are live. The extension does nothing unless `PI_FLEET_RUN` is set, and it is safe to have it loaded both ways: the system-prompt block is only added once. Remove it with `pi remove /absolute/path/to/pi-claude-fleet` (add `-l` for a project-local install).

## Quickstart

```bash
cd your-repo
pi-fleet spawn add-auth -- "Implement …; run the tests; commit; write your fleet report."
pi-fleet wait add-auth --timeout 120      # exit 0 settled, 3 timeout, 4 stopped/error/dead
pi-fleet report add-auth                  # the worker's report plus the steering log
pi-fleet diff add-auth && pi-fleet merge add-auth
pi-fleet cleanup add-auth
```

To watch a worker, or nudge it mid-run, open a terminal and run `pi-fleet open` (a menu of runs) or `pi-fleet attach add-auth`. Anything you type is sent as a steering message; `/followup <msg>`, `/stop`, and `/quit` do what they say. Whatever you send shows up in the worker's report under "Steering received", so the orchestrator finds out too.

## Commands

| Command | What it does |
|---|---|
| `spawn <name> [opts] -- "<brief>"` | start a worker (`--cwd`, `--model`, `--provider`, `--thinking`, `--no-worktree`, `--base`, `--skill`, `--append-system-prompt`, `--session`, `--tools`, `--exclude-tools`) |
| `status [<name>] [--json] [--all]` | fleet table, or one run's full state |
| `wait <name> [--timeout s]` | block until the run reaches a terminal state |
| `output <name> [--tail n]` | last assistant text, or the last n tool results |
| `logs <name> [--tail n]` | tail of the raw RPC log |
| `send`, `followup`, `stop` | steer, queue a follow-up, abort |
| `report <name>` | the final report with the steering log appended; exit 2 if there is none |
| `diff <name> [--name-only]` | what the worker changed against its base commit |
| `merge <name> [--no-commit]` | merge the worker's branch; exit 5 on conflicts |
| `cleanup <name\|all> [--force]` | remove the worktree and branch, archive the run |
| `open`, `attach <name>` | the interactive console (`attach` on a non-TTY just prints the captured tail) |
| `install-claude-skill` | link the orchestrator skill for Claude Code |

Exit codes: 0 ok, 1 refusal or error, 2 no report, 3 wait timed out, 4 the run ended stopped/error/dead, 5 merge conflict. The full reference, including the state file layout, is in `claude/skills/pi-orchestrator/references/cli.md`.

## How it works

`spawn` creates `<repo>/.pi-fleet/runs/<id>/` (git-ignored) and a worktree on the branch `pi-fleet/<name>-<short7>`, then launches a detached monitor process that owns `pi --mode rpc`. The monitor writes `events.jsonl`, `rpc.log`, and `state.json`, forwards any line appended to `control.jsonl` (`steer`, `follow_up`, `abort`, each tagged `orchestrator` or `console`) to pi, and shuts pi down once the run settles. Because the monitor is detached, the orchestrating Claude session can exit and come back later; state lives on disk, not in anyone's memory.

The worker sees `PI_FLEET_RUN` and `PI_FLEET_DIR` in its environment and the report protocol in its system prompt. Its report lands in `.pi-fleet/reports/<id>.md` with fixed sections: Status, Summary, What I did, Files changed, Verification, Decisions & assumptions, Steering received, Open questions, Suggested next step.

One thing to know: `diff` and `merge` only see committed work. If a worker forgets to commit, `diff` warns you on stderr, and a non-forced `cleanup` refuses to delete the dirty worktree. Brief your workers to commit.

## Development

```bash
pnpm typecheck && pnpm test   # hermetic; uses tests/fixtures/fake-pi.mjs instead of a real model
pnpm test:e2e                 # real pi and a real model, so it costs tokens; PI_FLEET_E2E_MODEL=<pattern> picks the model
```

The design spec and the implementation plan (with a table of where the code deviates from the spec) are in `docs/superpowers/`.
