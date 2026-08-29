import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFleetServer, FLEET_TOOL_NAMES, toToolResult } from "../src/mcp/server.js";
import { ok, fail } from "../src/commands.js";
import { initRepo, fakePiEnv, FAKE_PI, tmpDir } from "./helpers.js";

/** The in-process server spawns monitors with process.env, so the fake pi knobs must be set there. */
function useFakePi(over: Record<string, string> = {}): () => void {
  const keys = ["PI_FLEET_DEV", "PI_FLEET_PI_BIN", "FAKE_PI_DELAY_MS", "FAKE_PI_WRITE_HELLO", "FAKE_PI_ASK"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const env = fakePiEnv(over);
  for (const k of keys) {
    if (env[k] !== undefined) process.env[k] = env[k];
    else delete process.env[k];
  }
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

async function connect(cwd: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createFleetServer({ cwd });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (r: any): string => r.content.map((c: any) => c.text ?? "").join("\n");

test("toToolResult renders lines plus the exit code and flags errors", () => {
  const good = toToolResult(ok({ x: 1 }, ["a"], ["warn"]), { x: 1 });
  assert.deepEqual(good, { content: [{ type: "text", text: "a\nwarn\nexit: 0" }], isError: false, structuredContent: { x: 1 } });
  const bad = toToolResult(fail(5, "boom"));
  assert.equal(bad.isError, true);
  assert.equal(textOf(bad), "boom\nexit: 5");
});

test("lists exactly the fleet tools", async () => {
  const { client, close } = await connect(tmpDir("pf-mcp-list-"));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...FLEET_TOOL_NAMES].sort());
    const spawn = tools.find((t) => t.name === "fleet_spawn")!;
    assert.deepEqual((spawn.inputSchema as any).required, ["name", "brief"]);
    assert.ok(spawn.outputSchema, "fleet_spawn declares structured output");
    assert.equal(tools.find((t) => t.name === "fleet_send")!.outputSchema, undefined);
  } finally {
    await close();
  }
});

test("spawn → wait → report → status → answer/send refusals → cleanup, over fake pi", async () => {
  const restore = useFakePi({ FAKE_PI_DELAY_MS: "200" });
  const root = initRepo("pf-mcp-flow-");
  const { client, close } = await connect(root);
  try {
    const spawned: any = await client.callTool({ name: "fleet_spawn", arguments: { name: "hello", brief: "write hello.txt", worktree: false } });
    assert.equal(spawned.isError, false, textOf(spawned));
    assert.match(spawned.structuredContent.runId, /^hello-\d{14}$/);
    assert.equal(spawned.structuredContent.worktree, null);
    assert.match(textOf(spawned), /Spawned hello-/);
    assert.match(textOf(spawned), /exit: 0$/);

    const waited: any = await client.callTool({ name: "fleet_wait", arguments: { name: "hello", timeoutSec: 30 } });
    assert.equal(waited.isError, false, textOf(waited));
    assert.equal(textOf(waited), "hello settled\nexit: 0");

    const report: any = await client.callTool({ name: "fleet_report", arguments: { name: "hello" } });
    assert.equal(report.isError, false);
    assert.match(textOf(report), /## Status\ndone/);

    const status: any = await client.callTool({ name: "fleet_status", arguments: {} });
    assert.equal(status.structuredContent.runs.length, 1);
    assert.equal(status.structuredContent.runs[0].name, "hello");
    assert.equal(status.structuredContent.runs[0].status, "settled");
    assert.match(textOf(status), /hello.*settled/);
    const one: any = await client.callTool({ name: "fleet_status", arguments: { name: "hello" } });
    assert.equal(one.structuredContent.runs[0].taskBrief, "write hello.txt");

    const output: any = await client.callTool({ name: "fleet_output", arguments: { name: "hello", tail: 3 } });
    assert.match(textOf(output), /^bash: hi/);
    const logs: any = await client.callTool({ name: "fleet_logs", arguments: { name: "hello", tail: 2 } });
    assert.match(textOf(logs), /agent_settled/);

    const answer: any = await client.callTool({ name: "fleet_answer", arguments: { name: "hello", answer: "x" } });
    assert.equal(answer.isError, true);
    assert.match(textOf(answer), /nothing is waiting for an answer[\s\S]*exit: 1$/);
    const send: any = await client.callTool({ name: "fleet_send", arguments: { name: "hello", message: "again" } });
    assert.equal(send.isError, true);
    assert.match(textOf(send), /steering refused/);
    const merge: any = await client.callTool({ name: "fleet_merge", arguments: { name: "hello" } });
    assert.equal(merge.isError, true);
    assert.match(textOf(merge), /has no branch/);
    const missing: any = await client.callTool({ name: "fleet_report", arguments: { name: "nope" } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /No run found matching "nope"/);

    const cleanup: any = await client.callTool({ name: "fleet_cleanup", arguments: { target: "hello" } });
    assert.equal(cleanup.isError, false, textOf(cleanup));
    assert.match(textOf(cleanup), /^archived hello-/);
  } finally {
    await close();
    restore();
  }
}, { timeout: 60_000 });

test("fleet_merge aborts on conflict and leaves the checkout clean with rebase guidance", async () => {
  const restore = useFakePi({ FAKE_PI_DELAY_MS: "100", FAKE_PI_WRITE_HELLO: "1" });
  const root = initRepo("pf-mcp-merge-");
  const { client, close } = await connect(root);
  try {
    const spawned: any = await client.callTool({ name: "fleet_spawn", arguments: { name: "hello", brief: "write hello.txt" } });
    assert.equal(spawned.isError, false, textOf(spawned));
    assert.ok(spawned.structuredContent.branch, "worktree run has a branch");
    const waited: any = await client.callTool({ name: "fleet_wait", arguments: { name: "hello", timeoutSec: 30 } });
    assert.equal(waited.isError, false, textOf(waited));
    // conflicting change on the main checkout
    fs.writeFileSync(path.join(root, "hello.txt"), "different\n");
    execFileSync("git", ["add", "hello.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "conflict"], { cwd: root });

    const merge: any = await client.callTool({ name: "fleet_merge", arguments: { name: "hello" } });
    assert.equal(merge.isError, true);
    const text = textOf(merge);
    assert.match(text, /conflicts in:\nhello\.txt/);
    assert.match(text, /merge was aborted; the checkout is clean/);
    assert.match(text, /rebase its branch pi-fleet\/hello-/);
    assert.match(text, /exit: 5$/);
    // spawn adds an untracked .gitignore; nothing else may be dirty or conflicted
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().split("\n").filter((l) => l && l !== "?? .gitignore");
    assert.deepEqual(porcelain, []);
    assert.equal(fs.existsSync(path.join(root, ".git", "MERGE_HEAD")), false);
    assert.equal(fs.readFileSync(path.join(root, "hello.txt"), "utf8"), "different\n");
    const cleanup: any = await client.callTool({ name: "fleet_cleanup", arguments: { target: "hello", force: true } });
    assert.equal(cleanup.isError, false, textOf(cleanup));
  } finally {
    await close();
    restore();
  }
}, { timeout: 60_000 });

test("fake pi fixture path is what the server's workers run", () => {
  assert.ok(fs.existsSync(FAKE_PI));
});
