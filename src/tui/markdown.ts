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
}

export type MdLineKind = "text" | "heading" | "bullet" | "code" | "quote" | "rule";

export interface MdLine {
  kind: MdLineKind;
  spans: Span[];
}

const INLINE = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3|`([^`]+)`/;

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
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest.length > 0) spans.push({ text: rest });
  return spans.length > 0 ? spans : [{ text }];
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/** One markdown block (an assistant message, say) as renderable lines. */
export function parseMarkdownBlock(text: string): MdLine[] {
  const out: MdLine[] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue; // the fence marker itself is not worth a line
    }
    if (inFence) {
      out.push({ kind: "code", spans: [{ text: raw, code: true }] });
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
