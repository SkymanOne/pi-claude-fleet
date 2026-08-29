import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { OrchestratorProcess, type PermissionRequest } from "../orchestrator/process.js";
import { FleetWatcher } from "../fleet/watcher.js";
import { formatFleetBatch, type FleetEvent } from "../fleet/events.js";
import { deriveStatus, type RunState } from "../state.js";
import { Rail } from "./Rail.js";
import { Transcript } from "./Transcript.js";
import { WorkerTranscript } from "./WorkerTranscript.js";
import { StatusLine } from "./StatusLine.js";
import { Composer } from "./Composer.js";
import { Approval } from "./Approval.js";
import { helpText, HINT } from "./keys.js";
import { workerCommand } from "./workerActions.js";
import {
  buildRail,
  initialViewState,
  reduceOrchestrator,
  type LocalEvent,
  type OrchestratorViewState,
  type RailRun,
} from "./model.js";
import type { ClaudeStreamMessage } from "../orchestrator/protocol.js";

export interface AppProps {
  proc: OrchestratorProcess;
  watcher: FleetWatcher;
  onQuit: () => void;
  /** Poll interval for the rail (the watcher has its own). */
  railPollMs?: number;
}

type Dispatchable = ClaudeStreamMessage | LocalEvent;

/** reduceOrchestrator mutates; spreading gives React a new reference to render. */
const reducer = (state: OrchestratorViewState, msg: Dispatchable): OrchestratorViewState => ({ ...reduceOrchestrator(state, msg) });

export function App({ proc, watcher, onQuit, railPollMs = 500 }: AppProps) {
  const [view, dispatch] = useReducer(reducer, undefined, initialViewState);
  const [runs, setRuns] = useState<RailRun[]>(() => watcher.runs());
  const [selected, setSelected] = useState(0);
  const [approvals, setApprovals] = useState<PermissionRequest[]>([]);
  const [input, setInput] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false);

  useEffect(() => {
    const onMessage = (msg: ClaudeStreamMessage): void => dispatch(msg);
    const onPermission = (req: PermissionRequest): void => setApprovals((q) => [...q, req]);
    const onExit = (info: { code: number | null; signal: NodeJS.Signals | null }): void =>
      dispatch({ type: "exit", code: info.code, signal: info.signal });
    const onError = (err: Error): void => dispatch({ type: "error", text: `! orchestrator: ${err.message}` });
    proc.on("message", onMessage);
    proc.on("permission_request", onPermission);
    proc.on("exit", onExit);
    proc.on("error", onError);
    return () => {
      proc.off("message", onMessage);
      proc.off("permission_request", onPermission);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };
  }, [proc]);

  useEffect(() => {
    const onBatch = (events: FleetEvent[]): void => {
      const text = formatFleetBatch(events, watcher.batchLimit);
      dispatch({ type: "fleet", events, text });
      if (!proc.send(text)) dispatch({ type: "error", text: "! could not deliver fleet events (orchestrator not running)" });
    };
    watcher.on("batch", onBatch);
    return () => {
      watcher.off("batch", onBatch);
    };
  }, [watcher, proc]);

  useEffect(() => {
    const tick = (): void => {
      setRuns(watcher.runs());
      setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, railPollMs);
    return () => clearInterval(timer);
  }, [watcher, railPollMs]);

  const items = useMemo(
    () => buildRail({ orchestrator: { turnActive: view.turnActive, exited: view.exited, pendingApprovals: approvals.length }, runs, now }),
    [view.turnActive, view.exited, approvals.length, runs, now],
  );
  const index = Math.min(selected, items.length - 1);
  const current = items[index];
  const target = current?.target;
  const currentRun: RailRun | undefined = target?.kind === "worker" ? runs.find((r) => r.runId === target.runId) : undefined;

  const notice = (text: string, error = false): void => dispatch(error ? { type: "error", text } : { type: "notice", text });

  const move = (delta: number): void => setSelected((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length));

  // Only non-printable keys are bound; the composer owns everything else, so a
  // message that starts with "q" cannot quit the app.
  useInput((_ch, key) => {
    if (key.tab) {
      move(key.shift ? -1 : 1);
      return;
    }
    if (key.escape) {
      if (showHelp) setShowHelp(false);
      else if (view.turnActive) {
        void proc.interrupt();
        notice("· interrupt requested");
      }
      return;
    }
    if (approvals.length > 0) return;
    if (key.downArrow) move(1);
    else if (key.upArrow) move(-1);
  });

  const submit = (value: string): void => {
    const text = value.trim();
    setInput("");
    if (!text || busy.current) return;
    if (text === "/quit") {
      onQuit();
      return;
    }
    if (text === "/help") {
      setShowHelp(true);
      return;
    }
    if (target?.kind === "worker") {
      const run = currentRun;
      if (!run) {
        notice("! that worker is gone", true);
        return;
      }
      busy.current = true;
      void workerCommand({ runDir: run.runDir, state: run.state, input: text })
        .then((r) => notice(r.notice, r.error))
        .catch((err: unknown) => notice(`! ${err instanceof Error ? err.message : String(err)}`, true))
        .finally(() => {
          busy.current = false;
        });
      return;
    }
    dispatch({ type: "sent", text });
    if (!proc.send(text)) notice("! orchestrator is not running", true);
  };

  const approval = approvals[0];
  const resolve = (fn: () => boolean): void => {
    fn();
    setApprovals((q) => q.slice(1));
  };

  const workerLabel = currentRun ? `${currentRun.state.name} (${deriveStatus(currentRun.state)})` : "worker";

  return (
    <Box flexDirection="column">
      <Box>
        <Rail items={items} selectedIndex={index} />
        <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
          {showHelp ? (
            <Text>{helpText()}</Text>
          ) : target?.kind === "worker" ? (
            <WorkerTranscript runDir={target.runDir} />
          ) : (
            <Transcript lines={view.lines} partial={view.partial} />
          )}
        </Box>
      </Box>
      {approval ? (
        <Approval
          request={approval}
          queued={approvals.length - 1}
          onAllow={(updatedPermissions) => resolve(() => proc.allow(approval.requestId, updatedPermissions))}
          onDeny={(reason) => resolve(() => proc.deny(approval.requestId, reason))}
          onAnswer={(answers) => resolve(() => proc.answerQuestion(approval.requestId, answers))}
        />
      ) : (
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={submit}
          target={target?.kind === "worker" ? workerLabel : "orchestrator"}
          hint={target?.kind === "worker" ? "type to steer · /answer · /followup · /stop · /help · /quit" : "/help · /quit"}
        />
      )}
      <StatusLine
        model={view.model}
        sessionId={view.sessionId}
        costUsd={view.costUsd}
        numTurns={view.numTurns}
        pendingApprovals={approvals.length}
        turnActive={view.turnActive}
        hint={showHelp ? "esc closes help" : HINT}
      />
    </Box>
  );
}

export type { RunState };
