import fs from "node:fs";
import path from "node:path";
import { BIN_NAME, ORCHESTRATOR_PROMPT_PATH } from "../paths.js";

export interface PromptVars {
  fleetDir: string;
  repoRoot: string;
  maxWorkers?: number;
  binName?: string;
}

export const DEFAULT_MAX_WORKERS = 3;

/** Fill the shipped template's `{{PLACEHOLDER}}`s. Unknown placeholders are left untouched. */
export function renderOrchestratorPrompt(vars: PromptVars, template: string = fs.readFileSync(ORCHESTRATOR_PROMPT_PATH, "utf8")): string {
  const values: Record<string, string> = {
    FLEET_DIR: vars.fleetDir,
    REPO_ROOT: vars.repoRoot,
    MAX_WORKERS: String(vars.maxWorkers ?? DEFAULT_MAX_WORKERS),
    BIN_NAME: vars.binName ?? BIN_NAME,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

export function renderedPromptPath(piFleetDir: string): string {
  return path.join(piFleetDir, "orchestrator.prompt.md");
}

/** Render into `<fleetDir>/orchestrator.prompt.md` (what `--append-system-prompt-file` reads) and return the path. */
export function writeRenderedPrompt(piFleetDir: string, vars: PromptVars): string {
  const target = renderedPromptPath(piFleetDir);
  fs.mkdirSync(piFleetDir, { recursive: true });
  fs.writeFileSync(target, renderOrchestratorPrompt(vars));
  return target;
}
