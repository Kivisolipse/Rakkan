// Clarifying a quote (SPEC §4.4): the person settles whose its words are, and the answer is written back
// as markers, so that every reader of the note (the plugin, the command line, an agent) gets the same.
// After any of the four, the quote has one author, or is no quote.

import { parseLine } from "./inline";
import { lint } from "./lint";
import { blockLine, indexAt, parse } from "./parse";
import { rewriteLineDetailed, writeLine, type Char, type Owner } from "./rewrite";
import type { Attr, LineContext, ParseResult } from "./types";

/**
 * - confirm: a quote the person wrote; the words are the key's.
 * - ai: the model's citation; the words are the model's, the claim stays.
 * - remove: no quote; the words keep the authors who typed them.
 * - human: no quote; the words are a human island (in an AI region only).
 */
export type Clarification = "confirm" | "ai" | "remove" | "human";

export interface QuoteRef {
  /** `「…」[@key]` on a line, or a cited blockquote. */
  kind: "inline" | "block";
  /** Inline: from the opening mark to the end of `[@key]`. Block: from its first line to its `[@key]` line. */
  from: number;
  to: number;
  key: string;
  /** Inline: the closing mark. Block: the start of the `[@key]` line. */
  close: number;
  /** In an AI region (an AI block, or inside an inline AI span), where words can be a human island. */
  inAI: boolean;
  /** Its parts have different writers: the parser warns until it is clarified. */
  mixed: boolean;
}

/** The choices that make sense for `q`: a human island exists in an AI region only. */
export function clarifications(q: QuoteRef): Clarification[] {
  return q.inAI ? ["confirm", "ai", "remove", "human"] : ["confirm", "ai", "remove"];
}

/** Every quote of the note, inline and block, in order. */
export function quotesOf(r: ParseResult): QuoteRef[] {
  const out: QuoteRef[] = [];
  const lineOf = (pos: number) => indexAt(r.lines, pos, true);
  const mixedAt = new Set(r.diagnostics.filter((d) => d.code === "mixed-quote").map((d) => d.from));
  const aiSpans = r.spans.filter((s) => s.type === "marker" && s.attr.kind === "ai");
  const inAI = (from: number, to: number) =>
    r.lineContexts[lineOf(from)]?.pair === "ai-block" || aiSpans.some((s) => s.contentFrom <= from && to <= s.contentTo);
  const inline = (from: number, close: number, to: number, key: string) =>
    out.push({ kind: "inline", from, to, key, close, inAI: inAI(from, to), mixed: mixedAt.has(from) });

  for (const s of r.spans) if (s.type === "quote" && s.attr.key) inline(s.from, s.contentTo, s.to, s.attr.key);
  for (const c of r.claims) {
    const line = lineOf(c.cite.from);
    if (lineOf(c.from) === line && c.from > r.lines[line].from) inline(c.from - 1, c.to, c.cite.to, c.key);
    else out.push({ kind: "block", from: c.from, to: r.lines[line].to, key: c.key, close: r.lines[line].from, inAI: true, mixed: false });
  }
  // Cited blockquotes outside AI blocks: their lines read `@@` and `&&` as a quote does.
  for (let i = 0; i < r.lines.length; i++) {
    if (r.lineContexts[i].pair !== "quote") continue;
    let j = i;
    while (j + 1 < r.lines.length && r.lineContexts[j + 1].pair === "quote") j++;
    const key = /\[@([^\s[\]]+)\]\s*$/.exec(r.text.slice(r.lines[j].from, r.lines[j].to))?.[1];
    if (key && j > i) out.push({ kind: "block", from: r.lines[i].from, to: r.lines[j].to, key, close: r.lines[j].from, inAI: false, mixed: false });
    i = j;
  }
  return out.sort((a, b) => a.from - b.from || b.to - a.to);
}

/** The innermost quote at `pos`, or null. */
export function quoteAt(r: ParseResult, pos: number): QuoteRef | null {
  let best: QuoteRef | null = null;
  for (const q of quotesOf(r)) if (q.from <= pos && pos <= q.to && (!best || q.to - q.from <= best.to - best.from)) best = q;
  return best;
}

/** The next quote after `pos` that waits to be clarified, from the top again past the last; or null. */
export function nextMixedQuote(r: ParseResult, pos: number): QuoteRef | null {
  const mixed = quotesOf(r).filter((q) => q.mixed);
  return mixed.find((q) => q.from > pos) ?? mixed[0] ?? null;
}

export interface Change {
  from: number;
  to: number;
  insert: string;
}

export interface ClarifyOptions {
  /** The opening line of an AI block written around a blockquote marked as the model's citation. */
  blockOpener?: string;
}

/** A pair of markers that would pair up where it is written: escaped, so that it shows as it is. */
const escapeMarkers = (s: string) =>
  s.replace(/(\\*)(&+|@+)/g, (m, bs: string, run: string) => (run.length === 2 && bs.length % 2 === 0 ? `${bs}\\${run}` : m));

const ownerOf = (a: Attr): { owner: Owner; key?: string } =>
  a.kind === "ai" ? { owner: "ai", ...(a.explicit && a.key ? { key: a.key } : {}) } : { owner: "human" };

/** What `q` becomes when clarified as `how`, or null when the note can't be written that way. */
export function clarifyQuote(r: ParseResult, q: QuoteRef, how: Clarification, opts: ClarifyOptions = {}): Change | null {
  if (!clarifications(q).includes(how)) return null;
  const c = q.kind === "inline" ? clarifyInline(r, q, how) : clarifyBlock(r, q, how, opts);
  if (!c) return null;
  const after = r.text.slice(0, c.from) + c.insert + r.text.slice(c.to);
  return sameOutside(r.text, q, how, after) ? c : null;
}

/** Why no choice can be written: a lone marker by the quote, or something else in how it is written. */
export type ClarifyRefusal = "unpaired-marker" | "other";

/** Each choice for `q` that can be written, with its change; when there is none, why. */
export function clarifyOptions(
  r: ParseResult,
  q: QuoteRef,
  opts: ClarifyOptions = {},
): { choices: Array<{ how: Clarification; change: Change }>; refusal?: ClarifyRefusal } {
  const choices: Array<{ how: Clarification; change: Change }> = [];
  for (const how of clarifications(q)) {
    const change = clarifyQuote(r, q, how, opts);
    if (change) choices.push({ how, change });
  }
  if (choices.length) return { choices };
  const first = indexAt(r.lines, q.from);
  const last = indexAt(r.lines, q.to, true);
  const lone = lint(r).some((i) => (i.code === "unpaired-marker" || i.code === "inert-marker") && i.line >= first && i.line <= last);
  return { choices, refusal: lone ? "unpaired-marker" : "other" };
}

/** Every visible character with its author; whitespace is nobody's. */
function visible(text: string): Array<{ at: number; ch: string; who: string }> {
  const out: Array<{ at: number; ch: string; who: string }> = [];
  for (const s of parse(text).segments) {
    if (s.role !== "text") continue;
    for (let k = s.from; k < s.to; k++) {
      const ch = text[k];
      // A backslash that keeps a pair of markers from pairing shows nothing.
      if (ch === "\\" && /^(&&|@@)/.test(text.slice(k + 1))) continue;
      out.push({ at: k, ch, who: /\s/.test(ch) ? "" : `${s.attr.kind}${s.attr.key ?? ""}${s.attr.explicit ? "!" : ""}` });
    }
  }
  return out;
}

/**
 * Clarifying a quote leaves every word outside it as it was, the note's structure included, and shows
 * nothing new: what is shown in its place is the quote (a, b), or its words (c, d).
 */
function sameOutside(before: string, q: QuoteRef, how: Clarification, after: string): boolean {
  const was = visible(before);
  const now = visible(after);
  const head = was.filter((x) => x.at < q.from);
  const tail = was.filter((x) => x.at >= q.to);
  if (now.length < head.length + tail.length) return false;
  const same = (x: { ch: string; who: string }, y: { ch: string; who: string }) => x.ch === y.ch && x.who === y.who;
  if (!head.every((x, i) => same(x, now[i]))) return false;
  if (!tail.every((x, i) => same(x, now[now.length - tail.length + i]))) return false;
  const ink = (xs: typeof was) => xs.filter((x) => x.who).map((x) => x.ch).join("");
  const from = how === "remove" || how === "human" ? (q.kind === "inline" ? q.from + 1 : q.from) : q.from;
  const to = how === "remove" || how === "human" ? q.close : q.to;
  return ink(now.slice(head.length, now.length - tail.length)) === ink(was.filter((x) => x.at >= from && x.at < to));
}

// ── Inline quotes ────────────────────────────────────────────────────────────

/** Attribution and roles of every character of a line's content, read as the parser reads it there. */
function readLine(content: string, ctx: LineContext): { attr: Attr[]; mark: boolean[] } {
  const res = parseLine(content, { base: ctx.base, pair: ctx.pair, mode: "prose", ampLen: 2, atLen: 2, inComment: ctx.inComment });
  const attr = new Array<Attr>(content.length).fill(ctx.base);
  const mark = new Array<boolean>(content.length).fill(false);
  for (const s of res.segments)
    for (let k = s.from; k < s.to; k++) {
      attr[k] = s.attr;
      mark[k] = s.role === "mark";
    }
  return { attr, mark };
}

function clarifyInline(r: ParseResult, q: QuoteRef, how: Clarification): Change | null {
  const li = indexAt(r.lines, q.from);
  const ctx = r.lineContexts[li];
  const line = r.text.slice(r.lines[li].from, r.lines[li].to);
  const base = r.lines[li].from + ctx.prefix;
  const content = line.slice(ctx.prefix);
  const open = q.from - base;
  const close = q.close - base;
  const end = q.to - base;
  const { attr, mark } = readLine(content, ctx);
  const words: number[] = [];
  for (let k = open + 1; k < close; k++) if (!mark[k]) words.push(k);

  // Who typed each word. A mixed quote's markers pair with the text around it, as they do with no
  // `[@key]` there; in any other, the quote's own words are its writer's, the text around its opening mark.
  let typed: Attr[] = attr;
  if (q.mixed) {
    const cite = content.lastIndexOf("[@", end);
    typed = readLine(content.slice(0, cite) + "x".repeat(end - cite) + content.slice(end), ctx).attr;
  }
  const typist = (k: number) => ownerOf(typed[k].kind === "quote" ? attr[open] : typed[k]);

  // The model, for its citation: whoever wrote AI text in or around the quote, or the AI span it is in.
  let model: string | undefined;
  for (let k = open; k < end && model === undefined; k++) if (typed[k].kind === "ai" && typed[k].explicit) model = typed[k].key;
  if (model === undefined) model = r.spans.find((s) => s.type === "marker" && s.attr.kind === "ai" && s.contentFrom <= q.from && q.to <= s.contentTo)?.attr.key;

  const text = escapeMarkers(words.map((k) => content[k]).join(""));
  const quote = content[open] + text + content.slice(close, end);
  const unit = (owner: Owner, key?: string): Char[] =>
    Array.from(quote, (ch, i) => ({ ch, owner, ...(key ? { key } : {}), at: open + i, orig: owner + (key ?? ""), fixed: true as const, unit: open }));
  const plain = (who: (k: number) => { owner: Owner; key?: string }): Char[] =>
    words.map((k) => {
      const w = who(k);
      return { ch: content[k], owner: w.owner, ...(w.key ? { key: w.key } : {}), at: k, orig: w.owner + (w.key ?? "") };
    });
  let by: Char[];
  switch (how) {
    case "confirm":
      by = unit("human");
      break;
    case "ai":
      by = unit("ai", model);
      break;
    case "remove":
      by = plain(typist);
      break;
    case "human":
      by = plain(() => ({ owner: "human" }));
      break;
  }

  // The marker pairs on the line, in content offsets.
  const lineTo = r.lines[li].to;
  const spans = r.spans
    .filter((s) => s.from >= base && s.to <= lineTo)
    .map((s) => ({ ...s, from: s.from - base, to: s.to - base, contentFrom: s.contentFrom - base, contentTo: s.contentTo - base }));
  // What is rewritten: the quote, and every pair of markers that crosses it (or crosses one that does).
  let region = { from: open, to: end };
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of spans) {
      if (s.type !== "marker" || s.to <= region.from || s.from >= region.to) continue;
      if ((s.from <= region.from && region.to <= s.to) || (region.from <= s.from && s.to <= region.to)) continue;
      region = { from: Math.min(region.from, s.from), to: Math.max(region.to, s.to) };
      grew = true;
    }
  }
  // It is rewritten in what holds it: an inline AI span reads markers as an AI block does. Where it can't
  // be written there (a human island holds no markers), what holds it is rewritten too, and so on out.
  const around = spans
    .filter((s) => s.contentFrom <= region.from && region.to <= s.contentTo && s.from < region.from)
    .sort((x, y) => x.to - x.from - (y.to - y.from));
  // Last, the whole line: a region written next to a lone `@@` or `&&` may run into it.
  const levels: Array<(typeof around)[number] | null | "line"> = [...around, null, "line"];
  for (const level of levels) {
    if (level === "line") region = { from: 0, to: content.length };
    const s = level === "line" ? null : level;
    if (s && !(s.type === "marker" && s.attr.kind === "ai")) {
      region = { from: s.from, to: s.to };
      continue;
    }
    const rctx: LineContext = s ? { ...ctx, base: { kind: "ai", explicit: false }, pair: "ai-block", prefix: 0 } : { ...ctx, prefix: 0 };
    const shift = region.from;
    const src = content.slice(region.from, region.to);
    let out: string | null = null;
    try {
      out =
        rewriteLineDetailed(
          src,
          rctx,
          (chars) => {
            const first = chars.findIndex((c) => c.unit === open - shift);
            if (first < 0) throw new Error("no such quote");
            let last = first;
            while (last + 1 < chars.length && chars[last + 1].unit === open - shift) last++;
            chars.splice(first, last - first + 1, ...by.map((c) => ({ ...c, at: c.at - shift, ...(c.unit !== undefined ? { unit: c.unit - shift } : {}) })));
          },
          { units: true },
        )?.text ?? null;
    } catch {
      out = null;
    }
    if (out !== null) {
      let next = content.slice(0, region.from) + out + content.slice(region.to);
      let changed = { from: region.from, to: region.from + out.length, was: region.to };
      // An AI span left with no AI text in it is no AI span: its human islands become plain text.
      if (s && how !== "human" && ctx.pair === "human") {
        const delta = out.length - (region.to - region.from);
        const inner = next.slice(s.contentFrom, s.contentTo + delta);
        const read = parseLine(inner, { base: { kind: "ai", explicit: false }, pair: "ai-block", mode: "prose", ampLen: 2, atLen: 2, inComment: ctx.inComment });
        const aiLeft = read.segments.some((g) => g.role === "text" && g.attr.kind === "ai" && inner.slice(g.from, g.to).trim());
        if (!aiLeft) {
          let flat = "";
          for (const g of read.segments) {
            const islandMark = g.role === "mark" && (g.mark === "open" || g.mark === "close") && g.attr.kind === "human" && !inQuote(read.spans, g.from);
            if (!islandMark) flat += inner.slice(g.from, g.to);
          }
          next = next.slice(0, s.from) + flat + next.slice(s.to + delta);
          changed = { from: s.from, to: s.from + flat.length, was: s.to };
        }
      }
      // A line that now reads as `&& Name` or `&&` would open or close an AI block.
      if (blockLine(line.slice(0, ctx.prefix) + next)) {
        const lead = /^[ \t]*/.exec(next)![0].length;
        next = `${next.slice(0, lead)}\\${next.slice(lead)}`;
        changed = { ...changed, from: 0, to: changed.to + 1 };
      }
      if (verify(content, next, ctx, changed, q, how, by)) return { from: base, to: lineTo, insert: next };
    }
    if (s) region = { from: s.from, to: s.to };
  }
  return null;
}

/** Whether `pos` lies inside a quote's text. */
const inQuote = (spans: ReadonlyArray<{ type: string; contentFrom: number; contentTo: number }>, pos: number) =>
  spans.some((s) => s.type === "quote" && s.contentFrom <= pos && pos < s.contentTo);

/** Every visible character's author, as a string to compare. */
function authors(content: string, ctx: LineContext, from: number, to: number): string {
  const { attr, mark } = readLine(content, ctx);
  let out = "";
  for (let k = from; k < to; k++) {
    if (mark[k]) continue;
    const a = attr[k];
    out += `${content[k]}${a.kind[0]}${a.explicit ? "!" : ""}${a.key ?? ""}|`;
  }
  return out;
}

/** The rewritten line leaves every other word's author alone, and does what was asked to the quote. */
function verify(
  before: string,
  after: string,
  ctx: LineContext,
  changed: { from: number; to: number; was: number },
  q: QuoteRef,
  how: Clarification,
  by: ReadonlyArray<{ ch: string; owner: Owner; key?: string }>,
): boolean {
  if (authors(before, ctx, 0, changed.from) !== authors(after, ctx, 0, changed.from)) return false;
  if (authors(before, ctx, changed.was, before.length) !== authors(after, ctx, changed.to, after.length)) return false;
  const res = parseLine(after, { base: ctx.base, pair: ctx.pair, mode: "prose", ampLen: 2, atLen: 2, inComment: ctx.inComment });
  if (res.diagnostics.some((d) => d.code === "mixed-quote" && d.from < changed.to && d.to > changed.from)) return false;
  const within = (x: { from: number; to: number }) => x.from >= changed.from && x.to <= changed.to;
  const quoteHere = res.spans.some((s) => s.type === "quote" && s.attr.key === q.key && within(s));
  const claimHere = res.claims.some((c) => c.key === q.key && within({ from: c.from - 1, to: c.cite.to }));
  // What is left of the quote's words, in the rewritten part.
  const { attr, mark } = readLine(after, ctx);
  const shown: Attr[] = [];
  for (let k = changed.from; k < changed.to; k++) {
    // A backslash that keeps a pair of markers from pairing is no word.
    if (mark[k] || /\s/.test(after[k]) || (after[k] === "\\" && /^(&&|@@)/.test(after.slice(k + 1)))) continue;
    shown.push(attr[k]);
  }
  switch (how) {
    case "confirm":
      return quoteHere;
    case "ai":
      return claimHere && !quoteHere;
    case "remove":
    case "human": {
      // Every word keeps who typed it (with d, the person's, in an island), and the text around keeps its
      // own (outside `changed`, checked above; inside it, by `sameOutside`).
      if (shown.some((a) => a.kind === "quote")) return false;
      const want = by.filter((c) => !/\s/.test(c.ch));
      const sameAuthor = (a: Attr, w: { owner: Owner; key?: string }) =>
        how === "human"
          ? a.kind === "human" && a.explicit
          : a.kind === (w.owner === "ai" ? "ai" : "human") && (w.owner !== "ai" || !w.key || a.key === w.key);
      // The rewritten part may hold text around the quote as well: the words are somewhere in it, in order.
      let i = 0;
      for (const a of shown) if (i < want.length && sameAuthor(a, want[i])) i++;
      if (i < want.length) return false;
      const count = (t: string) => {
        const p = parseLine(t, { base: ctx.base, pair: ctx.pair, mode: "prose", ampLen: 2, atLen: 2, inComment: ctx.inComment });
        return p.spans.filter((s) => s.type === "quote" && s.attr.key === q.key).length + p.claims.filter((c) => c.key === q.key).length;
      };
      return count(after) < count(before);
    }
  }
}

// ── Cited blockquotes ────────────────────────────────────────────────────────

const BLANK = /^[ \t]*$/;
/** One level of blockquote marker. */
const QUOTE_MARK = /^ {0,3}>[ \t]?/;

function clarifyBlock(r: ParseResult, q: QuoteRef, how: Clarification, opts: ClarifyOptions): Change | null {
  const first = indexAt(r.lines, q.from);
  const citeLine = indexAt(r.lines, q.close);
  const lineText = (i: number) => r.text.slice(r.lines[i].from, r.lines[i].to);
  const blank = (i: number) => i < 0 || i >= r.lines.length || BLANK.test(lineText(i));
  const segsOf = (i: number) => r.segments.filter((s) => s.from >= r.lines[i].from && s.to <= r.lines[i].to);
  const inBlock = q.inAI;

  /** The line with its markers taken out, and any pair of markers left in its words escaped. */
  const unmarked = (i: number) => {
    if (r.lineContexts[i].mode !== "prose") return lineText(i);
    let out = "";
    let words = "";
    for (const s of segsOf(i)) {
      if (s.role === "mark") continue;
      const t = r.text.slice(s.from, s.to);
      if (s.role === "text") words += t;
      else {
        out += escapeMarkers(words) + t;
        words = "";
      }
    }
    return out + escapeMarkers(words);
  };
  /** The line without its blockquote marker, its words owned as `who` says. */
  const unquoted = (i: number, who: (a: Attr) => { owner: Owner; key?: string }): string | null => {
    const t = lineText(i);
    const cut = QUOTE_MARK.exec(t)?.[0].length ?? 0;
    const ctx = r.lineContexts[i];
    if (ctx.mode !== "prose") return t.slice(cut);
    const chars: Array<{ ch: string; owner: Owner; key?: string }> = [];
    const from = r.lines[i].from;
    for (const s of segsOf(i)) {
      if (s.role === "mark") continue;
      for (let k = Math.max(s.from, from + cut); k < s.to; k++) chars.push({ ch: r.text[k], ...who(s.attr) });
    }
    const outCtx: LineContext = inBlock ? { ...ctx, pair: "ai-block" } : { ...ctx, base: { kind: "human", explicit: false }, pair: "human" };
    const out = writeLine("", chars, outCtx);
    // Out of the blockquote, a line that reads as `&& Name` or `&&` would open or close an AI block.
    if (out === null || !blockLine(out)) return out;
    return out.replace(/^([ \t]*)(&&)/, "$1\\$2");
  };
  const range = (a: number, b: number, insert: string): Change => ({ from: r.lines[a].from, to: r.lines[b].to, insert });
  const body = () => {
    const out: string[] = [];
    for (let i = first; i < citeLine; i++) out.push(unmarked(i));
    out.push(lineText(citeLine));
    return out.join("\n");
  };
  const lines = (who: (a: Attr) => { owner: Owner; key?: string }) => {
    const out: string[] = [];
    for (let i = first; i < citeLine; i++) {
      const l = unquoted(i, who);
      if (l === null) return null;
      out.push(l);
    }
    return out.join("\n");
  };

  if (!inBlock) {
    switch (how) {
      case "confirm":
        return range(first, citeLine, body());
      case "ai": {
        const opener = opts.blockOpener?.trim() ? `&& ${opts.blockOpener.trim().replace(/^&&\s*/, "")}` : "&& AI";
        const before = blank(first - 1) ? "" : "\n";
        const after = blank(citeLine + 1) ? "" : "\n";
        return range(first, citeLine, `${before}${opener}\n\n${body()}\n\n&&${after}`);
      }
      case "remove": {
        // The words were typed by the person; `&&` inside keeps what the model wrote.
        const out = lines((a) => (a.kind === "ai" ? ownerOf(a) : { owner: "human" }));
        return out === null ? null : range(first, citeLine, out);
      }
      default:
        return null;
    }
  }

  const block = r.blocks.find((b) => b.openLine < first && citeLine <= b.lastLine);
  if (!block) return null;
  switch (how) {
    case "confirm": {
      // The `[@key]` line must be the person's: the blockquote leaves the AI block, which goes on after it.
      const opener = lineText(block.openLine);
      const end = block.closeLine ?? block.lastLine + 1;
      const emptyBefore = Array.from({ length: first - block.openLine - 1 }, (_, k) => block.openLine + 1 + k).every(blank);
      const emptyAfter = Array.from({ length: Math.max(0, end - citeLine - 1) }, (_, k) => citeLine + 1 + k).every(blank);
      const quote = body();
      if (emptyBefore && emptyAfter) return range(block.openLine, block.closeLine ?? block.lastLine, quote);
      if (emptyBefore) return range(block.openLine, citeLine, `${quote}\n\n${opener}${blank(citeLine + 1) ? "" : "\n"}`);
      if (emptyAfter) {
        const last = block.closeLine ?? citeLine;
        return range(first, last, `${blank(first - 1) ? "" : "\n"}&&\n\n${quote}`);
      }
      return range(first, citeLine, `${blank(first - 1) ? "" : "\n"}&&\n\n${quote}\n\n${opener}${blank(citeLine + 1) ? "" : "\n"}`);
    }
    case "ai":
      return range(first, citeLine, body());
    case "remove": {
      const out = lines(ownerOf);
      return out === null ? null : range(first, citeLine, out);
    }
    case "human": {
      const out = lines(() => ({ owner: "human" }));
      return out === null ? null : range(first, citeLine, out);
    }
  }
}
