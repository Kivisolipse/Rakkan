// Rewrite a line's markers from a per-character ownership. Used by the
// "mark as" commands and by auto-annotation: the line is re-serialised with
// the fewest inline markers, so adjacent islands merge and empty ones vanish.

import { parseLine, scanInline, type Range } from "./inline";
import type { LineContext } from "./types";

export type Owner = "ai" | "human";

interface Char {
  ch: string;
  owner: Owner;
  key?: string;
  /** Original offset in the line. */
  at: number;
  /** Owner before the edit, for atom handling. */
  orig: string;
}

/** Ranges that must not be split by a marker: links, tags, code, math, URLs, cites. */
export function atomicRanges(content: string): Range[] {
  const out: Range[] = [];
  const scan = scanInline(content, { ampLen: 2, atLen: 2, prose: true });
  for (const s of scan.skips) if (s.type !== "comment") out.push({ from: s.from, to: s.to });
  for (const c of scan.cites) out.push({ from: c.from, to: c.to });
  const patterns = [
    /!?\[\[[^\]\n]*\]\]/g, // wikilinks and embeds
    /!?\[[^\]\n]*\]\([^)\n]*\)/g, // Markdown links and images
    /\[\^[^\]\s]+\]/g, // footnotes
    /(^|[\s(（])#[^\s#.,;:!?，。；：！？、()（）]+/g, // tags
    /\s\^[A-Za-z0-9-]+$/g, // block references
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const lead = m[1] ? m[1].length : 0;
      out.push({ from: m.index + lead, to: m.index + m[0].length });
    }
  }
  return out;
}

function ownersOf(content: string, ctx: LineContext): Char[] | null {
  const r = parseLine(content, {
    base: ctx.base,
    pair: ctx.pair,
    mode: "prose",
    ampLen: 2,
    atLen: 2,
    inComment: ctx.inComment,
  });
  if (r.spans.some((s) => s.type === "quote")) return null;
  const chars: Char[] = [];
  for (const s of r.segments) {
    if (s.role === "mark") continue;
    const owner: Owner = s.attr.kind === "ai" ? "ai" : "human";
    for (let k = s.from; k < s.to; k++) {
      const c: Char = { ch: content[k], owner, at: k, orig: "" };
      if (s.attr.key && s.attr.explicit) c.key = s.attr.key;
      c.orig = owner + (c.key ?? "");
      chars.push(c);
    }
  }
  return chars;
}

function serialize(chars: Char[], baseOwner: Owner, escape: boolean): string {
  const marker = baseOwner === "human" ? "&&" : "@@";
  let out = "";
  let i = 0;
  const esc = (s: string) => (escape ? s.replace(/(^|[^&@\\])(&&|@@)(?![&@])/g, "$1\\$2") : s);
  while (i < chars.length) {
    const c = chars[i];
    let j = i + 1;
    while (j < chars.length && chars[j].owner === c.owner && chars[j].key === c.key) j++;
    const text = chars
      .slice(i, j)
      .map((x) => x.ch)
      .join("");
    if (c.owner === baseOwner || !text.trim()) out += esc(text);
    else {
      // Keep surrounding spaces outside the markers.
      const lead = text.length - text.trimStart().length;
      const trail = text.length - text.trimEnd().length;
      out +=
        text.slice(0, lead) +
        marker +
        esc(text.slice(lead, text.length - trail)) +
        marker +
        (c.key ? `[@${c.key}]` : "") +
        text.slice(text.length - trail);
    }
    i = j;
  }
  return out;
}

/** Ownership of the visible characters only, for verification. */
function signature(chars: Char[]): string {
  // Whitespace may move outside markers, so its owner does not count.
  return chars.map((c) => (/\s/.test(c.ch) ? "S" : c.owner === "ai" ? "A" : "H") + c.ch).join("");
}

/**
 * Return `line` rewritten so that `[from, to)` (offsets within the line)
 * belongs to `owner`, or null when the line cannot be rewritten safely
 * (quotes, code, cited blockquotes).
 */
export function setOwner(line: string, ctx: LineContext, from: number, to: number, owner: Owner): string | null {
  return rewriteLine(line, ctx, (chars) => {
    for (const c of chars) {
      if (c.at >= from && c.at < to) {
        c.owner = owner;
        delete c.key;
      }
    }
  });
}

/**
 * Rewrite a line after changing ownership with `edit`. Atomic ranges touched
 * by a change take the changed owner as a whole.
 */
export function rewriteLine(line: string, ctx: LineContext, edit: (chars: Char[]) => void): string | null {
  if (ctx.mode !== "prose" || ctx.pair === "quote") return null;
  const prefix = line.slice(0, ctx.prefix);
  const content = line.slice(ctx.prefix);
  const chars = ownersOf(content, ctx);
  if (!chars) return null;
  edit(chars);

  // Never split links and friends: if part of an atom changed, the atom follows.
  const byAt = new Map(chars.map((c) => [c.at, c] as const));
  for (const a of atomicRanges(content)) {
    let changed: Char | undefined;
    for (let k = a.from; k < a.to; k++) {
      const c = byAt.get(k);
      if (c && c.orig !== c.owner + (c.key ?? "")) changed = c;
    }
    if (!changed) continue;
    for (let k = a.from; k < a.to; k++) {
      const c = byAt.get(k);
      if (c) {
        c.owner = changed.owner;
        c.key = changed.key;
      }
    }
  }

  const baseOwner: Owner = ctx.pair === "ai-block" ? "ai" : "human";
  const want = signature(chars);
  for (const escape of [false, true]) {
    const out = serialize(chars, baseOwner, escape);
    const check = ownersOf(out, ctx);
    if (!check) continue;
    // Escapes add backslashes; compare ignoring them only when escaping.
    const got = signature(escape ? check.filter((c) => !(c.ch === "\\" && /[&@]/.test(out[c.at + 1] ?? ""))) : check);
    if (got === want) return prefix + out;
  }
  return null;
}

/** Smallest single replacement turning `a` into `b`. */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}
