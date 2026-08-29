/**
 * The fleet as an MCP server: one tool per command core. Text-first results
 * (the CLI's stdout/stderr lines plus a trailing `exit: N`), `isError` when the
 * exit code is non-zero, and structured content where a caller benefits.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  spawnCore,
  statusCore,
  waitCore,
  outputCore,
  logsCore,
  sendCore,
  followupCore,
  answerCore,
  stopCore,
  reportCore,
  diffCore,
  mergeCore,
  cleanupCore,
  type CommandResult,
  type ControlSource,
} from "../commands.js";

export interface FleetServerOptions {
  /** Target directory (the repo being orchestrated); the fleet dir is derived from it. */
  cwd: string;
  /** Provenance recorded on control messages sent through these tools. */
  source?: ControlSource;
  version?: string;
}

export const FLEET_TOOL_NAMES = [
  "fleet_spawn",
  "fleet_status",
  "fleet_wait",
  "fleet_output",
  "fleet_logs",
  "fleet_send",
  "fleet_followup",
  "fleet_answer",
  "fleet_stop",
  "fleet_report",
  "fleet_diff",
  "fleet_merge",
  "fleet_cleanup",
] as const;

export type FleetToolName = (typeof FLEET_TOOL_NAMES)[number];

/** Render a core result for the model; the exit code rides along as the last line. */
export function toToolResult(r: CommandResult<unknown>, structured?: Record<string, unknown>): CallToolResult {
  const text = [...r.out, ...r.err, `exit: ${r.code}`].join("\n");
  const result: CallToolResult = { content: [{ type: "text", text }], isError: r.code !== 0 };
  if (structured) result.structuredContent = structured;
  return result;
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `${message}\nexit: 1` }], isError: true };
}

const name = z.string().min(1).describe("Run name (the newest non-archived run of that name) or a full run id");

export function createFleetServer(opts: FleetServerOptions): McpServer {
  const cwd = opts.cwd;
  const source: ControlSource = opts.source ?? "orchestrator";
  const server = new McpServer({ name: "fleet", version: opts.version ?? "0.1.0" });

  const guard = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (err) {
      return errorResult(err);
    }
  };

  server.registerTool(
    "fleet_spawn",
    {
      title: "Spawn a pi worker",
      description:
        "Start a headless pi worker on a task brief. By default it works on its own git worktree and branch; " +
        "set worktree=false for read-only steps (research, review). The brief must be self-contained: the worker " +
        "sees nothing else. Returns the run id; fleet events arrive as the run progresses. exit 0 on success.",
      inputSchema: {
        name: z.string().min(1).describe("Short kebab-case run name, e.g. add-auth"),
        brief: z.string().min(1).describe("The complete task brief for the worker"),
        model: z.string().optional().describe("pi model pattern"),
        provider: z.string().optional().describe("pi provider"),
        thinking: z.string().optional().describe("pi thinking level"),
        worktree: z.boolean().optional().describe("Isolate in a git worktree (default true)"),
        base: z.string().optional().describe("Base ref for the worker branch (default HEAD)"),
        skill: z.string().optional().describe("Extra pi skill file or directory"),
        appendSystemPrompt: z.string().optional().describe("Text appended to the pi system prompt"),
        session: z.string().optional().describe("pi session file or id to resume (from a previous run's refusal/resume hint)"),
        tools: z.string().optional().describe("pi tool allowlist (comma-separated)"),
        excludeTools: z.string().optional().describe("pi tool denylist (comma-separated)"),
      },
      outputSchema: {
        runId: z.string(),
        runDir: z.string(),
        piFleetDir: z.string(),
        worktree: z.string().nullable(),
        branch: z.string().nullable(),
      },
    },
    async (args) =>
      guard(async () => {
        const r = await spawnCore({
          name: args.name,
          brief: args.brief,
          opts: {
            cwd,
            model: args.model,
            provider: args.provider,
            thinking: args.thinking,
            worktree: args.worktree ?? true,
            base: args.base,
            skill: args.skill,
            appendSystemPrompt: args.appendSystemPrompt,
            session: args.session,
            tools: args.tools,
            excludeTools: args.excludeTools,
          },
        });
        return toToolResult(r, { ...r.data });
      }),
  );

  server.registerTool(
    "fleet_status",
    {
      title: "Fleet status",
      description:
        "The fleet table (name, state, last activity, last tool, steer count, age), or one run's full state with name. " +
        "States: starting, running, blocked (waiting on fleet_answer), settled, stopped, error, dead, archived. " +
        "Events are pushed to you as they happen; do not poll this in a loop.",
      inputSchema: {
        name: z.string().optional().describe("Run name for the full state of one run"),
        all: z.boolean().optional().describe("Include archived runs"),
      },
      outputSchema: { runs: z.array(z.record(z.string(), z.unknown())) },
    },
    async (args) =>
      guard(async () => {
        const r = await statusCore({ name: args.name, cwd, all: args.all, json: false });
        return toToolResult(r, { runs: r.data.runs });
      }),
  );

  server.registerTool(
    "fleet_wait",
    {
      title: "Wait for a run",
      description:
        "Block until the run reaches a terminal state or the timeout passes. exit 0 settled, 3 timed out (still running), " +
        "4 stopped/error/dead. Use only when you have nothing else to do; fleet events are pushed to you anyway.",
      inputSchema: {
        name,
        timeoutSec: z.number().int().min(1).max(600).optional().describe("Seconds to wait (default 120, max 600)"),
      },
    },
    async (args) =>
      guard(async () => toToolResult(await waitCore({ name: args.name, cwd, timeout: String(args.timeoutSec ?? 120) }))),
  );

  server.registerTool(
    "fleet_output",
    {
      title: "Worker output",
      description: "The worker's last assistant text, or with tail=N the last N tool results (an activity trail).",
      inputSchema: { name, tail: z.number().int().min(1).optional().describe("Print the last N tool results instead") },
    },
    async (args) =>
      guard(async () =>
        toToolResult(await outputCore({ name: args.name, cwd, tail: args.tail === undefined ? undefined : String(args.tail) })),
      ),
  );

  server.registerTool(
    "fleet_logs",
    {
      title: "Worker RPC log",
      description: "The tail of the worker's raw pi RPC log; use it to diagnose error or dead runs.",
      inputSchema: { name, tail: z.number().int().min(1).optional().describe("Lines to print (default 50)") },
    },
    async (args) =>
      guard(async () =>
        toToolResult(await logsCore({ name: args.name, cwd, tail: args.tail === undefined ? undefined : String(args.tail) })),
      ),
  );

  server.registerTool(
    "fleet_send",
    {
      title: "Steer a worker",
      description:
        "Send a steering message to a running worker; delivered after its current tool calls. exit 1 if the run is finished " +
        "(the message then includes the resume command).",
      inputSchema: { name, message: z.string().min(1) },
    },
    async (args) => guard(async () => toToolResult(await sendCore({ name: args.name, cwd, message: args.message, source }))),
  );

  server.registerTool(
    "fleet_followup",
    {
      title: "Queue a follow-up",
      description: "Queue a message for after the worker finishes its current work. exit 1 if the run is finished.",
      inputSchema: { name, message: z.string().min(1) },
    },
    async (args) =>
      guard(async () => toToolResult(await followupCore({ name: args.name, cwd, message: args.message, source }))),
  );

  server.registerTool(
    "fleet_answer",
    {
      title: "Answer a worker question",
      description:
        "Answer the question a worker asked through fleet_ask (it is blocked until answered). Targets the run's pending " +
        "question unless questionId is given. exit 1 when nothing is pending.",
      inputSchema: {
        name,
        answer: z.string().min(1),
        questionId: z.string().optional().describe("Question id from the fleet event (default: the pending one)"),
      },
    },
    async (args) =>
      guard(async () =>
        toToolResult(await answerCore({ name: args.name, cwd, message: args.answer, questionId: args.questionId ?? null, source })),
      ),
  );

  server.registerTool(
    "fleet_stop",
    {
      title: "Stop a worker",
      description: "Abort a running worker; its state becomes stopped. exit 1 if it already finished.",
      inputSchema: { name },
    },
    async (args) => guard(async () => toToolResult(await stopCore({ name: args.name, cwd, source }))),
  );

  server.registerTool(
    "fleet_report",
    {
      title: "Worker report",
      description:
        "The worker's final fleet report (Status, Summary, What I did, Files changed, Verification, Decisions, " +
        "Steering received, Open questions, Suggested next step) plus the steering log. Falls back to the last " +
        "assistant text; exit 2 when there is neither.",
      inputSchema: { name },
    },
    async (args) => guard(async () => toToolResult(await reportCore({ name: args.name, cwd }))),
  );

  server.registerTool(
    "fleet_diff",
    {
      title: "Worker diff",
      description: "What the worker committed on its branch versus the commit it started from (git diff --stat, or names only).",
      inputSchema: { name, nameOnly: z.boolean().optional() },
    },
    async (args) => guard(async () => toToolResult(await diffCore({ name: args.name, cwd, nameOnly: args.nameOnly }))),
  );

  server.registerTool(
    "fleet_merge",
    {
      title: "Merge a worker branch",
      description:
        "Merge a settled worker's branch into the repository checkout. exit 5 on conflicts: the merge is aborted and the " +
        "checkout left clean; have the worker rebase in its worktree and merge again. Run the project's integration checks after merging.",
      inputSchema: { name, noCommit: z.boolean().optional().describe("Stage the merge without committing") },
    },
    async (args) =>
      guard(async () => toToolResult(await mergeCore({ name: args.name, cwd, noCommit: args.noCommit, abortOnConflict: true }))),
  );

  server.registerTool(
    "fleet_cleanup",
    {
      title: "Clean up runs",
      description:
        "Remove a finished run's worktree and branch and archive it (reports and events are kept). target is a run name or " +
        "'all'. force aborts running workers and discards unmerged branches and uncommitted changes.",
      inputSchema: { target: z.string().min(1), force: z.boolean().optional() },
    },
    async (args) => guard(async () => toToolResult(await cleanupCore({ target: args.target, cwd, force: args.force }))),
  );

  return server;
}
