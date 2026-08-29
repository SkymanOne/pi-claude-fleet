#!/usr/bin/env node
import { Command, CommanderError, type OptionValues } from "commander";
import { BIN_NAME } from "./paths.js";
import {
  cmdSpawn,
  cmdStatus,
  cmdWait,
  cmdOutput,
  cmdLogs,
  cmdSend,
  cmdFollowup,
  cmdAnswer,
  cmdStop,
  cmdReport,
  cmdDiff,
  cmdMerge,
  cmdCleanup,
  printResult,
  type SpawnOpts,
} from "./commands.js";

let exitCode = 0;
const done = (n: number): void => {
  exitCode = n;
};

const program = new Command();
program
  .name("pi-fleet")
  .description(
    "A fleet of headless pi workers orchestrated by Claude Code: run `pi-fleet` for the TUI, or drive workers with the subcommands.",
  );

const cwdOption = [
  "--cwd <dir>",
  "target directory (default: current)",
] as const;

program
  .command("spawn <name> [brief...]")
  .description(
    "start a headless pi worker (git worktree by default; --no-worktree for read-only tasks)",
  )
  .option(...cwdOption)
  .option("--model <pattern>", "pi model pattern")
  .option("--provider <name>", "pi provider")
  .option("--thinking <level>", "thinking level")
  .option("--no-worktree", "run in place without a git worktree")
  .option("--base <ref>", "base ref for the worker branch (default: HEAD)")
  .option("--skill <path>", "load an extra pi skill file or directory")
  .option("--append-system-prompt <text>", "append to the pi system prompt")
  .option("--session <path|id>", "resume a previous pi session")
  .option("--tools <list>", "pi tool allowlist")
  .option("--exclude-tools <list>", "pi tool denylist")
  .action(async (name: string, briefArgs: string[], options: OptionValues) => {
    done(
      await cmdSpawn({
        name,
        brief: briefArgs.join(" "),
        opts: options as unknown as SpawnOpts,
      }),
    );
  });

program
  .command("status [name]")
  .description("fleet table, or one run's full state as JSON")
  .option(...cwdOption)
  .option("--json", "machine-readable output")
  .option("--all", "include archived runs")
  .action(async (name: string | undefined, options: OptionValues) =>
    done(await cmdStatus({ name, cwd: options.cwd, json: options.json, all: options.all })),
  );

program
  .command("wait <name>")
  .description("block until the run settles (exit 0), times out (3), or ends stopped/error/dead (4)")
  .option(...cwdOption)
  .option("--timeout <sec>", "seconds to wait (default 600)")
  .action(async (name: string, options: OptionValues) =>
    done(await cmdWait({ name, cwd: options.cwd, timeout: options.timeout })),
  );

program
  .command("output <name>")
  .description("last assistant text, or the last n tool results with --tail")
  .option(...cwdOption)
  .option("--tail <n>", "print the last n tool results instead")
  .action(async (name: string, options: OptionValues) =>
    done(await cmdOutput({ name, cwd: options.cwd, tail: options.tail })),
  );

program
  .command("logs <name>")
  .description("tail the captured raw RPC stream")
  .option(...cwdOption)
  .option("--tail <n>", "lines to print (default 50)")
  .action(async (name: string, options: OptionValues) =>
    done(await cmdLogs({ name, cwd: options.cwd, tail: options.tail })),
  );

program
  .command("send <name> [message...]")
  .description("steer a running worker (delivered after its current tool calls)")
  .option(...cwdOption)
  .action(async (name: string, messageArgs: string[], options: OptionValues) =>
    done(await cmdSend({ name, cwd: options.cwd, message: messageArgs.join(" ") })),
  );

program
  .command("followup <name> [message...]")
  .description("queue a message for after the worker finishes its current work")
  .option(...cwdOption)
  .action(async (name: string, messageArgs: string[], options: OptionValues) =>
    done(await cmdFollowup({ name, cwd: options.cwd, message: messageArgs.join(" ") })),
  );

program
  .command("answer <name> [message...]")
  .description("answer the worker's pending fleet_ask question (default: the question it is blocked on)")
  .option(...cwdOption)
  .option("--question <id>", "question id to answer")
  .action(async (name: string, messageArgs: string[], options: OptionValues) =>
    done(await cmdAnswer({ name, cwd: options.cwd, questionId: options.question, message: messageArgs.join(" ") })),
  );

program
  .command("stop <name>")
  .description("abort a running worker (state becomes stopped)")
  .option(...cwdOption)
  .action(async (name: string, options: OptionValues) =>
    done(await cmdStop({ name, cwd: options.cwd })),
  );

program
  .command("report <name>")
  .description("the worker's final report (or last assistant text) plus the steering log; exit 2 if none")
  .option(...cwdOption)
  .action(async (name: string, options: OptionValues) =>
    done(await cmdReport({ name, cwd: options.cwd })),
  );

program
  .command("diff <name>")
  .description("the worker's changes vs its base commit (git diff --stat, or --name-only)")
  .option(...cwdOption)
  .option("--name-only", "list changed files only")
  .action(async (name: string, options: OptionValues) =>
    done(await cmdDiff({ name, cwd: options.cwd, nameOnly: options.nameOnly })),
  );

program
  .command("merge <name>")
  .description("merge the settled worker's branch into the current checkout (exit 5 on conflicts)")
  .option(...cwdOption)
  .option("--no-commit", "stage the merge without committing (--no-commit --no-ff)")
  .action(async (name: string, options: OptionValues) =>
    done(await cmdMerge({ name, cwd: options.cwd, noCommit: options.commit === false })),
  );

program
  .command("cleanup <target>")
  .description("remove a run's worktree + branch and archive it (<name> or all; --force aborts running workers)")
  .option(...cwdOption)
  .option("--force", "abort running workers and delete unmerged branches")
  .action(async (target: string, options: OptionValues) =>
    done(await cmdCleanup({ target, cwd: options.cwd, force: options.force })),
  );

program
  .command("attach <name>")
  .description("print the tail of one worker's transcript (the live console is `pi-fleet`)")
  .option(...cwdOption)
  .option("--tail <n>", "lines to print (default 40)")
  .action(async (name: string, options: OptionValues) => {
    const { attachCore } = await import("./console/attach.js");
    done(printResult(await attachCore({ name, cwd: options.cwd, tail: options.tail })));
  });

const tuiOptions = (cmd: Command): Command =>
  cmd
    .option(...cwdOption)
    .option("--model <model>", "model for the orchestrator (claude model alias or id)")
    .option("--fresh", "start a new orchestrator session instead of resuming the saved one")
    .option("--budget <usd>", "stop the orchestrator after this much spend")
    .option("--progress-events", "forward worker progress notes to the orchestrator")
    .option(
      "--permission-mode <mode>",
      "how the orchestrator's tool use is approved: default, auto, acceptEdits, dontAsk, plan",
    )
    .option("--remote-control [name]", "put the orchestrator on Claude Code Remote Control");

const runTui = async (rest: string[], options: OptionValues): Promise<void> => {
  // `tui` is the default command, so an unrecognized subcommand lands here as an operand.
  if (rest.length > 0) {
    console.error(`error: unknown command '${rest[0]}'\nRun \`${BIN_NAME} --help\` for the command list.`);
    done(1);
    return;
  }
  const { cmdTui } = await import("./tui/index.js");
  done(
    await cmdTui({
      cwd: options.cwd,
      model: options.model,
      fresh: options.fresh,
      budget: options.budget,
      progressEvents: options.progressEvents,
      permissionMode: options.permissionMode,
      remoteControl: options.remoteControl === true ? "" : options.remoteControl,
    }),
  );
};

tuiOptions(
  program
    .command("tui", { isDefault: true })
    .description("open the fleet console (default)")
    .argument("[unknown...]"),
).action(runTui);

program
  .command("mcp")
  .description("serve the fleet tools over stdio as an MCP server (the TUI's orchestrator uses this)")
  .option(...cwdOption)
  .action(async (options: OptionValues) => {
    const { runFleetMcp } = await import("./mcp/stdio.js");
    done(await runFleetMcp({ cwd: options.cwd }));
  });

program
  .command("__orchestrator <piFleetDir>", { hidden: true })
  .option(...cwdOption)
  .option("--model <model>", "model for the orchestrator")
  .option("--budget <usd>", "stop after this much spend")
  .option("--fresh", "start a new claude session")
  .option("--permission-mode <mode>", "starting permission mode")
  .option("--remote-control [name]", "register with Claude Code Remote Control")
  .action(async (piFleetDir: string, options: OptionValues) => {
    const { runOrchestratorMonitor } = await import("./orchestrator/monitor.js");
    done(
      await runOrchestratorMonitor({
        piFleetDir,
        cwd: options.cwd ?? process.cwd(),
        model: options.model ?? null,
        budget: options.budget ? Number(options.budget) : null,
        fresh: Boolean(options.fresh),
        permissionMode: options.permissionMode ?? null,
        remoteControl: options.remoteControl === true ? "" : (options.remoteControl ?? null),
      }),
    );
  });

program
  .command("__monitor <piFleetDir> <runId>", { hidden: true })
  .action(async (piFleetDir: string, runId: string) => {
    const { runMonitor } = await import("./monitor.js");
    done(await runMonitor({ piFleetDir, runId }));
  });

program
  .parseAsync(process.argv)
  .then(() => {
    process.exitCode = exitCode;
  })
  .catch((err: unknown) => {
    if (!(err instanceof CommanderError)) {
      console.error(
        `pi-fleet: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.exitCode = err instanceof CommanderError ? err.exitCode : 1;
  });
