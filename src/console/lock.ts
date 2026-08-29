import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../util.js";

export interface ConsoleLock {
  pid: number;
  ts: string;
}

/** A lock older than this is a crashed console, not a live one. */
export const LOCK_STALE_MS = 15_000;

export const CONSOLE_LOCK = "console.lock";

export function lockPath(dir: string, name: string = CONSOLE_LOCK): string {
  return path.join(dir, name);
}

/** Another live console's lock, or null (missing, malformed, stale, or ours). */
export function readActiveLock(dir: string, now: number = Date.now(), name: string = CONSOLE_LOCK): ConsoleLock | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath(dir, name), "utf8");
  } catch {
    return null;
  }
  let lock: Partial<ConsoleLock>;
  try {
    lock = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof lock.pid !== "number" || typeof lock.ts !== "string") return null;
  if (now - Date.parse(lock.ts) > LOCK_STALE_MS) return null;
  if (lock.pid === process.pid) return null;
  return { pid: lock.pid, ts: lock.ts };
}

export function writeLock(dir: string, name: string = CONSOLE_LOCK): void {
  fs.writeFileSync(lockPath(dir, name), JSON.stringify({ pid: process.pid, ts: nowIso() }));
}

/** Write the lock now and refresh it periodically; the returned stop() removes it if still ours. */
export function startLockHeartbeat(dir: string, intervalMs = 5000, name: string = CONSOLE_LOCK): () => void {
  writeLock(dir, name);
  const timer = setInterval(() => {
    try {
      writeLock(dir, name);
    } catch {
      // best effort
    }
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    try {
      const current = JSON.parse(fs.readFileSync(lockPath(dir, name), "utf8"));
      if (current.pid === process.pid) fs.unlinkSync(lockPath(dir, name));
    } catch {
      // already gone
    }
  };
}
