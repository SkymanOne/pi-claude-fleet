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

const INLINE = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/;

/** Split one line into styled spans. Unmatched text stays plain. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let rest = text;
  for (;;) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) break;
    if (m.index > 0) spans.push({ text: rest.slice(0, m.index) });
    if (m[2] !== undefined) spans.push({ text: m[2], bold: true });
    else if (m[4] !== undefined) spans.push({ text: m[4], italic: true });
    else if (m[5] !== undefined) spans.push({ text: m[5], code: true });
    else if (m[6] !== undefined) spans.push({ text: m[6], link: true });
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
  spans: Span[];
  /** Printed width, i.e. after the markdown syntax is gone — what padding must use. */
  width: number;
}

/** One cell's styled spans, clipped to MAX_CELL printed characters. */
function renderCell(text: string, bold: boolean): Cell {
  const spans: Span[] = [];
  let width = 0;
  for (const span of parseInline(text)) {
    if (width >= MAX_CELL) break;
    const room = MAX_CELL - width - 1;
    const clipped = span.text.length > room ? `${span.text.slice(0, room)}…` : span.text;
    spans.push(bold ? { ...span, text: clipped, bold: true } : { ...span, text: clipped });
    width += clipped.length;
  }
  return { spans: spans.length > 0 ? spans : [{ text: "" }], width };
}

/**
 * A markdown table as aligned rows. Cells keep their inline styling, columns are
 * padded to the widest printed cell, and the header gets a rule under it.
 */
export function renderTable(rows: string[][], header: boolean): MdLine[] {
  const columns = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((row, i) => Array.from({ length: columns }, (_, c) => renderCell(row[c] ?? "", header && i === 0)));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(...cells.map((row) => row[c].width), 1));
  const out: MdLine[] = [];
  cells.forEach((row, i) => {
    const isHeader = header && i === 0;
    const spans: Span[] = [];
    row.forEach((cell, c) => {
      spans.push(...cell.spans);
      const gap = widths[c] - cell.width;
      if (gap > 0) spans.push({ text: " ".repeat(gap) });
      if (c < columns - 1) spans.push({ text: " │ " });
    });
    out.push({ kind: isHeader ? "table-header" : "table", spans });
    if (isHeader) out.push({ kind: "table-rule", spans: [{ text: widths.map((w) => "─".repeat(w)).join("─┼─") }] });
  });
  return out;
}
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/** One markdown block (an assistant message, say) as renderable lines. */
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
  return out;
}

/** A one-line, length-bounded version of arbitrary text (tool results, JSON blobs). */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
