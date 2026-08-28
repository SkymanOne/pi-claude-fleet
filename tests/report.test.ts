import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRun } from "../src/spawn.js";
import { saveState } from "../src/state.js";
import { buildSteeringAppendix, readReport, reportPath } from "../src/report.js";
import { runCli, tmpDir } from "./helpers.js";

async function fixtureRun(prefix: string) {
  const dir = tmpDir(prefix); // not a git repo → in-place run, no monitor launched
  const { runId, runDir, piFleetDir, state } = await createRun({
    name: "auth", opts: { cwd: dir, worktree: false }, brief: "b",
  });
  return { dir, runId, runDir, piFleetDir, state };
}

test("buildSteeringAppendix: empty without steering, one line per entry otherwise", () => {
  assert.equal(buildSteeringAppendix({ steerCount: 0, steeringLog: [] }), "");
  const appendix = buildSteeringAppendix({
    steerCount: 2,
    steeringLog: [
      { source: "orchestrator", ts: "t1", message: "first" },
      { source: "console", ts: "t2", message: "second" },
    ],
  });
  assert.match(appendix, /^\n---\n## Steering log \(orchestrator-side, most recent last\)\n/);
  assert.match(appendix, /- \[orchestrator\] t1 first\n- \[console\] t2 second\n$/);
});

test("readReport: report file wins; fallback uses lastAssistantText; otherwise missing", async () => {
  const f = await fixtureRun("pf-rep-1-");
  fs.writeFileSync(reportPath(f.piFleetDir, f.runId), "# Fleet Report\n## Status\ndone\n");
  const fromFile = readReport(f.piFleetDir, f.state);
  assert.equal(fromFile.kind, "report");
  assert.match(fromFile.text ?? "", /## Status/);

  fs.unlinkSync(reportPath(f.piFleetDir, f.runId));
  f.state.lastAssistantText = "some final text";
  const fallback = readReport(f.piFleetDir, f.state);
  assert.equal(fallback.kind, "fallback");
  assert.match(fallback.text ?? "", /falling back to last assistant text\]\n\nsome final text$/);

  f.state.lastAssistantText = null;
  assert.deepEqual(readReport(f.piFleetDir, f.state), { kind: "missing", text: null });
});

test("CLI report: prints report + steering appendix; exit 2 when nothing exists", async () => {
  const f = await fixtureRun("pf-rep-2-");
  fs.writeFileSync(reportPath(f.piFleetDir, f.runId), "## Status\ndone\n");
  f.state.steerCount = 1;
  f.state.steeringLog = [{ source: "console", ts: "t", message: "use tabs" }];
  await saveState(f.runDir, f.state);

  const out = await runCli(["report", "auth", "--cwd", f.dir]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^## Status\ndone\n/);
  assert.match(out.stdout, /## Steering log.*\n- \[console\] t use tabs/);

  fs.unlinkSync(reportPath(f.piFleetDir, f.runId));
  const missing = await runCli(["report", "auth", "--cwd", f.dir]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no report file and no captured output/);
});
