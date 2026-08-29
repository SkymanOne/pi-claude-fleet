/**
 * Watches every run in a fleet dir and turns changes into fleet events.
 *
 * Two sources: `state.json` (status transitions, via `deriveView`) and
 * `events.jsonl` (worker questions, console interventions, progress). Both are
 * cursor-based, so a restarted watcher does not replay what it already
 * reported, and a fresh watcher starts at the current end of each file.
 */
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { listRuns, loadStateSync, deriveView, type DerivedView, type RunState } from "../state.js";
import { readNewEvents } from "../console/transcript.js";
import { reportPath } from "../report.js";
import { makeFleetEvent, lastLine, type FleetEvent, type FleetEventKind } from "./events.js";

export interface RunCursor {
  /** Byte offset already consumed in the run's events.jsonl. */
  eventsOffset: number;
  /** Last derived view reported for this run. */
  lastView: DerivedView | null;
}

export type Cursors = Record<string, RunCursor>;

export interface FleetWatcherOptions {
  piFleetDir: string;
  pollMs?: number;
  batchMs?: number;
  maxPerBatch?: number;
  cursors?: Cursors;
  /** Emit `progress` events (off by default; throttled when on). */
  progressEvents?: boolean;
  progressThrottleMs?: number;
}

export interface FleetWatcherEvents {
  event: [FleetEvent];
  batch: [FleetEvent[]];
  cursors: [Cursors];
}

const TERMINAL_VIEWS: DerivedView[] = ["settled", "stopped", "error", "dead"];
const KIND_BY_VIEW: Partial<Record<DerivedView, FleetEventKind>> = {
  settled: "settled",
  stopped: "stopped",
  error: "error",
  dead: "dead",
};

export class FleetWatcher extends EventEmitter<FleetWatcherEvents> {
  readonly piFleetDir: string;
  private readonly pollMs: number;
  private readonly batchMs: number;
  private readonly maxPerBatch: number;
  private readonly progressEvents: boolean;
  private readonly progressThrottleMs: number;
  private cursors: Cursors;
  private timer: NodeJS.Timeout | null = null;
  private batchTimer: NodeJS.Timeout | null = null;
  private queued: FleetEvent[] = [];
  private lastProgressAt = new Map<string, number>();

  constructor(opts: FleetWatcherOptions) {
    super();
    this.piFleetDir = opts.piFleetDir;
    this.pollMs = opts.pollMs ?? 500;
    this.batchMs = opts.batchMs ?? 500;
    this.maxPerBatch = opts.maxPerBatch ?? 10;
    this.progressEvents = opts.progressEvents ?? false;
    this.progressThrottleMs = opts.progressThrottleMs ?? 60_000;
    this.cursors = { ...(opts.cursors ?? {}) };
  }

  getCursors(): Cursors {
    return { ...this.cursors };
  }

  /** Live runs right now, for the rail and for the `snapshot` event. */
  runs(): { runId: string; runDir: string; state: RunState; view: DerivedView }[] {
    return listRuns(this.piFleetDir).flatMap(({ runId, runDir }) => {
      try {
        const state = loadStateSync(runDir);
        if (state.status === "archived") return [];
        return [{ runId, runDir, state, view: deriveView(state) }];
      } catch {
        return [];
      }
    });
  }

  /**
   * Start watching. Runs the watcher has never seen start at the current end of
   * their events file, so history is not replayed; known runs continue from
   * their cursor. `snapshot` reports live runs on a resume.
   */
  start(opts: { snapshot?: boolean } = {}): void {
    if (this.timer) return;
    const known = new Set(Object.keys(this.cursors));
    const live = this.runs();
    for (const run of live) {
      if (known.has(run.runId)) continue;
      const eventsPath = path.join(run.runDir, "events.jsonl");
      let size = 0;
      try {
        size = fs.statSync(eventsPath).size;
      } catch {
        size = 0;
      }
      this.cursors[run.runId] = { eventsOffset: size, lastView: run.view };
    }
    if (opts.snapshot && live.length > 0) {
      const summary = live.map((r) => `${r.state.name} (${r.view}${r.state.pendingQuestion ? `, asking: ${r.state.pendingQuestion.question}` : ""})`).join("; ");
      this.push(makeFleetEvent({ kind: "snapshot", runId: "-", name: "fleet", fields: { runs: summary, count: String(live.length) } }));
    }
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.flush();
  }

  /** One poll pass; exposed for tests that drive the clock themselves. */
  tick(): void {
    for (const run of this.runs()) {
      const cursor = (this.cursors[run.runId] ??= { eventsOffset: 0, lastView: null });
      const { events, offset } = readNewEvents(path.join(run.runDir, "events.jsonl"), cursor.eventsOffset);
      cursor.eventsOffset = offset;
      for (const ev of events) this.fromRunEvent(run.runId, run.state, ev);
      if (run.view !== cursor.lastView) {
        const kind = KIND_BY_VIEW[run.view];
        // Report only arrivals in a terminal view; running/starting/blocked flaps are noise.
        if (kind && TERMINAL_VIEWS.includes(run.view)) this.push(this.statusEvent(run.runId, run.state, kind));
        cursor.lastView = run.view;
      }
    }
    this.emit("cursors", this.getCursors());
  }

  private statusEvent(runId: string, state: RunState, kind: FleetEventKind): FleetEvent {
    const report = reportPath(this.piFleetDir, state.id);
    return makeFleetEvent({
      kind,
      runId,
      name: state.name,
      fields: {
        status: kind,
        report: kind === "settled" ? `${report} (${fs.existsSync(report) ? "present" : "missing"})` : undefined,
        branch: state.branch ?? undefined,
        worktree: state.worktree ?? undefined,
        error: state.error ?? undefined,
        last: lastLine(state.lastAssistantText) ?? undefined,
      },
    });
  }

  private fromRunEvent(runId: string, state: RunState, ev: Record<string, any>): void {
    switch (ev.type) {
      case "worker_question":
        this.push(
          makeFleetEvent({
            kind: "question",
            runId,
            name: state.name,
            fields: {
              "question-id": ev.questionId ?? undefined,
              question: ev.question ?? undefined,
              options: Array.isArray(ev.options) && ev.options.length > 0 ? ev.options.join(" | ") : undefined,
              context: ev.context ?? undefined,
            },
          }),
        );
        return;
      case "answer_delivered":
        // Only the human's answers are news; the orchestrator knows its own.
        if (ev.source !== "console") return;
        this.push(
          makeFleetEvent({
            kind: "answered_by_console",
            runId,
            name: state.name,
            fields: { "question-id": ev.questionId ?? undefined, answer: ev.message ?? undefined },
          }),
        );
        return;
      case "steering_delivered":
        if (ev.source !== "console") return;
        this.push(makeFleetEvent({ kind: "console_steer", runId, name: state.name, fields: { message: ev.message ?? undefined } }));
        return;
      case "worker_question_resolved":
        if (ev.how !== "timeout") return;
        this.push(
          makeFleetEvent({
            kind: "question_resolved",
            runId,
            name: state.name,
            fields: { "question-id": ev.questionId ?? undefined, how: "timeout — nobody answered; the worker proceeded on its own judgment" },
          }),
        );
        return;
      case "worker_progress": {
        if (!this.progressEvents) return;
        const last = this.lastProgressAt.get(runId) ?? 0;
        const now = Date.now();
        if (now - last < this.progressThrottleMs) return;
        this.lastProgressAt.set(runId, now);
        this.push(makeFleetEvent({ kind: "progress", runId, name: state.name, fields: { message: ev.message ?? undefined } }));
        return;
      }
      default:
        return;
    }
  }

  private push(ev: FleetEvent): void {
    this.queued.push(ev);
    this.emit("event", ev);
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flush();
    }, this.batchMs);
    this.batchTimer.unref?.();
  }

  private flush(): void {
    if (this.queued.length === 0) return;
    const batch = this.queued;
    this.queued = [];
    this.emit("batch", batch);
  }

  get batchLimit(): number {
    return this.maxPerBatch;
  }
}
