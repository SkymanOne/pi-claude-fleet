#!/usr/bin/env node
import { Command, CommanderError, type OptionValues } from "commander";
import { cmdSpawn, type SpawnOpts } from "./commands.js";

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
