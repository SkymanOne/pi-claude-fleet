---
name: fleet-worker-report
description: How to write the final report for a pi-fleet worker run (exact markdown template, what each section needs, how to reflect mid-run steering). Use whenever PI_FLEET_RUN is set or a task brief asks for a fleet report.
---

# Fleet worker report

You are running as a worker for `pi-fleet`. The orchestrator never reads this chat; it reads
`$PI_FLEET_DIR/reports/$PI_FLEET_RUN.md`. Write that file **before your final turn**, every time,
even when the task failed or you are blocked.

## Template (copy verbatim, keep all headings in this order)

```markdown
# Fleet Report: <run name>

## Status
done | blocked | failed

## Summary
(3-8 sentences: what was accomplished and the outcome)

## What I did
(numbered steps actually taken)

## Files changed
(path: one-line reason — from your actual edits)

## Verification
(command run → result, for each check performed)

## Decisions & assumptions
(any choice made without explicit instruction)

## Steering received
(mid-run course corrections you were given and how you handled them; "none" if none)

## Open questions for orchestrator
(things you could not resolve — empty if none; REQUIRED if Status: blocked)

## Suggested next step
(one concrete next action for the orchestrator)
```

## Section guidance

- **Status** — exactly one word. `done` only if the definition of done in your brief is met and
  verified. `blocked` when you need a decision or missing input (then Open questions is mandatory).
  `failed` when you tried and could not make it work.
- **Summary** — outcome first, then how. No narration of dead ends unless they matter.
- **What I did** — numbered, past tense, concrete ("Added `parseArgs()` in src/cli.ts"), not intentions.
- **Files changed** — one line per file, from your real edits (`git status` / `git diff --stat` is
  your source of truth). Say "none" if you changed nothing.
- **Verification** — each check as `command → result`. If you ran nothing, say so; do not invent.
- **Decisions & assumptions** — anything the brief left open that you decided. The orchestrator
  reviews these.
- **Steering received** — list every steering / follow-up message you got, when relative to your
  work, and what changed because of it. The orchestrator compares this with its own steering log.
  Write `none` if there was none. Status and Verification must describe the work as finally done
  after steering, not the original plan.
- **Open questions for orchestrator** — precise, answerable questions. Empty when nothing is open.
- **Suggested next step** — one action ("merge the branch", "re-run with X clarified").

## Rules

- Stay inside your working directory; never `git merge`, never touch the parent checkout, never push.
- Commit your work in your worktree when the brief asks for commits (the orchestrator merges).
- For long tasks, append one-line milestones to `$PI_FLEET_DIR/runs/$PI_FLEET_RUN/progress.md`.
