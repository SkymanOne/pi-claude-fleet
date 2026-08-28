# pi-claude-fleet

Claude Code orchestrates headless [pi](https://github.com/earendil-works/pi-mono) coding agents.
One package, three parts:

- **`pi-fleet`** CLI — spawns detached `pi --mode rpc` workers in git worktrees, monitors them,
  forwards steering, collects reports, merges.
- **pi package** — `fleet-report` extension + `fleet-worker-report` skill: every worker knows to
  write a structured report before finishing.
- **Claude Code skill** — `pi-orchestrator`: the spawn → monitor → report → merge loop.

Requires Node ≥ 22 and `pi` on `PATH`.

## Install

```bash
pnpm install && pnpm build && pnpm link --global   # `pi-fleet` on PATH (or: npm install -g .)
pi install /path/to/pi-claude-fleet                # optional: pi loads the extension + skill globally
pi-fleet install-claude-skill                      # symlinks claude/skills/pi-orchestrator → ~/.claude/skills
```

`pi-fleet` passes its extension and skill to every worker with `--extension`/`--skill`, so the
`pi install` step is optional.

## Quickstart

```bash
cd your-repo
pi-fleet spawn add-auth -- "Implement …; run the tests; commit; write your fleet report."
pi-fleet wait add-auth --timeout 120      # exit 0 settled · 3 timeout · 4 stopped/error/dead
pi-fleet report add-auth                  # the worker's report + steering log
pi-fleet diff add-auth && pi-fleet merge add-auth
pi-fleet cleanup add-auth
```

Watch or steer a worker from a terminal: `pi-fleet open` (menu) or `pi-fleet attach add-auth`.
Type to steer, `/followup <msg>`, `/stop`, `/quit`.

## Commands

| Command | Purpose |
|---|---|
| `spawn <name> [opts] -- "<brief>"` | start a worker (`--cwd`, `--model`, `--provider`, `--thinking`, `--no-worktree`, `--base`, `--skill`, `--append-system-prompt`, `--session`, `--tools`, `--exclude-tools`) |
| `status [<name>] [--json] [--all]` | fleet table or one run's state |
| `wait <name> [--timeout s]` | block until a terminal state |
| `output <name> [--tail n]` · `logs <name> [--tail n]` | last assistant text / tool trail · raw RPC log |
| `send` · `followup` · `stop` | steer, queue a follow-up, abort |
| `report <name>` | final report (+ steering-log appendix); exit 2 if none |
| `diff <name> [--name-only]` · `merge <name> [--no-commit]` | review and integrate (exit 5 on conflicts) |
| `cleanup <name\|all> [--force]` | remove worktree + branch, archive the run |
| `open` · `attach <name>` | interactive console (non-TTY `attach` prints the captured tail) |
| `install-claude-skill` | link the orchestrator skill for Claude Code |

Exit codes: `0` ok · `1` refusal/error · `2` no report · `3` wait timeout · `4` run ended
stopped/error/dead · `5` merge conflict. Full reference: `claude/skills/pi-orchestrator/references/cli.md`.

## How it works

`spawn` creates `<repo>/.pi-fleet/runs/<id>/` (git-ignored) plus a worktree on branch
`pi-fleet/<name>-<short7>` and launches a detached monitor that owns `pi --mode rpc`. The monitor
records `events.jsonl`, `rpc.log`, and `state.json`; it forwards `control.jsonl` lines
(`steer`/`follow_up`/`abort`, tagged `orchestrator` or `console`) to pi, and shuts pi down once
the run settles. Workers see `PI_FLEET_RUN`/`PI_FLEET_DIR` and the report protocol in their system
prompt; their report lands in `.pi-fleet/reports/<id>.md` with sections Status / Summary /
What I did / Files changed / Verification / Decisions & assumptions / Steering received /
Open questions / Suggested next step.

## Development

```bash
pnpm typecheck && pnpm test   # hermetic: uses tests/fixtures/fake-pi.mjs
pnpm test:e2e                 # real pi + real model (costs tokens); PI_FLEET_E2E_MODEL=<pattern>
```

Design spec and plan: `docs/superpowers/`.
