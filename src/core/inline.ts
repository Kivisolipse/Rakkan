// Inline scanning: one line at a time, character by character (no lookbehind
// regexes, so it runs on old iOS WebKit too).

import type { Attr, DiagnosticCode, InlineSpan, MarkType, Role } from "./types";

export type SkipType = "code" | "math" | "comment" | "url";

export interface Range {
  from: number;
  to: number;
}

export interface Skip extends Range {
  type: SkipType;
}

export interface Token extends Range {
  type: "amp" | "at";
}

export interface Cite extends Range {
  key: string;
}

export interface InlineScan {
  skips: Skip[];
  tokens: Token[];
  /** Runs of marker characters that are not markers (wrong length, escaped, entity). */
  literals: Range[];
  cites: Cite[];
  endsInComment: boolean;
  mathSwallow: Range[];
}

export interface ScanOptions {
  /** Marker length for `&`; 0 disables. */
  ampLen: number;
  /** Marker length for `@`; 0 disables. */
  atLen: number;
  /** Detect code, math, comments, URLs, escapes and cites (prose). False inside code blocks. */
  prose: boolean;
  inComment?: boolean;
  /** Start offsets of runs that must stay literal (reading view: escapes already consumed). */
  literalRuns?: ReadonlySet<number>;
  /**
   * Text already rendered to HTML (reading view): code, math, comments and
   * escapes are gone or replaced by placeholders, so only markers, URLs and
   * cites are scanned.
   */
  rendered?: boolean;
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "　";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isAsciiWord = (c: string) => /[A-Za-z0-9_]/.test(c);

function runLength(text: string, i: number): number {
  const c = text[i];
  let j = i;
  while (j < text.length && text[j] === c) j++;
  return j - i;
}

/** `&` followed by an HTML entity name, e.g. `&amp;` `&#38;`. */
function entityAt(text: string, i: number): boolean {
  if (text[i] !== "&") return false;
  let j = i + 1;
  if (text[j] === "#") j++;
  const start = j;
  while (j < text.length && /[A-Za-z0-9]/.test(text[j])) j++;
  return j > start && text[j] === ";";
}

function hasMarkerRun(text: string, from: number, to: number): boolean {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === "&" || c === "@") {
      let j = i;
      while (j < to && text[j] === c) j++;
      if (j - i === 2) return true;
      i = j;
    } else i++;
  }
  return false;
}

/** Find the `)` closing a link destination that starts at `open` (`(`). */
function linkDestinationEnd(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

function urlEnd(text: string, i: number): number {
  let j = i;
  let parens = 0;
  while (j < text.length) {
    const c = text[j];
    const code = c.charCodeAt(0);
    if (isSpace(c) || c === "<" || c === ">" || c === '"' || code > 0x7e || code < 0x21) break;
    if (c === "(") parens++;
    else if (c === ")") {
      if (parens === 0) break;
      parens--;
    }
    j++;
  }
  // Trailing punctuation is usually sentence punctuation.
  while (j > i && /[.,;:!?]/.test(text[j - 1])) j--;
  return j;
}

function startsWithCI(text: string, i: number, s: string): boolean {
  return text.slice(i, i + s.length).toLowerCase() === s;
}

export function scanInline(text: string, opts: ScanOptions): InlineScan {
  const out: InlineScan = {
    skips: [],
    tokens: [],
    literals: [],
    cites: [],
    endsInComment: false,
    mathSwallow: [],
  };
  const n = text.length;
  let i = 0;

  if (opts.prose && opts.inComment) {
    const close = text.indexOf("%%");
    if (close < 0) {
      out.skips.push({ from: 0, to: n, type: "comment" });
      out.endsInComment = true;
      return out;
    }
    out.skips.push({ from: 0, to: close + 2, type: "comment" });
    i = close + 2;
  }

  while (i < n) {
    const c = text[i];

    if (c === "&" || c === "@") {
      const len = runLength(text, i);
      const want = c === "&" ? opts.ampLen : opts.atLen;
      const literal =
        want === 0 ||
        len !== want ||
        (opts.literalRuns?.has(i) ?? false) ||
        (c === "&" && opts.prose && entityAt(text, i + len - 1));
      if (literal) out.literals.push({ from: i, to: i + len });
      else out.tokens.push({ from: i, to: i + len, type: c === "&" ? "amp" : "at" });
      i += len;
      continue;
    }

    if (!opts.prose) {
      i++;
      continue;
    }

    if (c === "\\" && !opts.rendered) {
      const next = text[i + 1];
      if (next === "&" || next === "@") {
        // `\&&` escapes the whole run.
        const len = runLength(text, i + 1);
        out.literals.push({ from: i + 1, to: i + 1 + len });
        i += 1 + len;
      } else i += 2;
      continue;
    }

    if (c === "`" && !opts.rendered) {
      const len = runLength(text, i);
      let j = i + len;
      let close = -1;
      while (j < n) {
        if (text[j] === "`") {
          const l = runLength(text, j);
          if (l === len) {
            close = j;
            break;
          }
          j += l;
        } else j++;
      }
      if (close >= 0) {
        out.skips.push({ from: i, to: close + len, type: "code" });
        i = close + len;
      } else i += len;
      continue;
    }

    if (c === "%" && text[i + 1] === "%" && !opts.rendered) {
      const close = text.indexOf("%%", i + 2);
      if (close < 0) {
        out.skips.push({ from: i, to: n, type: "comment" });
        out.endsInComment = true;
        return out;
      }
      out.skips.push({ from: i, to: close + 2, type: "comment" });
      i = close + 2;
      continue;
    }

    if (c === "$" && !opts.rendered) {
      if (text[i + 1] === "$") {
        const close = text.indexOf("$$", i + 2);
        if (close >= 0) {
          out.skips.push({ from: i, to: close + 2, type: "math" });
          i = close + 2;
        } else i += 2;
        continue;
      }
      // Pandoc rules: no space after the opener; the closer has no space
      // before it and no digit after it.
      const after = text[i + 1];
      if (after !== undefined && !isSpace(after)) {
        let close = -1;
        for (let j = i + 1; j < n; j++) {
          if (text[j] === "\\") {
            j++;
            continue;
          }
          if (text[j] !== "$") continue;
          const before = text[j - 1];
          const next = text[j + 1];
          if (j > i + 1 && !isSpace(before) && !(next !== undefined && isDigit(next))) {
            close = j;
            break;
          }
        }
        if (close >= 0) {
          out.skips.push({ from: i, to: close + 1, type: "math" });
          if (hasMarkerRun(text, i + 1, close)) out.mathSwallow.push({ from: i, to: close + 1 });
          i = close + 1;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === "]" && text[i + 1] === "(") {
      const end = linkDestinationEnd(text, i + 1);
      if (end > 0) {
        out.skips.push({ from: i + 1, to: end, type: "url" });
        i = end;
        continue;
      }
      i++;
      continue;
    }

    if (
      (c === "h" || c === "H") &&
      (startsWithCI(text, i, "http://") || startsWithCI(text, i, "https://")) &&
      (i === 0 || !isAsciiWord(text[i - 1]))
    ) {
      const end = urlEnd(text, i);
      out.skips.push({ from: i, to: end, type: "url" });
      i = end;
      continue;
    }

    if (c === "[" && text[i + 1] === "@") {
      let j = i + 2;
      while (j < n && !isSpace(text[j]) && text[j] !== "[" && text[j] !== "]") j++;
      if (j > i + 2 && text[j] === "]" && text[j + 1] !== "(" && text[j + 1] !== ":") {
        out.cites.push({ from: i, to: j + 1, key: text.slice(i + 2, j) });
        i = j + 1;
        continue;
      }
      i++;
      continue;
    }

    i++;
  }
  return out;
}

// ── Attribution ──────────────────────────────────────────────────────────

/** Pairing context: which markers are active at this level. */
export type PairCtx = "human" | "ai-inline" | "ai-block" | "quote" | "island";

function isActive(ctx: PairCtx, type: Token["type"]): boolean {
  switch (ctx) {
    case "human":
      return type === "amp";
    case "ai-inline":
    case "ai-block":
      return type === "at";
    case "quote":
      return true;
    case "island":
      return false;
  }
}

interface Pair {
  open: Token;
  close: Token;
  ctx: PairCtx; // the context inside the pair
  children: Pair[];
}

/** Same-type markers pair left to right; a pair opened later that crosses an earlier one stays literal. */
export function pairTokens(tokens: Token[], ctx: PairCtx): Pair[] {
  const pairs: Pair[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!isActive(ctx, t.type)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < tokens.length && tokens[j].type !== t.type) j++;
    if (j >= tokens.length) {
      i++;
      continue;
    }
    const inner: PairCtx = t.type === "amp" ? "ai-inline" : "island";
    pairs.push({
      open: t,
      close: tokens[j],
      ctx: inner,
      children: pairTokens(tokens.slice(i + 1, j), inner),
    });
    i = j + 1;
  }
  return pairs;
}

const QUOTE_OPEN: Record<string, string> = { "」": "「", "』": "『", "”": "“" };

interface Quote {
  open: number; // index of the opening quote char
  close: number; // index of the closing quote char
  cite: Cite;
}

function inRanges(ranges: Range[], pos: number): boolean {
  for (const r of ranges) if (pos >= r.from && pos < r.to) return true;
  return false;
}

function findQuoteOpen(text: string, close: number, skips: Range[]): number {
  const closeChar = text[close];
  if (closeChar === '"') {
    for (let j = close - 1; j >= 0; j--) {
      if (text[j] === '"' && !inRanges(skips, j)) return j;
    }
    return -1;
  }
  const openChar = QUOTE_OPEN[closeChar];
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    if (inRanges(skips, j)) continue;
    if (text[j] === closeChar) depth++;
    else if (text[j] === openChar) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

export interface LineCtx {
  base: Attr;
  pair: "human" | "ai-block" | "quote";
  /** prose: full inline syntax; code: declared markers only; plain: nothing. */
  mode: "prose" | "code" | "plain";
  ampLen: number;
  atLen: number;
  inComment: boolean;
  literalRuns?: ReadonlySet<number>;
  rendered?: boolean;
}

export interface LineSegment {
  from: number;
  to: number;
  role: Role;
  attr: Attr;
  mark?: MarkType;
}

export interface LineResult {
  segments: LineSegment[];
  spans: InlineSpan[];
  diagnostics: Array<{ from: number; to: number; code: DiagnosticCode; message: string }>;
  endsInComment: boolean;
}

function compact(
  n: number,
  role: Role[],
  attr: Attr[],
  mark: (MarkType | undefined)[],
): LineSegment[] {
  const segs: LineSegment[] = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (
      i === n ||
      role[i] !== role[start] ||
      attr[i] !== attr[start] ||
      mark[i] !== mark[start]
    ) {
      const seg: LineSegment = { from: start, to: i, role: role[start], attr: attr[start] };
      if (mark[start]) seg.mark = mark[start];
      segs.push(seg);
      start = i;
    }
  }
  return segs;
}

export function parseLine(text: string, ctx: LineCtx): LineResult {
  const n = text.length;
  const role = new Array<Role>(n).fill("text");
  const attr = new Array<Attr>(n).fill(ctx.base);
  const mark = new Array<MarkType | undefined>(n).fill(undefined);
  const result: LineResult = { segments: [], spans: [], diagnostics: [], endsInComment: false };

  if (ctx.mode === "plain" || n === 0) {
    result.segments = n ? [{ from: 0, to: n, role: "text", attr: ctx.base }] : [];
    return result;
  }

  const prose = ctx.mode === "prose";
  const scan = scanInline(text, {
    ampLen: prose ? 2 : ctx.ampLen,
    atLen: prose ? 2 : ctx.atLen,
    prose,
    inComment: ctx.inComment,
    literalRuns: ctx.literalRuns,
    rendered: ctx.rendered,
  });
  result.endsInComment = scan.endsInComment;

  for (const s of scan.skips) {
    if (s.type === "comment") for (let k = s.from; k < s.to; k++) role[k] = "meta";
  }
  for (const m of scan.mathSwallow) {
    result.diagnostics.push({
      from: m.from,
      to: m.to,
      code: "math-swallow",
      message: "署名标记被公式吞没：此处的 $ 可能是金额，请写作 \\$",
    });
  }

  const citeAt = new Map<number, Cite>();
  for (const c of scan.cites) citeAt.set(c.from, c);
  const usedCites = new Set<Cite>();

  // Quotes: `「…」[@key]`, `"…"[@key]`.
  const quotes: Quote[] = [];
  if (prose) {
    for (const cite of scan.cites) {
      let p = cite.from - 1;
      if (p >= 0 && text[p] === " ") p--;
      if (p < 0) continue;
      const ch = text[p];
      if (ch !== '"' && !(ch in QUOTE_OPEN)) continue;
      if (inRanges(scan.skips, p)) continue;
      const open = findQuoteOpen(text, p, scan.skips);
      if (open < 0) continue;
      const q: Quote = { open, close: p, cite };
      // Drop quotes that cross an accepted quote; nesting is fine.
      const crosses = quotes.some(
        (a) =>
          !(q.close < a.open || q.open > a.close) &&
          !(q.open > a.open && q.close < a.close) &&
          !(a.open > q.open && a.close < q.close),
      );
      if (crosses) continue;
      quotes.push(q);
      usedCites.add(cite);
    }
    quotes.sort((a, b) => a.open - b.open);
  }

  // Assign each token to the innermost quote whose content contains it.
  const zoneOf = (t: Token): number => {
    let best = -1;
    for (let qi = 0; qi < quotes.length; qi++) {
      const q = quotes[qi];
      if (t.from > q.open && t.to <= q.close) {
        if (best < 0 || quotes[best].open < q.open) best = qi;
      }
    }
    return best;
  };
  const zones = new Map<number, Token[]>();
  for (const t of scan.tokens) {
    const z = zoneOf(t);
    let list = zones.get(z);
    if (!list) zones.set(z, (list = []));
    list.push(t);
  }

  const fill = (from: number, to: number, a: Attr) => {
    for (let k = from; k < to; k++) attr[k] = a;
  };
  const setMark = (from: number, to: number, m: MarkType, a: Attr) => {
    for (let k = from; k < to; k++) {
      role[k] = "mark";
      mark[k] = m;
      attr[k] = a;
    }
  };

  const applyPairs = (pairs: Pair[], outer: Attr) => {
    for (const p of pairs) {
      // `&&…&&[@key]`, at most one space between.
      let cite: Cite | undefined = citeAt.get(p.close.to);
      if (!cite && text[p.close.to] === " ") cite = citeAt.get(p.close.to + 1);
      if (cite && usedCites.has(cite)) cite = undefined;
      const a: Attr =
        p.ctx === "ai-inline"
          ? { kind: "ai", explicit: true }
          : { kind: "human", explicit: true };
      if (outer.block !== undefined) a.block = outer.block;
      if (cite) {
        a.key = cite.key;
        usedCites.add(cite);
      }
      fill(p.open.to, p.close.from, a);
      setMark(p.open.from, p.open.to, "open", a);
      setMark(p.close.from, p.close.to, "close", a);
      if (cite) setMark(cite.from, cite.to, "cite", a);
      result.spans.push({
        from: p.open.from,
        to: cite ? cite.to : p.close.to,
        contentFrom: p.open.to,
        contentTo: p.close.from,
        attr: a,
        type: "marker",
      });
      applyPairs(p.children, a);
    }
  };

  const top = zones.get(-1) ?? [];
  const topPairs = pairTokens(top, ctx.pair);
  applyPairs(topPairs, ctx.base);

  // In code a declared run is meant as a marker: the declaration chose a length
  // the code does not use. Runs with nothing to mark at this level (`&&&` in an
  // AI block, `@@` in a human region) still pair, as markers that change no
  // owner, so they are hidden, copied and stripped like any other. Inside an
  // island they stay literal, as in prose: islands do not nest.
  if (!prose) {
    const inPair = (t: Token) => topPairs.some((p) => t.from >= p.open.from && t.to <= p.close.to);
    const idle = top.filter((t) => !isActive(ctx.pair, t.type) && !inPair(t));
    for (let i = 0; i + 1 < idle.length; i += 2) {
      const [open, close] = [idle[i], idle[i + 1]];
      setMark(open.from, open.to, "open", ctx.base);
      setMark(close.from, close.to, "close", ctx.base);
      result.spans.push({ from: open.from, to: close.to, contentFrom: open.to, contentTo: close.from, attr: ctx.base, type: "marker" });
    }
  }

  quotes.forEach((q, qi) => {
    const a: Attr = { kind: "quote", key: q.cite.key, explicit: true };
    if (ctx.base.block !== undefined) a.block = ctx.base.block;
    fill(q.open + 1, q.close, a);
    setMark(q.cite.from, q.cite.to, "cite", a);
    result.spans.push({
      from: q.open,
      to: q.cite.to,
      contentFrom: q.open + 1,
      contentTo: q.close,
      attr: a,
      type: "quote",
    });
    applyPairs(pairTokens(zones.get(qi) ?? [], "quote"), a);
  });

  // Comments stay invisible even inside spans.
  for (const s of scan.skips) {
    if (s.type === "comment") for (let k = s.from; k < s.to; k++) role[k] = "meta";
  }

  result.segments = compact(n, role, attr, mark);
  result.spans.sort((a, b) => a.from - b.from);
  return result;
}
