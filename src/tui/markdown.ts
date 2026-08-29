/**
 * Just enough markdown for a terminal pane: headings, emphasis, inline code,
 * lists, block quotes and fenced code. Rendered into styled spans rather than
 * ANSI so ink does its own width-aware wrapping.
 */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
}

export type MdLineKind = "text" | "heading" | "bullet" | "code" | "quote" | "rule" | "table" | "table-header" | "table-rule";

export interface MdLine {
  kind: MdLineKind;
  spans: Span[];
}

/**
 * Bold, italics, inline code and links. Emphasis markers only count at a word
 * boundary, so a path like `src/tui/*` keeps its asterisk instead of opening an
 * italic run that swallows the rest of the line.
 */
const INLINE = new RegExp(
  [
    "(?<strong>\\*\\*|__)(?=\\S)(?<strongText>[\\s\\S]*?\\S)\\k<strong>",
    "(?<=^|[\\s([{\"'])(?<em>[*_])(?=\\S)(?<emText>[^*_]*?\\S)\\k<em>(?=$|[\\s)\\]}\"'.,;:!?])",
    "`(?<code>[^`]+)`",
    "\\[(?<link>[^\\]]+)\\]\\((?<href>[^)\\s]+)\\)",
  ].join("|"),
);

/** Split one line into styled spans. Unmatched text stays plain. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let rest = text;
  for (;;) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) break;
    if (m.index > 0) spans.push({ text: rest.slice(0, m.index) });
    const g = m.groups ?? {};
    if (g.strongText !== undefined) spans.push({ text: g.strongText, bold: true });
    else if (g.emText !== undefined) spans.push({ text: g.emText, italic: true });
    else if (g.code !== undefined) spans.push({ text: g.code, code: true });
    else if (g.link !== undefined) spans.push({ text: g.link, link: true });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest.length > 0) spans.push({ text: rest });
  return spans.length > 0 ? spans : [{ text }];
}

const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;
const MAX_CELL = 40;

function cellsOf(line: string): string[] {
  const m = TABLE_ROW.exec(line);
  return m ? m[1].split("|").map((c) => c.trim()) : [];
}

interface Cell {
  /** One entry per wrapped line; each is the styled content of that line. */
  lines: Span[][];
  /** Printed width of the widest line, i.e. after the markdown syntax is gone. */
  width: number;
}

/** Break a styled cell into lines of at most `max` printed characters, on word boundaries. */
export function wrapSpans(spans: Span[], max: number): Span[][] {
  const lines: Span[][] = [];
  let line: Span[] = [];
  let used = 0;
  const push = (): void => {
    lines.push(line.length > 0 ? line : [{ text: "" }]);
    line = [];
    used = 0;
  };
  for (const span of spans) {
    // words carry their trailing space so a wrap point is easy to find
    const words = span.text.match(/\S+\s*|\s+/g) ?? [];
    for (const word of words) {
      const trimmed = word.trimEnd();
      if (used > 0 && used + trimmed.length > max) push();
      if (trimmed.length > max) {
        // a single word longer than the column: break it rather than lose it
        let rest = word;
        while (rest.length > max) {
          line.push({ ...span, text: rest.slice(0, max) });
          rest = rest.slice(max);
          used = max;
          push();
        }
        if (rest.length > 0) {
          line.push({ ...span, text: rest });
          used += rest.length;
        }
        continue;
      }
      if (used === 0 && /^\s+$/.test(word)) continue; // no leading space on a fresh line
      line.push({ ...span, text: word });
      used += word.length;
    }
  }
  if (line.length > 0 || lines.length === 0) push();
  // trailing spaces are padding's business, not content's
  return lines.map((l) => l.map((sp, i) => (i === l.length - 1 ? { ...sp, text: sp.text.trimEnd() } : sp)));
}

const printed = (spans: Span[]): number => spans.reduce((n, sp) => n + sp.text.length, 0);

/** One cell's styled spans, wrapped to MAX_CELL printed characters — never truncated. */
function renderCell(text: string, bold: boolean): Cell {
  const spans = parseInline(text).map((sp) => (bold ? { ...sp, bold: true } : sp));
  const lines = wrapSpans(spans, MAX_CELL);
  return { lines, width: Math.max(...lines.map(printed), 0) };
}

/**
 * A markdown table as aligned rows. Cells keep their inline styling and wrap
 * onto as many lines as they need, so nothing is cut; columns are padded to
 * the widest printed line and the header gets a rule under it.
 */
export function renderTable(rows: string[][], header: boolean): MdLine[] {
  const columns = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((row, i) =>
    Array.from({ length: columns }, (_, c) => renderCell(row[c] ?? "", header && i === 0)),
  );
  const widths = Array.from({ length: columns }, (_, c) => Math.max(...cells.map((row) => row[c].width), 1));
  const out: MdLine[] = [];
  cells.forEach((row, i) => {
    const isHeader = header && i === 0;
    const height = Math.max(...row.map((cell) => cell.lines.length));
    for (let line = 0; line < height; line++) {
      const spans: Span[] = [];
      row.forEach((cell, c) => {
        const content = cell.lines[line] ?? [{ text: "" }];
        spans.push(...content);
        const gap = widths[c] - printed(content);
        if (gap > 0) spans.push({ text: " ".repeat(gap) });
        if (c < columns - 1) spans.push({ text: " │ " });
      });
      out.push({ kind: isHeader ? "table-header" : "table", spans });
    }
    if (isHeader) {
      out.push({ kind: "table-rule", spans: [{ text: widths.map((w) => "─".repeat(w)).join("─┼─") }] });
    }
  });
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/** Kinds that read as one group; a change between groups earns a blank line. */
function group(kind: MdLineKind): string {
  if (kind === "table" || kind === "table-header" || kind === "table-rule") return "table";
  if (kind === "bullet") return "list";
  if (kind === "code") return "code";
  if (kind === "heading") return "heading";
  return "prose";
}

/** A blank line between groups, and after a heading, so a block is not a wall. */
function spaced(lines: MdLine[]): MdLine[] {
  const out: MdLine[] = [];
  let previous: MdLine | undefined;
  for (const line of lines) {
    const blank = line.spans.every((s) => s.text.trim() === "");
    if (previous && !blank) {
      const previousBlank = previous.spans.every((s) => s.text.trim() === "");
      const changed = group(previous.kind) !== group(line.kind) || previous.kind === "heading";
      if (changed && !previousBlank) out.push({ kind: "text", spans: [{ text: "" }] });
    }
    out.push(line);
    previous = line;
  }
  return out;
}

export function parseMarkdownBlock(text: string): MdLine[] {
  const out: MdLine[] = [];
  let inFence = false;
  const source = text.split("\n");
  for (let index = 0; index < source.length; index++) {
    const raw = source[index];
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue; // the fence marker itself is not worth a line
    }
    if (inFence) {
      out.push({ kind: "code", spans: [{ text: raw, code: true }] });
      continue;
    }
    if (TABLE_ROW.test(raw) && !TABLE_RULE.test(raw)) {
      const rows: string[][] = [cellsOf(raw)];
      const hasHeader = index + 1 < source.length && TABLE_RULE.test(source[index + 1]);
      let next = index + (hasHeader ? 2 : 1);
      while (next < source.length && TABLE_ROW.test(source[next])) {
        if (!TABLE_RULE.test(source[next])) rows.push(cellsOf(source[next]));
        next++;
      }
      out.push(...renderTable(rows, hasHeader));
      index = next - 1;
      continue;
    }
    if (RULE.test(raw)) {
      out.push({ kind: "rule", spans: [{ text: "─".repeat(24) }] });
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      out.push({ kind: "heading", spans: parseInline(heading[2]).map((s) => ({ ...s, bold: true })) });
      continue;
    }
    const quote = QUOTE.exec(raw);
    if (quote) {
      out.push({ kind: "quote", spans: [{ text: "│ " }, ...parseInline(quote[1])] });
      continue;
    }
    const numbered = NUMBERED.exec(raw);
    if (numbered) {
      out.push({ kind: "bullet", spans: [{ text: `${numbered[1]}${numbered[2]} ` }, ...parseInline(numbered[3])] });
      continue;
    }
    const bullet = BULLET.exec(raw);
    if (bullet) {
      out.push({ kind: "bullet", spans: [{ text: `${bullet[1]}• ` }, ...parseInline(bullet[2])] });
      continue;
    }
    out.push({ kind: "text", spans: parseInline(raw) });
  }
  return spaced(out);
}

/** A one-line, length-bounded version of arbitrary text (tool results, JSON blobs). */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
