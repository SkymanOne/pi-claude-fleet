import fs from "node:fs";
import path from "node:path";
import type { RunState } from "./state.js";

export function reportPath(piFleetDir: string, runId: string): string {
  return path.join(piFleetDir, "reports", `${runId}.md`);
}

/** Orchestrator-side steering log, appended after the worker's own report. */
export function buildSteeringAppendix(state: Pick<RunState, "steerCount" | "steeringLog">): string {
  if (!state.steerCount || !state.steeringLog || state.steeringLog.length === 0) return "";
  const lines = state.steeringLog.map((s) => `- [${s.source}] ${s.ts} ${s.message}`);
  return `\n---\n## Steering log (orchestrator-side, most recent last)\n${lines.join("\n")}\n`;
}

export type ReportResult =
  | { kind: "report"; text: string }
  | { kind: "fallback"; text: string }
  | { kind: "missing"; text: null };

/** The report file wins; else the captured last assistant text; else nothing. */
export function readReport(piFleetDir: string, state: RunState): ReportResult {
  const p = reportPath(piFleetDir, state.id);
  if (fs.existsSync(p)) {
    return { kind: "report", text: fs.readFileSync(p, "utf8") };
  }
  if (state.lastAssistantText) {
    return {
      kind: "fallback",
      text: `[No report file — falling back to last assistant text]\n\n${state.lastAssistantText}`,
    };
  }
  return { kind: "missing", text: null };
}
