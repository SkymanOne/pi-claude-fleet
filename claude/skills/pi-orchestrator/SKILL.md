---
name: pi-orchestrator
description: Orchestrate headless pi coding agents with the pi-fleet CLI — decompose a goal into steps, spawn isolated pi workers (git worktrees), monitor and steer them, collect their fleet reports, merge and verify. Use when asked to delegate implementation work to pi, run pi workers/agents in parallel, or drive a multi-step plan with pi.
---

# pi-orchestrator

You are the orchestrator; `pi` agents are your workers. Everything goes through the `pi-fleet`
CLI (run it with Bash). Command reference, exit codes, and file formats: `references/cli.md`.
Workers see **nothing** except the brief you give them, so briefs must be self-contained.

## The loop

1. **Plan.** Turn the goal into ordered steps with dependencies. Keep a todo list. Mark which
   steps are independent (parallelizable) and which must be sequential.
2. **Brief.** One step = one worker. Each brief states: goal, relevant context (paths, conventions,
   commands), constraints, definition of done, verification commands, and "commit your work in
   your worktree and write your fleet report before finishing". Read-only steps (research, review)
   run with `--no-worktree`.
3. **Spawn.** `pi-fleet spawn <kebab-name> --cwd <repo> [--model <pattern>] -- "<brief>"`.
   Run in parallel only for independent steps; keep at most **3 concurrent workers** (tell the user
   this cap). Report what you started (names, what each does).
4. **Monitor.** Loop: `pi-fleet wait <name> --timeout 120`. Exit 0 = settled → collect. Exit 3 =
   still running → check `pi-fleet status` / `pi-fleet output <name> --tail 5` for liveness, then
   keep waiting; surface a stall to the user if activity stops for several rounds. Exit 4 =
   stopped/error/dead → read `pi-fleet logs <name>`, then decide (respawn with `--session`, rebrief,
   or escalate). Never poll in a tight loop.
5. **Collect.** `pi-fleet report <name>`. Summarize for the user in 2–4 sentences: Status, what was
   done, verification results, open questions. Exit 2 means no report and no output — treat as failed.
6. **Integrate.** `pi-fleet diff <name>` to review, then `pi-fleet merge <name>` from the
   orchestrating checkout. Exit 5 = conflicts: resolve them yourself with normal tools using the
   worker's report, then `git commit`. Run the project's integration checks after every merge.
7. **Console interventions.** The user may run `pi-fleet open` and steer a worker mid-run. The
   report's "Steering received" section and the appended steering log show this. After any
   console interaction, re-read the report, reconcile your plan with the adjusted direction, and do
   not undo console steering unless the result is actually wrong.
8. **Blocked / failed.** Read the report's open questions. If the worker is still running, answer
   with `pi-fleet send <name> -- "<answer>"`; if it settled, spawn a fresh run with the answer in
   the brief (`--session <path>` resumes its context; the refusal message prints the exact command).
   Diagnose repeated failures from `logs` before retrying. Escalate to the user after 2 failed
   attempts on the same step.
9. **Drive forward.** Update the todo list, spawn the next step(s), repeat. When done:
   `pi-fleet cleanup all`, then give the user a rollup — per-step outcomes, merged changes,
   verification results, anything left open.

## Guardrails

- Never merge a run that is not `settled`; never merge work whose report says `failed`.
- Never edit a worker's worktree yourself — steer (`send`) or respawn instead.
- Keep the user informed at every step transition (spawned / settled / merged / blocked).
- Workers are cheap: prefer a fresh, better-briefed worker over endless steering.
- `.pi-fleet/` lives in the target repo and is git-ignored; it is your audit trail (reports,
  events) — leave it until the user asks to remove it.
