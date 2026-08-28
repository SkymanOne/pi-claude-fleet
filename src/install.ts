import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_SKILL_SOURCE } from "./paths.js";

export interface InstallResult {
  status: "created" | "exists";
  target: string;
  source: string;
}

/** Symlink the bundled pi-orchestrator skill into `<home>/.claude/skills`. */
export function installClaudeSkill(opts: { home?: string; source?: string } = {}): InstallResult {
  const home = opts.home ?? os.homedir();
  const source = fs.realpathSync(opts.source ?? CLAUDE_SKILL_SOURCE);
  const skillsDir = path.join(home, ".claude", "skills");
  const target = path.join(skillsDir, "pi-orchestrator");
  fs.mkdirSync(skillsDir, { recursive: true });

  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      let resolved: string | null = null;
      try {
        resolved = fs.realpathSync(target);
      } catch {
        resolved = null;
      }
      if (resolved === source) return { status: "exists", target, source };
    }
    throw new Error(`refusing to overwrite ${target}: it exists and is not a pi-fleet symlink — remove it first`);
  }
  fs.symlinkSync(source, target, "dir");
  return { status: "created", target, source };
}

export async function cmdInstallClaudeSkill(): Promise<number> {
  const r = installClaudeSkill();
  console.log(`${r.status === "created" ? "linked" : "already linked"} ${r.target} -> ${r.source}`);
  console.log("Claude Code picks up the pi-orchestrator skill in new sessions.");
  return 0;
}
