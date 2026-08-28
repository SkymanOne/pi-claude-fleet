import fs from "node:fs/promises";
import fsSync from "node:fs";

export interface SplitResult {
  lines: string[];
  rest: string;
}

/** Strict JSONL framing: split on \n only, strip one trailing \r. */
export function splitJsonLines(chunk: string, prevRest = ""): SplitResult {
  const buffer = prevRest + chunk;
  const lines: string[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n")) !== -1) {
    let line = rest.slice(0, idx);
    rest = rest.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lines.push(line);
  }
  return { lines, rest };
}

export type ParsedLine<T = unknown> = { ok: true; value: T } | { ok: false };

export function parseLineSafe<T = unknown>(line: string): ParsedLine<T> {
  try {
    return { ok: true, value: JSON.parse(line) as T };
  } catch {
    return { ok: false };
  }
}

export async function atomicWriteJson(
  filePath: string,
  data: unknown,
): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

export async function appendJsonLine(
  filePath: string,
  obj: unknown,
): Promise<void> {
  await fs.appendFile(filePath, JSON.stringify(obj) + "\n");
}

export async function appendText(
  filePath: string,
  text: string,
): Promise<void> {
  await fs.appendFile(filePath, text);
}

export async function readJsonlTail<T = any>(
  filePath: string,
  n: number,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const out: T[] = [];
  for (const line of lines.slice(-n)) {
    const parsed = parseLineSafe<T>(line);
    if (parsed.ok) out.push(parsed.value);
  }
  return out;
}

export async function tailText(
  filePath: string,
  nLines: number,
): Promise<string> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!body) return "";
    return body.split("\n").slice(-nLines).join("\n");
  } catch {
    return "";
  }
}

function stamp(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export function runIdFor(name: string, now: Date = new Date()): string {
  return `${name}-${stamp(now)}`;
}

export function short7(runId: string): string {
  return runId.slice(-7);
}

export function branchFor(name: string, runId: string): string {
  return `pi-fleet/${name}-${short7(runId)}`;
}

export function firstLine(s: string | null | undefined): string {
  const value = s ?? "";
  const idx = value.indexOf("\n");
  return idx === -1 ? value : value.slice(0, idx);
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function resultTextOf(ev: any): string {
  const content = ev?.result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => c.text ?? "").join("");
}

/**
 * Read the complete lines appended to `filePath` after byte `offset`.
 * The returned offset sits just past the last "\n" seen, so a partial
 * trailing line is re-read on the next call instead of being split.
 */
export function readNewLines(
  filePath: string,
  offset: number,
): { lines: string[]; offset: number } {
  let size = 0;
  try {
    size = fsSync.statSync(filePath).size;
  } catch {
    return { lines: [], offset };
  }
  if (size <= offset) return { lines: [], offset };
  const buf = Buffer.alloc(size - offset);
  const fd = fsSync.openSync(filePath, "r");
  try {
    fsSync.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fsSync.closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return { lines: [], offset };
  const { lines } = splitJsonLines(buf.subarray(0, lastNl + 1).toString("utf8"), "");
  return { lines: lines.filter((l) => l.length > 0), offset: offset + lastNl + 1 };
}
