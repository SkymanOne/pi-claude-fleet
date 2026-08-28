import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installClaudeSkill } from "../src/install.js";
import { CLAUDE_SKILL_SOURCE } from "../src/paths.js";
import { runCli, fakePiEnv, tmpDir } from "./helpers.js";

test("installClaudeSkill: creates symlink, is idempotent, refuses foreign paths", () => {
  const home = tmpDir("pf-home-");
  const first = installClaudeSkill({ home });
  assert.equal(first.status, "created");
  const target = path.join(home, ".claude", "skills", "pi-orchestrator");
  assert.equal(first.target, target);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(target), fs.realpathSync(CLAUDE_SKILL_SOURCE));
  assert.equal(fs.existsSync(path.join(target, "SKILL.md")), true);
  assert.equal(installClaudeSkill({ home }).status, "exists");

  const home2 = tmpDir("pf-home-");
  fs.mkdirSync(path.join(home2, ".claude", "skills", "pi-orchestrator"), { recursive: true });
  assert.throws(() => installClaudeSkill({ home: home2 }), /refusing to overwrite/);
});

test("CLI install-claude-skill honours $HOME and prints the link", async () => {
  const home = tmpDir("pf-home-");
  const r = await runCli(["install-claude-skill"], { env: fakePiEnv({ HOME: home }) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /linked .*pi-orchestrator -> /);
  assert.equal(fs.lstatSync(path.join(home, ".claude", "skills", "pi-orchestrator")).isSymbolicLink(), true);
});

test("skill files exist with frontmatter and a CLI reference", () => {
  const skill = fs.readFileSync(path.join(CLAUDE_SKILL_SOURCE, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: pi-orchestrator\ndescription: .+\n---/);
  assert.match(skill, /pi-fleet spawn/);
  assert.match(skill, /pi-fleet report/);
  assert.match(skill, /3 concurrent/);
  const ref = fs.readFileSync(path.join(CLAUDE_SKILL_SOURCE, "references", "cli.md"), "utf8");
  assert.match(ref, /5 conflicts/);
  assert.match(ref, /steeringLog/);
});
