#!/usr/bin/env node
import { Command, CommanderError, type OptionValues } from "commander";
import {
  cmdSpawn,
  cmdStatus,
  cmdWait,
  cmdOutput,
  cmdLogs,
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
    "Claude Code ↔ pi fleet orchestration: spawn headless pi workers, monitor, steer, collect reports, merge.",
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
