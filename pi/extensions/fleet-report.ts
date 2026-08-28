/**
 * pi-fleet worker protocol.
 *
 * When pi runs as a fleet worker (PI_FLEET_RUN + PI_FLEET_DIR set by `pi-fleet`'s
 * monitor), append the report protocol to the system prompt so report-writing does not
 * depend on the model discovering the skill. Idempotent: safe if loaded both via
 * `pi install` and `--extension`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FLEET_PROTOCOL_MARKER = "## Fleet worker protocol";

export const REPORT_TEMPLATE = `# Fleet Report: <run name>

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
(one concrete next action for the orchestrator)`;

export interface FleetEnv {
  PI_FLEET_RUN?: string;
  PI_FLEET_DIR?: string;
}

export function buildFleetProtocol(env: FleetEnv, cwd: string): string | null {
  const runId = env.PI_FLEET_RUN;
  const fleetDir = env.PI_FLEET_DIR;
  if (!runId || !fleetDir) return null;
  const reportPath = `${fleetDir}/reports/${runId}.md`;
  const progressPath = `${fleetDir}/runs/${runId}/progress.md`;
  return [
    FLEET_PROTOCOL_MARKER,
    "",
    `You are a fleet worker. Run id: \`${runId}\`. Working directory: \`${cwd}\`. The orchestrator (Claude Code) reads your results from files, not from this conversation.`,
    "",
    "Rules:",
    `1. Before you finish (before your final assistant turn), write your final report to \`${reportPath}\` using EXACTLY the template below — keep every heading, in order.`,
    `2. For long tasks, append one line per milestone to \`${progressPath}\`.`,
    "3. Stay scoped to your task brief. Do not touch files outside your working directory. Never run `git merge`, never modify the parent checkout, never push.",
    "4. If you receive steering messages mid-run (course corrections from the orchestrator or from the user's console), incorporate them immediately. Your final report MUST reflect the adjusted direction: list every steering message under \"Steering received\" and keep Status/Verification consistent with the work as finally done.",
    "5. If you are blocked, set `Status: blocked` and fill \"Open questions for orchestrator\" instead of guessing.",
    "",
    "Report template:",
    "",
    "```markdown",
    REPORT_TEMPLATE,
    "```",
  ].join("\n");
}

export default function fleetReport(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const block = buildFleetProtocol(process.env, ctx.cwd);
    if (!block) return;
    if (event.systemPrompt.includes(FLEET_PROTOCOL_MARKER)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}
