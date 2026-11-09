import type { ParseResult } from "./types";

export interface Stripped {
  text: string;
  /** map[i] = offset in the source of output character i. */
  map: number[];
}

const BLANK_RE = /^\s*$/;

/** Whether `text` may hold markers. Every marker has `&&`, `@@` or a citation's `[@`; text without them strips to itself. */
export function mayHaveMarkers(text: string): boolean {
  return /&&|@@|\[@/.test(text);
}

/**
 * Remove Rakkan markers from `[from, to)` of the parsed text. Everything else
 * (other Markdown, code, math, comments) is kept byte for byte. Block lines are
 * removed together with their line break and one surrounding blank line.
 */
export function stripMarkers(r: ParseResult, from = 0, to = r.text.length): Stripped {
  const { text, lines } = r;
  const drop = new Uint8Array(text.length);
  for (const s of r.segments) {
    if (s.role !== "mark" || s.to <= from || s.from >= to) continue;
    for (let k = s.from; k < s.to; k++) drop[k] = 1;
    // The space that set a declaration apart from the info string goes with it.
    if (s.mark === "decl" && text[s.from - 1] === " ") drop[s.from - 1] = 1;
  }
  for (const b of r.blocks) {
    for (const l of [b.openLine, b.closeLine]) {
      if (l === null) continue;
      const line = lines[l];
      const next = lines[l + 1];
      if (!next) continue;
      for (let k = line.to; k < next.from; k++) drop[k] = 1; // the line break, \r\n, \r or \n
      const prev = lines[l - 1];
      const prevBlank = !prev || BLANK_RE.test(text.slice(prev.from, prev.to));
      const nextBlank = BLANK_RE.test(text.slice(next.from, next.to));
      if (prevBlank && nextBlank && lines[l + 2]) {
        for (let k = next.from; k < lines[l + 2].from; k++) drop[k] = 1;
      }
    }
  }
  let out = "";
  const map: number[] = [];
  for (let k = from; k < to; k++) {
    if (drop[k]) continue;
    out += text[k];
    map.push(k);
  }
  return { text: out, map };
}

/**
 * The content lines of the fenced block (code or formula) opened on
 * `fenceLine`, as source ranges. In a blockquote each range starts after the
 * quote markers (`> `) the fence line has, as the rendered block does.
 */
export function fenceLines(r: ParseResult, fenceLine: number): Array<{ from: number; to: number }> {
  const open = r.lines[fenceLine];
  const depth = /^[ \t]*(?:>[ \t]?)*/.exec(r.text.slice(open.from, open.to))![0].split(">").length - 1;
  const quote = new RegExp(`^(?:[ \\t]*>[ \\t]?){0,${depth}}`);
  const out: Array<{ from: number; to: number }> = [];
  for (let i = fenceLine + 1; i < r.lineContexts.length && r.lineContexts[i].codeFence === fenceLine; i++) {
    const { from, to } = r.lines[i];
    out.push({ from: depth ? from + quote.exec(r.text.slice(from, to))![0].length : from, to });
  }
  return out;
}

/**
 * The content of the fenced code block opened on `fenceLine`: as written, and
 * with the markers a declaration turned on removed. Null for an empty block.
 */
export function codeBlockText(r: ParseResult, fenceLine: number): { plain: string; raw: string } | null {
  const lines = fenceLines(r, fenceLine);
  if (!lines.length) return null;
  return {
    plain: lines.map((l) => stripMarkers(r, l.from, l.to).text).join("\n"),
    raw: lines.map((l) => r.text.slice(l.from, l.to)).join("\n"),
  };
}
