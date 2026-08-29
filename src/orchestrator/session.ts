import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, nowIso } from "../util.js";

/** Persisted in `<fleetDir>/orchestrator.json` so `pi-fleet` can resume the same claude session. */
export interface OrchestratorSession {
  version: 1;
  sessionId: string | null;
  /** The claude child's pid while it runs; used to reap an orphan after a TUI crash. */
  pid: number | null;
  model: string | null;
  claudeVersion: string | null;
  startedAt: string;
  lastUsedAt: string;
  cwd: string;
  /** FleetWatcher cursors, so a resumed session does not replay old events. */
  watcher: { cursors: Record<string, unknown> };
}

export function sessionPath(piFleetDir: string): string {
  return path.join(piFleetDir, "orchestrator.json");
}

export function newSession(cwd: string): OrchestratorSession {
  const now = nowIso();
  return { version: 1, sessionId: null, pid: null, model: null, claudeVersion: null, startedAt: now, lastUsedAt: now, cwd, watcher: { cursors: {} } };
}

export function loadSession(piFleetDir: string): OrchestratorSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionPath(piFleetDir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrchestratorSession>;
    if (parsed.version !== 1 || typeof parsed.cwd !== "string") return null;
    return { ...newSession(parsed.cwd), ...parsed, watcher: { cursors: parsed.watcher?.cursors ?? {} } };
  } catch {
    return null;
  }
}

export async function saveSession(piFleetDir: string, session: OrchestratorSession): Promise<void> {
  fs.mkdirSync(piFleetDir, { recursive: true });
  await atomicWriteJson(sessionPath(piFleetDir), { ...session, lastUsedAt: nowIso() });
}
