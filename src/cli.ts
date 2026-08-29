#!/usr/bin/env node
import { Command, CommanderError, type OptionValues } from "commander";
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
  type SpawnOpts,
} from "./commands.js";
import { cmdOpen, cmdAttach } from "./console/index.js";
import { cmdInstallClaudeSkill } from "./install.js";

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
  .command("open")
  .description("interactive run menu → attach to a worker")
  .option(...cwdOption)
  .action(async (options: OptionValues) => done(await cmdOpen({ cwd: options.cwd })));

program
  .command("attach <name>")
  .description("live view + steering console for one worker (non-TTY: prints the captured tail)")
  .option(...cwdOption)
  .action(async (name: string, options: OptionValues) => done(await cmdAttach({ name, cwd: options.cwd })));

program
  .command("install-claude-skill")
  .description("symlink the pi-orchestrator skill into ~/.claude/skills")
  .action(async () => done(await cmdInstallClaudeSkill()));

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
