/**
 * The frame must never be taller than the terminal: ink prints the whole frame,
 * so anything past the last row scrolls the rail and the status line out of
 * view. Everything here is a pure estimate of how many rows a line will take
 * once ink wraps it.
 */
export const MIN_TRANSCRIPT_ROWS = 3;

export function rowsFor(text: string, width: number): number {
  if (width <= 0) return 1;
  return Math.max(1, Math.ceil(text.length / width));
}

/**
 * The tail of `lines` that fits in `maxRows` at `width`, newest kept.
 * Returns the slice plus how many lines were dropped off the top.
 */
export function visibleTail<T>(lines: T[], maxRows: number, width: number, text: (line: T) => string): { lines: T[]; hidden: number } {
  if (maxRows <= 0) return { lines: [], hidden: lines.length };
  let rows = 0;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = rows + rowsFor(text(lines[i]), width);
    if (next > maxRows) break;
    rows = next;
    start = i;
  }
  // always show something, even a single line too tall for the budget
  if (start === lines.length && lines.length > 0) start = lines.length - 1;
  return { lines: lines.slice(start), hidden: start };
}

/**
 * The same tail, with a row reserved for the "… N earlier lines" notice when
 * there is one — otherwise the notice itself gets clipped off the top.
 */
export function visibleTailWithNotice<T>(lines: T[], maxRows: number, width: number, text: (line: T) => string): { lines: T[]; hidden: number } {
  const first = visibleTail(lines, maxRows, width, text);
  return first.hidden > 0 ? visibleTail(lines, maxRows - 1, width, text) : first;
}

export interface Chrome {
  /** Rows taken by the composer, its hint, and the status line. */
  base: number;
  flash: number;
  suggestions: number;
  overlay: number;
}

export const CHROME_BASE = 3;

/** Rows left for the transcript once the chrome is accounted for. */
export function transcriptRows(terminalRows: number, chrome: Partial<Chrome> = {}): number {
  const used = (chrome.base ?? CHROME_BASE) + (chrome.flash ?? 0) + (chrome.suggestions ?? 0) + (chrome.overlay ?? 0);
  return Math.max(MIN_TRANSCRIPT_ROWS, terminalRows - used - 1);
}
