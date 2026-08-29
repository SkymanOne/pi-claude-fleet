import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderOrchestratorPrompt, writeRenderedPrompt, renderedPromptPath, DEFAULT_MAX_WORKERS } from "../src/orchestrator/prompt.js";
import { ORCHESTRATOR_PROMPT_PATH, BIN_NAME } from "../src/paths.js";
import { FLEET_TOOL_NAMES } from "../src/mcp/server.js";
import { tmpDir } from "./helpers.js";

test("the shipped template renders every placeholder and names every fleet tool and event kind", () => {
  assert.ok(fs.existsSync(ORCHESTRATOR_PROMPT_PATH));
  const text = renderOrchestratorPrompt({ fleetDir: "/repo/.pi-fleet", repoRoot: "/repo" });
  assert.equal(/\{\{[A-Z_]+\}\}/.test(text), false, "no unrendered placeholders");
  assert.match(text, /`\/repo\/\.pi-fleet`/);
  assert.match(text, /`\/repo`/);
  assert.match(text, new RegExp(`At most ${DEFAULT_MAX_WORKERS} workers`));
  assert.match(text, new RegExp(`\`${BIN_NAME}\``));
  for (const tool of FLEET_TOOL_NAMES) assert.ok(text.includes(`\`${tool}\``), `mentions ${tool}`);
  assert.match(text, /<fleet-event kind="settled"/);
  for (const kind of ["settled", "stopped", "error", "dead", "question", "answered_by_console", "question_resolved", "console_steer", "progress", "snapshot"]) {
    assert.ok(text.includes(`\`${kind}\``), `explains event kind ${kind}`);
  }
  assert.match(text, /Never merge a run that is not `settled`/);
  assert.match(text, /Never edit files yourself/);
  assert.match(text, /AskUserQuestion/);
  assert.match(text, /exit 5/);
});

test("renderOrchestratorPrompt honors overrides and leaves unknown placeholders alone", () => {
  const text = renderOrchestratorPrompt({ fleetDir: "/f", repoRoot: "/r", maxWorkers: 5, binName: "fleetx" }, "{{BIN_NAME}} {{MAX_WORKERS}} {{FLEET_DIR}} {{REPO_ROOT}} {{UNKNOWN}}");
  assert.equal(text, "fleetx 5 /f /r {{UNKNOWN}}");
});

test("writeRenderedPrompt writes into the fleet dir", () => {
  const fleetDir = path.join(tmpDir("pf-prompt-"), ".pi-fleet");
  const p = writeRenderedPrompt(fleetDir, { fleetDir, repoRoot: path.dirname(fleetDir) });
  assert.equal(p, renderedPromptPath(fleetDir));
  assert.match(fs.readFileSync(p, "utf8"), /# Fleet orchestrator/);
});
