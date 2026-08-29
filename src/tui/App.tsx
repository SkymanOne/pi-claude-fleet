import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { OrchestratorClient } from "../orchestrator/client.js";
import type { PendingRequestRecord } from "../orchestrator/records.js";
import type { FleetWatcher } from "../fleet/watcher.js";
import { formatFleetBatch, type FleetEvent } from "../fleet/events.js";
import {
  deriveStatus,
  deriveView,
  modelLabel,
  TERMINAL_STATES,
  type RunState,
} from "../state.js";
import { Rail } from "./Rail.js";
import { Transcript } from "./Transcript.js";
import { WorkerTranscript } from "./WorkerTranscript.js";
import { StatusLine } from "./StatusLine.js";
import { Composer } from "./Composer.js";
import { Suggestions } from "./Suggestions.js";
import { Approval } from "./Approval.js";
import { Confirm } from "./Confirm.js";
import { helpText, HINT } from "./keys.js";
import { transcriptRows, CHROME_BASE } from "./layout.js";
import { formatAge } from "../util.js";
import {
  completionsFor,
  applySuggestion,
  listRepoFiles,
  resolveCommand,
  SHORTCUTS,
  type CompletionState,
} from "./completions.js";
import {
  workerCommand,
  removeWorker,
  stopAllWorkers,
} from "./workerActions.js";
import { reapMergedRuns } from "../fleet/reap.js";
import {
  activityLine,
  buildRail,
  initialViewState,
  reduceOrchestrator,
  workerActivity,
  type LocalEvent,
  type OrchestratorViewState,
  type RailRun,
} from "./model.js";
import type { ClaudeStreamMessage } from "../orchestrator/protocol.js";

export interface AppProps {
  /** The console's handle on the detached orchestrator; it does not own that process. */
  client: OrchestratorClient;
  watcher: FleetWatcher;
  /** `shutdown` means the fleet was stopped too, not just this console closed. */
  onQuit: (reason?: "quit" | "shutdown") => void;
  /** Poll interval for the rail (the watcher has its own). */
  railPollMs?: number;
  /** How often to archive settled workers whose branch is already merged; 0 disables it. */
  reapMs?: number;
  /** Repository root, for `@` file completion. */
  cwd?: string;
}

type Dispatchable = ClaudeStreamMessage | LocalEvent;

const TERMINAL_VIEWS: string[] = [...TERMINAL_STATES];
/** What claude's own /effort accepts. */
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** reduceOrchestrator mutates; spreading gives React a new reference to render. */
const reducer = (
  state: OrchestratorViewState,
  msg: Dispatchable,
): OrchestratorViewState => ({ ...reduceOrchestrator(state, msg) });

export function App({
  client,
  watcher,
  onQuit,
  railPollMs = 500,
  reapMs = 15_000,
  cwd,
}: AppProps) {
  const [view, dispatch] = useReducer(reducer, undefined, initialViewState);
  const [runs, setRuns] = useState<RailRun[]>(() => watcher.runs());
  const [selected, setSelected] = useState(0);
  const [approvals, setApprovals] = useState<PendingRequestRecord[]>([]);
  const [, setStateTick] = useState(0);
  const [input, setInput] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [confirm, setConfirm] = useState<{
    message: string;
    action: "remove" | "shutdown";
    run?: RailRun;
  } | null>(null);
  /** The reasoning level asked of the orchestrator, since claude does not report one. */
  const [effort, setEffort] = useState<string | null>(null);
  // The last notice, shown above the composer: worker actions happen while a
  // worker pane is selected, so the orchestrator transcript alone would hide them.
  const [flash, setFlash] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [completionIndex, setCompletionIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  // Sent messages, newest last, per session; -1 means "not browsing".
  const historyRef = useRef<Record<string, string[]>>({});
  const [historyAt, setHistoryAt] = useState(-1);
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    rows: stdout?.rows ?? 24,
    columns: stdout?.columns ?? 80,
  });
  const orchestratorCommands = client.state?.commands ?? [];
  const busy = useRef(false);
  // ink-text-input also receives the ctrl keypress and would insert it as text;
  // a shortcut sets this so the next change from the input is dropped.
  const swallowNextChange = useRef(false);

  useEffect(() => {
    const onRecord = (record: Record<string, unknown>): void => {
      // the monitor's own records ride the same file as claude's messages
      if (record.type === "stream_text") {
        dispatch({ type: "stream_text", text: String(record.text ?? "") });
        return;
      }
      if (record.type === "activity") {
        dispatch({ type: "activity", activity: (record.activity as never) ?? null });
        return;
      }
      if (record.type === "notice") {
        dispatch(
          record.error
            ? { type: "error", text: String(record.text ?? "") }
            : { type: "notice", text: String(record.text ?? "") },
        );
        return;
      }
      // permission records are state, not transcript: the overlay renders them
      if (record.type === "permission_request" || record.type === "permission_resolved") return;
      dispatch(record as unknown as ClaudeStreamMessage);
    };
    const onPermission = (req: PendingRequestRecord): void =>
      setApprovals((q) => (q.some((p) => p.requestId === req.requestId) ? q : [...q, req]));
    const onExit = (info: { code: number | null; signal: string | null }): void =>
      dispatch({ type: "exit", code: info.code, signal: info.signal });
    const onState = (): void => setStateTick((n) => n + 1);
    client.on("record", onRecord);
    client.on("permission_request", onPermission);
    client.on("exit", onExit);
    client.on("state", onState);
    return () => {
      client.off("record", onRecord);
      client.off("permission_request", onPermission);
      client.off("exit", onExit);
      client.off("state", onState);
    };
  }, [client]);

  useEffect(() => {
    const onBatch = (events: FleetEvent[]): void => {
      const text = formatFleetBatch(events, watcher.batchLimit);
      dispatch({ type: "fleet", events, text });
      void client
        .send(text)
        .catch(() => dispatch({ type: "error", text: "! could not deliver fleet events" }));
    };
    watcher.on("batch", onBatch);
    return () => {
      watcher.off("batch", onBatch);
    };
  }, [watcher, client]);

  useEffect(() => {
    const tick = (): void => {
      setRuns(watcher.runs());
      setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, railPollMs);
    return () => clearInterval(timer);
  }, [watcher, railPollMs]);

  // Backstop for the orchestrator's own fleet_cleanup: a settled worker whose
  // branch is merged has nothing left to lose, so its worktree and branch go.
  useEffect(() => {
    if (reapMs <= 0) return;
    let stopped = false;
    const tick = (): void => {
      void reapMergedRuns(watcher.piFleetDir)
        .then(({ reaped }) => {
          if (stopped || reaped.length === 0) return;
          for (const run of reaped)
            dispatch({
              type: "notice",
              text: `· removed ${run.name} (merged into the repository)`,
            });
          setRuns(watcher.runs());
        })
        .catch(() => {
          // best effort; the orchestrator and /remove still work
        });
    };
    const timer = setInterval(tick, reapMs);
    tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watcher, reapMs]);

  // The frame must fit the terminal, or it scrolls and takes the rail with it.
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void =>
      setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    if (!cwd) return;
    let stopped = false;
    void listRepoFiles(cwd)
      .then((found) => {
        if (!stopped) setFiles(found);
      })
      .catch(() => {
        // completion over files is a convenience; without it the rest still works
      });
    return () => {
      stopped = true;
    };
  }, [cwd]);

  const items = useMemo(
    () =>
      buildRail({
        orchestrator: {
          turnActive: view.turnActive,
          exited: view.exited,
          pendingApprovals: approvals.length,
          model: view.model,
        },
        runs,
        now,
      }),
    [view.turnActive, view.exited, approvals.length, view.model, runs, now],
  );
  const index = Math.min(selected, items.length - 1);
  const current = items[index];
  const target = current?.target;
  const currentRun: RailRun | undefined =
    target?.kind === "worker"
      ? runs.find((r) => r.runId === target.runId)
      : undefined;

  const historyKey = target?.kind === "worker" ? target.runId : "orchestrator";
  const completion: CompletionState | null = useMemo(() => {
    if (dismissed || approvals.length > 0 || confirm || showHelp) return null;
    const agentCommands =
      target?.kind === "worker"
        ? (
            runs.find((r) => r.runId === target.runId)?.state.commands ?? []
          ).map((c) => ({
            name: c.name,
            description: c.description,
            source: c.source,
          }))
        : orchestratorCommands.map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
          }));
    return completionsFor(input, {
      target: target?.kind === "worker" ? "worker" : "orchestrator",
      workers: runs.map((r) => ({
        name: r.state.name,
        detail: deriveStatus(r.state),
      })),
      files,
      agentCommands,
    });
  }, [
    input,
    dismissed,
    approvals.length,
    confirm,
    showHelp,
    target,
    runs,
    files,
    orchestratorCommands,
  ]);
  const selectedCompletion =
    completion?.items[Math.min(completionIndex, completion.items.length - 1)];

  const notice = (text: string, error = false): void => {
    if (!text) return;
    setFlash({ text, error });
    dispatch(error ? { type: "error", text } : { type: "notice", text });
  };

  const move = (delta: number): void =>
    setSelected((i) =>
      items.length === 0 ? 0 : (i + delta + items.length) % items.length,
    );

  const recallHistory = (delta: number): void => {
    const entries = historyRef.current[historyKey] ?? [];
    if (entries.length === 0) return;
    const next =
      historyAt === -1
        ? delta < 0
          ? entries.length - 1
          : -1
        : historyAt + (delta < 0 ? -1 : 1);
    if (next < 0 || next >= entries.length) {
      setHistoryAt(-1);
      setInput("");
      return;
    }
    setHistoryAt(next);
    setInput(entries[next]);
    setDismissed(true);
  };

  const acceptCompletion = (): void => {
    if (!completion || !selectedCompletion) return;
    setInput(applySuggestion(input, completion, selectedCompletion));
    setCompletionIndex(0);
    setDismissed(true);
  };

  // Only non-printable keys are bound; the composer owns everything else, so a
  // message that starts with "q" cannot quit the app. Commands get ctrl shortcuts.
  useInput((ch, key) => {
    if (key.tab && completion) {
      acceptCompletion();
      return;
    }
    if (key.tab) {
      move(key.shift ? -1 : 1);
      return;
    }
    if (key.ctrl && (ch === "n" || ch === "p")) {
      move(ch === "n" ? 1 : -1);
      return;
    }
    if (key.escape) {
      if (completion) setDismissed(true);
      else if (showHelp) setShowHelp(false);
      else if (view.turnActive) {
        void client.interrupt();
        notice("· interrupt requested");
      }
      return;
    }
    if (key.ctrl && SHORTCUTS[ch]) {
      const spec = SHORTCUTS[ch];
      swallowNextChange.current = true;
      if (spec.takesArgument) {
        if (target?.kind !== "worker") {
          notice(`! ${spec.name} needs a worker selected (tab switches)`, true);
          return;
        }
        setInput(`${spec.name} `);
        setDismissed(true);
        return;
      }
      run(spec.name);
      return;
    }
    if (approvals.length > 0 || confirm) return;
    if (completion && (key.downArrow || key.upArrow)) {
      const size = completion.items.length;
      setCompletionIndex((i) =>
        key.downArrow ? (i + 1) % size : (i - 1 + size) % size,
      );
      return;
    }
    if (key.downArrow) recallHistory(1);
    else if (key.upArrow) recallHistory(-1);
  });

  /** Run one composer line (also used by the ctrl shortcuts). */
  const run = (value: string): void => {
    const text = value.trim();
    setInput("");
    setFlash(null);
    setDismissed(false);
    setCompletionIndex(0);
    setHistoryAt(-1);
    if (!text || busy.current || confirm) return;
    const entries = (historyRef.current[historyKey] ??= []);
    if (entries[entries.length - 1] !== text) entries.push(text);
    if (entries.length > 100) entries.shift();
    // long form or alias: /q, /h, /rm all resolve here
    const global = text.startsWith("/")
      ? resolveCommand(text.split(/\s+/)[0])
      : null;
    if (global?.name === "/quit") {
      onQuit();
      return;
    }
    if (global?.name === "/help") {
      setShowHelp(true);
      return;
    }
    if (global?.name === "/shutdown") {
      const live = runs.filter(
        (r) => !TERMINAL_VIEWS.includes(deriveStatus(r.state)),
      ).length;
      setConfirm({
        message: `Stop the orchestrator and ${live} running worker${live === 1 ? "" : "s"}? Worktrees and branches are kept.`,
        action: "shutdown",
      });
      return;
    }
    // the orchestrator has no worker mailbox: its reasoning level is claude's own /effort
    if (global?.name === "/thinking" && target?.kind !== "worker") {
      const level = text.split(/\s+/).slice(1).join(" ").trim().toLowerCase();
      if (!CLAUDE_EFFORT_LEVELS.includes(level)) {
        notice(`! usage: /thinking <${CLAUDE_EFFORT_LEVELS.join("|")}>`, true);
        return;
      }
      setEffort(level);
      dispatch({
        type: "sent",
        text: `/effort ${level}`,
        display: `/thinking ${level}`,
      });
      void client.setEffort(level).catch(() => notice("! orchestrator is not running", true));
      return;
    }
    if (target?.kind === "worker") {
      const run = currentRun;
      if (!run) {
        notice("! that worker is gone", true);
        return;
      }
      busy.current = true;
      void workerCommand({
        runDir: run.runDir,
        state: run.state,
        input: text,
        piFleetDir: watcher.piFleetDir,
        runId: run.runId,
      })
        .then((r) => {
          if (r.confirm)
            setConfirm({ message: r.confirm.message, action: "remove", run });
          else notice(r.notice, r.error);
        })
        .catch((err: unknown) =>
          notice(`! ${err instanceof Error ? err.message : String(err)}`, true),
        )
        .finally(() => {
          busy.current = false;
        });
      return;
    }
    dispatch({ type: "sent", text });
    void client.send(text).catch(() => notice("! orchestrator is not running", true));
  };

  /**
   * Enter accepts the highlighted suggestion, unless accepting would change
   * nothing — a fully typed command or mention then runs instead of sticking.
   */
  const submit = (value: string): void => {
    // a command typed in full — long form or alias — runs; the popup only
    // completes what is still partial, or "/q" would expand instead of quitting
    const first = value.trim().split(/\s+/)[0];
    const exact = first.startsWith("/") && resolveCommand(first) !== null;
    if (completion && selectedCompletion && !exact) {
      const completed = applySuggestion(value, completion, selectedCompletion);
      if (completed !== value) {
        setInput(completed);
        setCompletionIndex(0);
        setDismissed(true);
        return;
      }
    }
    run(value);
  };

  /** Stop everything — the orchestrator and every worker — and leave. */
  const shutdown = (): void => {
    setConfirm(null);
    void Promise.all([stopAllWorkers(watcher.piFleetDir), client.shutdown()])
      .then(([stopped]) => {
        notice(
          stopped.length > 0
            ? `■ stopping the orchestrator and ${stopped.join(", ")}`
            : "■ stopping the orchestrator",
        );
        onQuit("shutdown");
      })
      .catch((err: unknown) => {
        notice(`! ${err instanceof Error ? err.message : String(err)}`, true);
        onQuit("shutdown");
      });
  };

  const approval = approvals[0];
  const resolve = (fn: () => Promise<void>): void => {
    void fn().catch((err: unknown) =>
      notice(`! ${err instanceof Error ? err.message : String(err)}`, true),
    );
    setApprovals((q) => q.slice(1));
  };

  const workerLabel = currentRun
    ? `${currentRun.state.name} (${deriveStatus(currentRun.state)})`
    : "worker";

  // wide enough for the longest name, but never more than a third of the screen
  const longestName = Math.max(12, ...items.map((i) => i.name.length));
  // a live "thinking…" line above the composer, for whichever session is selected
  const activity =
    target?.kind === "worker"
      ? currentRun && deriveStatus(currentRun.state) === "running"
        ? `${workerActivity(currentRun.state, deriveView(currentRun.state))} ${formatAge(Math.max(0, now - Date.parse(currentRun.state.lastActivity ?? currentRun.state.createdAt)))}`
        : null
      : activityLine(view.activity, now);

  const railWidth = Math.min(
    Math.max(longestName + 4, 18),
    Math.max(18, Math.floor(size.columns * 0.34)),
    40,
  );
  const paneWidth = Math.max(20, size.columns - railWidth - 2);
  const suggestionRows = completion ? completion.items.length + 1 : 0;
  const overlayRows = approval ? 8 : confirm ? 4 : 0;
  const paneRows = transcriptRows(size.rows, {
    base: CHROME_BASE,
    flash: flash ? 1 : 0,
    activity: activity ? 1 : 0,
    suggestions: suggestionRows,
    overlay: overlayRows,
  });
  // two rows per session (name and what it is doing), plus the separator row
  const railCapacity = Math.max(1, Math.floor((paneRows - 1) / 2));
  const railItems =
    items.length > railCapacity ? items.slice(0, railCapacity) : items;
  const railOverflow = items.length - railItems.length;

  return (
    // A fixed height keeps every frame the same size: ink redraws the whole
    // frame, and one that grows and shrinks with the content leaves the
    // previous, taller frame's rows on screen.
    <Box flexDirection="column" height={Math.max(6, size.rows - 1)}>
      <Box flexGrow={1} overflow="hidden">
        <Box flexDirection="column" width={railWidth} flexShrink={0}>
          <Rail
            items={railItems}
            selectedIndex={Math.min(index, railItems.length - 1)}
            width={railWidth}
          />
          {railOverflow > 0 ? (
            <Text dimColor>{`+${railOverflow} more`}</Text>
          ) : null}
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          paddingLeft={1}
          justifyContent="flex-end"
        >
          {showHelp ? (
            <Text>{helpText()}</Text>
          ) : target?.kind === "worker" ? (
            <WorkerTranscript
              runDir={target.runDir}
              maxRows={paneRows}
              width={paneWidth}
            />
          ) : (
            <Transcript
              lines={view.lines}
              partial={view.partial}
              maxRows={paneRows}
              width={paneWidth}
            />
          )}
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {confirm ? (
          <Confirm
            message={confirm.message}
            onYes={() => {
              const run = confirm.run;
              if (confirm.action === "shutdown" || !run) {
                shutdown();
                return;
              }
              setConfirm(null);
              void removeWorker({
                piFleetDir: watcher.piFleetDir,
                runId: run.runId,
                name: run.state.name,
                force: true,
              })
                .then((r) => {
                  notice(r.notice, r.error);
                  setRuns(watcher.runs());
                })
                .catch((err: unknown) =>
                  notice(
                    `! ${err instanceof Error ? err.message : String(err)}`,
                    true,
                  ),
                );
            }}
            onNo={() => {
              setConfirm(null);
              notice(
                confirm.action === "shutdown"
                  ? "· shutdown cancelled"
                  : "· removal cancelled",
              );
            }}
          />
        ) : approval ? (
          <Approval
            request={approval}
            queued={approvals.length - 1}
            onAllow={(updatedPermissions) =>
              resolve(() => client.allow(approval.requestId, updatedPermissions))
            }
            onDeny={(reason) => resolve(() => client.deny(approval.requestId, reason))}
            onAnswer={(answers) =>
              resolve(() => client.answerQuestion(approval.requestId, answers))
            }
          />
        ) : (
          <>
            {activity ? <Text color="magenta">{activity}</Text> : null}
          {flash ? (
              <Text
                color={flash.error ? "red" : undefined}
                dimColor={!flash.error}
              >
                {flash.text}
              </Text>
            ) : null}
            {completion ? (
              <Suggestions
                items={completion.items}
                selectedIndex={Math.min(
                  completionIndex,
                  completion.items.length - 1,
                )}
              />
            ) : null}
            <Composer
              value={input}
              onChange={(next: string) => {
                if (swallowNextChange.current) {
                  swallowNextChange.current = false;
                  return;
                }
                setInput(next);
                setDismissed(false);
                setCompletionIndex(0);
                setHistoryAt(-1);
              }}
              onSubmit={submit}
              target={target?.kind === "worker" ? workerLabel : "orchestrator"}
              hint={
                target?.kind === "worker"
                  ? "type to steer · /answer · /followup · /stop · /remove · /help · /quit"
                  : "/help · /quit"
              }
            />
          </>
        )}
        <StatusLine
          session={
            currentRun
              ? {
                  kind: "worker",
                  name: currentRun.state.name,
                  state: deriveView(currentRun.state),
                  model: modelLabel(currentRun.state),
                  thinking: currentRun.state.thinkingLevel ?? null,
                  branch: currentRun.state.branch,
                }
              : {
                  kind: "orchestrator",
                  name: "orchestrator",
                  state: view.turnActive ? "working" : "idle",
                  model: view.model,
                  thinking: effort,
                }
          }
          sessionId={view.sessionId}
          costUsd={view.costUsd}
          numTurns={view.numTurns}
          pendingApprovals={approvals.length}
          hint={showHelp ? "esc closes help" : HINT}
        />
      </Box>
    </Box>
  );
}

export type { RunState };
