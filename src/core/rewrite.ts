// Rewrite a line's markers from a per-character ownership. Used by the
// "mark as" commands and by auto-annotation: the line is re-serialised with
// the fewest inline markers, so adjacent islands merge and empty ones vanish.

import { parseLine, scanInline, type Range } from "./inline";
import type { LineContext } from "./types";

export type Owner = "ai" | "human";

export interface Char {
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
    // Block references, without the space before them: a change that ends in that space would take the
    // reference into the markers, where it no longer ends the line.
    /([ \t])\^[A-Za-z0-9-]+$/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const lead = m[1] ? m[1].length : 0;
      out.push({ from: m.index + lead, to: m.index + m[0].length });
    }
  }
  // Markers always go outside bold / highlight / strike / italic: `**&&x&&**` breaks
  // bold after CJK text (CommonMark flanking rules), `&&**x**&&` does not.
  const emphasis = /(\*\*|__|==|~~)\S(?:.*?\S)?\1/g;
  let e: RegExpExecArray | null;
  while ((e = emphasis.exec(content))) out.push({ from: e.index, to: e.index + e[0].length });
  const italic = /(^|[^*])(\*[^\s*](?:[^*]*[^\s*])?\*)(?!\*)/g;
  while ((e = italic.exec(content))) out.push({ from: e.index + e[1].length, to: e.index + e[0].length });
  // Ranges that overlap are one: a bare URL can run into a link (`https://x.y/@@[t](…)`), and spreading
  // a change over one of them and then the other would depend on their order.
  out.sort((x, y) => x.from - y.from || y.to - x.to);
  const merged: Range[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.from < last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

/** Whitespace between two spans of the same owner joins them: `@@a@@ @@b@@` → `@@a b@@`. */
function joinWhitespace(chars: Char[], baseOwner: Owner) {
  for (let i = 0; i < chars.length; i++) {
    if (!/\s/.test(chars[i].ch)) continue;
    let j = i;
    while (j < chars.length && /\s/.test(chars[j].ch)) j++;
    const prev = chars[i - 1];
    const next = chars[j];
    if (prev && next && prev.owner !== baseOwner && prev.owner === next.owner && prev.key === next.key) {
      for (let k = i; k < j; k++) {
        chars[k].owner = prev.owner;
        chars[k].key = prev.key;
      }
    }
    i = j - 1;
  }
}

function ownersOf(content: string, ctx: LineContext, code = false): Char[] | null {
  const r = parseLine(content, {
    base: ctx.base,
    pair: ctx.pair,
    mode: code ? "code" : "prose",
    ampLen: code ? 0 : 2,
    atLen: code ? ctx.atLen : 2,
    inComment: code ? false : ctx.inComment,
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

function serialize(
  chars: Char[],
  baseOwner: Owner,
  escape: boolean,
  marker = baseOwner === "human" ? "&&" : "@@",
  spacesInside = false,
): string {
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
      // Keep surrounding spaces outside the markers, unless told otherwise (a `&` or `@` at the
      // edge of the text would run into the marker: `&&x &&&` is no span, `&&x & &&` is).
      const lead = spacesInside ? 0 : text.length - text.trimStart().length;
      const trail = spacesInside ? 0 : text.length - text.trimEnd().length;
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
 * What makes a line a heading, list item, task or footnote: `## `, `- `,
 * `1. `, `- [ ] `, `[^1]: `. A marker in front of it would turn the line into
 * a paragraph, so it always belongs to the line's base owner.
 */
export const LEADER_RE = /^[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\[\^[^\]\s]+\]:[ \t]*)/;

/** Line leaders and table pipes stay outside markers: `## &&AI&&`, `| &&a&& | b |`. */
function keepSyntaxOutside(chars: Char[], content: string, baseOwner: Owner) {
  const visible = chars.map((c) => c.ch).join("");
  const lead = LEADER_RE.exec(visible)?.[0].length ?? 0;
  for (let i = 0; i < lead; i++) {
    chars[i].owner = baseOwner;
    delete chars[i].key;
  }
  if (!/^\s*\|/.test(visible)) return;
  const atoms = atomicRanges(content);
  for (const c of chars) {
    if (c.ch !== "|" || content[c.at - 1] === "\\" || atoms.some((a) => c.at >= a.from && c.at < a.to)) continue;
    c.owner = baseOwner;
    delete c.key;
  }
}

/**
 * Return `line` rewritten so that `[from, to)` (offsets within the line)
 * belongs to `owner`, or null when the line cannot be rewritten safely
 * (quotes, code, cited blockquotes).
 */
export function setOwner(line: string, ctx: LineContext, from: number, to: number, owner: Owner): string | null {
  // `from` / `to` are line offsets; characters are indexed without the `> ` prefix.
  const a = from - ctx.prefix;
  const b = to - ctx.prefix;
  return rewriteLine(line, ctx, (chars) => {
    for (const c of chars) {
      if (c.at >= a && c.at < b) {
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
  return rewriteLineDetailed(line, ctx, edit)?.text ?? null;
}

export interface Rewritten {
  text: string;
  /** Offset in the new line of every visible character, by its offset in the old line. */
  map: Map<number, number>;
}

export function rewriteLineDetailed(line: string, ctx: LineContext, edit: (chars: Char[]) => void): Rewritten | null {
  if (ctx.mode !== "prose" || ctx.pair === "quote") return null;
  const prefix = line.slice(0, ctx.prefix);
  const content = line.slice(ctx.prefix);
  const chars = ownersOf(content, ctx);
  if (!chars) return null;
  edit(chars);

  const baseOwner: Owner = ctx.pair === "ai-block" ? "ai" : "human";
  keepSyntaxOutside(chars, content, baseOwner);

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

  joinWhitespace(chars, baseOwner);

  const want = signature(chars);
  for (const [escape, spacesInside] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const out = serialize(chars, baseOwner, escape, undefined, spacesInside);
    const check = ownersOf(out, ctx);
    if (!check) continue;
    // Escapes add backslashes; compare ignoring them only when escaping.
    const visible = escape ? check.filter((c) => !(c.ch === "\\" && /[&@]/.test(out[c.at + 1] ?? ""))) : check;
    if (signature(visible) === want) {
      const map = new Map<number, number>();
      chars.forEach((c, i) => map.set(c.at + ctx.prefix, visible[i].at + ctx.prefix));
      return { text: prefix + out, map };
    }
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

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * Character-level diff between `a` and `b` as separate changes, so a cursor
 * between two edits is not swallowed by one big replacement. Marker
 * characters count less than other characters when matching, which keeps
 * typed text in place and moves the markers around it.
 */
export function diffChanges(a: string, b: string): TextChange[] {
  if (a === b) return [];
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const x = a.slice(s, ea);
  const y = b.slice(s, eb);
  const n = x.length;
  const m = y.length;
  if (n * m > 40000) return [{ from: s, to: ea, insert: y }];

  const weight = (c: string) => (c === "&" || c === "@" || c === "\\" ? 1 : 4);
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        x[i] === y[j] ? dp[i + 1][j + 1] + weight(x[i]) : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: TextChange[] = [];
  let cur: TextChange | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j] && dp[i][j] === dp[i + 1][j + 1] + weight(x[i])) {
      if (cur) out.push(cur);
      cur = null;
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      cur ??= { from: s + i, to: s + i, insert: "" };
      cur.insert += y[j++];
    } else {
      cur ??= { from: s + i, to: s + i, insert: "" };
      cur.to = s + ++i;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Rewrite a line of a code block whose fence declares `@@` (any length), inside
 * an AI block or a cited blockquote. Code has no escapes and no links, so the declared run length is
 * the only thing that makes a marker.
 */
export function rewriteCodeLine(line: string, ctx: LineContext, edit: (chars: Char[]) => void): Rewritten | null {
  if (ctx.mode !== "code" || ctx.atLen < 2) return null;
  // In a cited blockquote the unmarked code is the quoted author's and `@@` islands are the
  // person's: the same shape as an AI block, so it is rewritten as one.
  if (ctx.pair === "quote") ctx = { ...ctx, base: { kind: "ai", explicit: false }, pair: "ai-block" };
  if (ctx.pair !== "ai-block") return null;
  const chars = ownersOf(line, ctx, true);
  if (!chars) return null;
  edit(chars);
  joinWhitespace(chars, "ai");
  const out = serialize(chars, "ai", false, "@".repeat(ctx.atLen));
  const check = ownersOf(out, ctx, true);
  if (!check || signature(check) !== signature(chars)) return null;
  const map = new Map<number, number>();
  chars.forEach((c, i) => map.set(c.at, check[i].at));
  return { text: out, map };
}
