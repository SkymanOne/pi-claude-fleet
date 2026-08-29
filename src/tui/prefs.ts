/**
 * Console preferences: how this person likes the window laid out. They belong
 * to the console rather than the orchestrator, so they live beside the fleet
 * state and survive both a reopen and a restart of the session.
 */
import fs from "node:fs";
import path from "node:path";

/** Rail widths the cycle steps through. */
export const RAIL_MODES = ["compact", "auto", "wide", "full"] as const;
export type RailMode = (typeof RAIL_MODES)[number];

export interface ConsolePrefs {
  railMode: RailMode;
}

const DEFAULTS: ConsolePrefs = { railMode: "auto" };

const prefsPath = (piFleetDir: string): string => path.join(piFleetDir, "console.json");

export function loadPrefs(piFleetDir: string): ConsolePrefs {
  try {
    const raw = JSON.parse(fs.readFileSync(prefsPath(piFleetDir), "utf8")) as Partial<ConsolePrefs>;
    const railMode = RAIL_MODES.includes(raw.railMode as RailMode) ? (raw.railMode as RailMode) : DEFAULTS.railMode;
    return { railMode };
  } catch {
    // no preferences yet, or unreadable: the defaults are fine
    return { ...DEFAULTS };
  }
}

export function savePrefs(piFleetDir: string, prefs: ConsolePrefs): void {
  try {
    fs.writeFileSync(prefsPath(piFleetDir), `${JSON.stringify(prefs, null, 2)}\n`);
  } catch {
    // a preference that cannot be saved is not worth interrupting anyone over
  }
}

/**
 * Columns the rail gets. `full` hands it the whole window so nothing is
 * clipped; `auto` fits the longest name within a third of the width.
 */
export function railWidthFor(mode: RailMode, columns: number, longestName: number): number {
  switch (mode) {
    case "compact":
      return Math.max(12, Math.min(16, columns - 20));
    case "wide":
      return Math.max(18, Math.min(60, Math.floor(columns * 0.5)));
    case "full":
      return Math.max(20, columns);
    default:
      return Math.min(Math.max(longestName + 4, 18), Math.max(18, Math.floor(columns * 0.34)), 40);
  }
}

export function nextRailMode(mode: RailMode): RailMode {
  return RAIL_MODES[(RAIL_MODES.indexOf(mode) + 1) % RAIL_MODES.length];
}
