// Inline scanning: one line at a time, character by character (no lookbehind
// regexes, so it runs on old iOS WebKit too).

import type { Attr, Claim, DiagnosticCode, InlineSpan, MarkType, Role } from "./types";

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

/**
 * Whether the character at each offset follows an odd run of backslashes.
 * A scan that starts on a character other than `\` and skips the character
 * after each `\` skips exactly these, wherever it starts.
 */
function escapedMask(text: string): Uint8Array {
  const out = new Uint8Array(text.length + 1);
  for (let i = 1; i <= text.length; i++) out[i] = text[i - 1] === "\\" && !out[i - 1] ? 1 : 0;
  return out;
}

/** First item of the sorted `list` greater than `x`, or -1. */
function firstAfter(list: number[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] > x) hi = mid;
    else lo = mid + 1;
  }
  return lo < list.length ? list[lo] : -1;
}

/**
 * Where link destinations end. A destination that starts at `open` (`(`) ends
 * after the first unescaped `)` that brings the paren depth back to where it
 * was before `open`; computed for the whole line at once, so a line full of
 * unclosed `](` stays linear.
 */
class LinkEnds {
  private depth: Int32Array;
  private closesAt = new Map<number, number[]>();
  constructor(text: string, escaped: Uint8Array) {
    this.depth = new Int32Array(text.length);
    let d = 0;
    for (let j = 0; j < text.length; j++) {
      if (!escaped[j] && text[j] !== "\\") {
        if (text[j] === "(") d++;
        else if (text[j] === ")") {
          d--;
          let list = this.closesAt.get(d);
          if (!list) this.closesAt.set(d, (list = []));
          list.push(j);
        }
      }
      this.depth[j] = d;
    }
  }
  /** The end of the destination opened at `open`, or -1 when it never closes. */
  end(open: number): number {
    const close = firstAfter(this.closesAt.get(this.depth[open] - 1) ?? [], open);
    return close < 0 ? -1 : close + 1;
  }
}

/**
 * Where a bare URL that starts at `i` ends. As GFM leaves sentence punctuation out of it, closing markers
 * at its end (`&&` or `@@`, with or without `[@key]`) are left out too, and close the spans around it
 * (SPEC §5). `open` says which kinds have a span open where the URL starts.
 */
function urlEnd(text: string, i: number, opts: ScanOptions, open: { amp: boolean; at: boolean }): number {
  const trim = (j: number) => {
    while (j > i && /[.,;:!?]/.test(text[j - 1])) j--;
    return j;
  };
  const full = trim(bareUrlEnd(text, i));
  let j = full;
  // The end of `http://` or `https://`: a URL keeps at least one character after it.
  const min = i + (text[i + 4] === ":" ? 7 : 8);
  // The live pairs at the end, right to left: their kind, and where the URL ends if they are left out.
  const ends: Array<{ amp: boolean; cut: number }> = [];
  for (;;) {
    let k = j;
    if (text[k - 1] === "]") {
      const cite = text.lastIndexOf("[@", k - 1);
      if (cite > min && /^\[@[^\s[\]]+\]$/.test(text.slice(cite, k))) k = cite;
    }
    const c = text[k - 1];
    const want = c === "&" ? opts.ampLen : c === "@" ? opts.atLen : 0;
    if (want !== 2 || text[k - 2] !== c || text[k - 3] === c || k - 2 <= min || opts.literalRuns?.has(k - 2)) break;
    let slashes = 0;
    while (text[k - 3 - slashes] === "\\") slashes++;
    if (slashes % 2) break;
    j = trim(k - 2);
    ends.push({ amp: c === "&", cut: j });
  }
  // The longest run of them that are all closers, read left to right from where the URL would end.
  ends.reverse();
  for (let s = 0; s < ends.length; s++) {
    const now = { ...open };
    const closes = ends.slice(s).every((e) => {
      const was = e.amp ? now.amp : now.at;
      if (e.amp) now.amp = !now.amp;
      else now.at = !now.at;
      return was;
    });
    if (closes) return ends[s].cut;
  }
  return full;
}

function bareUrlEnd(text: string, i: number): number {
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
  /** Whether a pair of each kind is open so far on the line (an odd number of markers). */
  const open = { amp: false, at: false };
  // Built on first use, for the whole line, so no construct rescans the rest of the line.
  let escapedAt: Uint8Array | undefined;
  const escaped = () => (escapedAt ??= escapedMask(text));
  let linkEnds: LinkEnds | undefined;
  let closes: number[] | undefined;
  /** Offsets of every `$` that can close inline math (Pandoc rules), opener aside. */
  const dollarCloses = () => {
    if (closes) return closes;
    const esc = escaped();
    closes = [];
    for (let j = 1; j < n; j++) {
      if (text[j] !== "$" || esc[j] || isSpace(text[j - 1])) continue;
      const next = text[j + 1];
      if (!(next !== undefined && isDigit(next))) closes.push(j);
    }
    return closes;
  };

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
      else {
        out.tokens.push({ from: i, to: i + len, type: c === "&" ? "amp" : "at" });
        if (c === "&") open.amp = !open.amp;
        else open.at = !open.at;
      }
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
        const close = firstAfter(dollarCloses(), i + 1);
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
      linkEnds ??= new LinkEnds(text, escaped());
      const end = linkEnds.end(i + 1);
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
      const end = urlEnd(text, i, opts, open);
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

/** 1 for every offset inside one of `ranges`. */
function rangeMask(n: number, ranges: Range[]): Uint8Array {
  const out = new Uint8Array(n);
  for (const r of ranges) out.fill(1, r.from, Math.min(r.to, n));
  return out;
}

/**
 * For every closing quotation mark outside `skipped`, the opening mark it
 * pairs with, or -1. A `"` pairs with the nearest `"` before it; `」` `』` `”`
 * pair with their opening marks by nesting, as a backward search counting
 * depth from the closing mark finds them. One pass over the line.
 */
function quoteOpens(text: string, skipped: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  const stacks: Record<string, number[]> = { "「": [], "『": [], "“": [] };
  let lastStraight = -1;
  for (let j = 0; j < text.length; j++) {
    if (skipped[j]) continue;
    const c = text[j];
    if (c === '"') {
      out.set(j, lastStraight);
      lastStraight = j;
    } else if (c in stacks) stacks[c].push(j);
    else if (c in QUOTE_OPEN) out.set(j, stacks[QUOTE_OPEN[c]].pop() ?? -1);
  }
  return out;
}

/** Positions marked so far, with a pointer to skip runs already marked. */
class Covered {
  private next: Int32Array;
  constructor(n: number) {
    this.next = new Int32Array(n + 2).map((_, i) => i);
  }
  private find(x: number): number {
    while (this.next[x] !== x) {
      this.next[x] = this.next[this.next[x]];
      x = this.next[x];
    }
    return x;
  }
  has(x: number): boolean {
    return this.find(x) !== x;
  }
  /** Mark [from, to] (inclusive). */
  add(from: number, to: number) {
    for (let x = this.find(from); x <= to; x = this.find(x)) this.next[x] = x + 1;
  }
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
  claims: Claim[];
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
  const result: LineResult = { segments: [], spans: [], claims: [], diagnostics: [], endsInComment: false };

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
  if (prose && scan.cites.length) {
    const skipped = rangeMask(n, scan.skips);
    const opens = quoteOpens(text, skipped);
    // Cites come in order, so every accepted quote closes before this one: the new
    // quote crosses one exactly when it opens inside it. Nesting is fine.
    const covered = new Covered(n);
    for (const cite of scan.cites) {
      let p = cite.from - 1;
      if (p >= 0 && text[p] === " ") p--;
      if (p < 0) continue;
      const ch = text[p];
      if (ch !== '"' && !(ch in QUOTE_OPEN)) continue;
      if (skipped[p]) continue;
      const open = opens.get(p) ?? -1;
      if (open < 0) continue;
      if (covered.has(open)) continue;
      quotes.push({ open, close: p, cite });
      covered.add(open, p);
      usedCites.add(cite);
    }
    quotes.sort((a, b) => a.open - b.open);
  }

  // A quote whose markers pair with markers outside it, as in `&&@@「@@words@@」[@x]@@&&`: its parts have
  // different writers. Its markers pair with the text around it, and who wrote its `[@key]` decides.
  // Tokens come in order and quotes nest without crossing, so a stack of the quotes still open finds the
  // innermost quote whose content holds a token (`skip`: quotes that are no zone of their own).
  const innermost = (skip: Set<number>): number[] => {
    const at: number[] = [];
    const stack: number[] = [];
    let next = 0;
    for (const t of scan.tokens) {
      for (; next < quotes.length && quotes[next].open < t.from; next++) if (!skip.has(next)) stack.push(next);
      while (stack.length && quotes[stack[stack.length - 1]].close < t.to) stack.pop();
      at.push(stack.length ? stack[stack.length - 1] : -1);
    }
    return at;
  };
  const mixed = new Set<number>();
  if (quotes.length) {
    const parent = quotes.map(() => -1);
    const depth = quotes.map(() => 0);
    const open: number[] = [];
    quotes.forEach((q, qi) => {
      while (open.length && quotes[open[open.length - 1]].close < q.open) open.pop();
      if (open.length) {
        parent[qi] = open[open.length - 1];
        depth[qi] = depth[parent[qi]] + 1;
      }
      open.push(qi);
    });
    const tokenAt = new Map(scan.tokens.map((t, ti) => [t, ti]));
    const inner = innermost(new Set());
    const d = (q: number) => (q < 0 ? -1 : depth[q]);
    // Every quote between a pair's two ends and the quote holding both is crossed.
    const walk = (pairs: Pair[]) => {
      for (const p of pairs) {
        let a = inner[tokenAt.get(p.open)!];
        let b = inner[tokenAt.get(p.close)!];
        while (a !== b) {
          if (d(a) >= d(b)) {
            mixed.add(a);
            a = parent[a];
          } else {
            mixed.add(b);
            b = parent[b];
          }
        }
        walk(p.children);
      }
    };
    walk(pairTokens(scan.tokens, ctx.pair));
  }

  // Each token goes to the innermost quote whose content holds it, a mixed one aside.
  const zoneAt = innermost(mixed);
  const zones = new Map<number, Token[]>();
  for (const [ti, t] of scan.tokens.entries()) {
    const z = zoneAt[ti];
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

  applyPairs(pairTokens(zones.get(-1) ?? [], ctx.pair), ctx.base);

  quotes.forEach((q, qi) => {
    // A quote is a claim (SPEC §4.4). One a person wrote counts: the words are the author's. One a model
    // wrote, its `[@key]` in AI text, needs a check first: the words stay the AI's, and the claim is kept.
    const writer = attr[q.cite.from];
    if (writer.kind === "ai") {
      setMark(q.cite.from, q.cite.to, "cite", writer);
      result.claims.push({ from: q.open + 1, to: q.close, key: q.cite.key, cite: { from: q.cite.from, to: q.cite.to } });
      applyPairs(pairTokens(zones.get(qi) ?? [], "ai-inline"), writer);
      return;
    }
    const a: Attr = { kind: "quote", key: q.cite.key, explicit: true };
    if (ctx.base.block !== undefined) a.block = ctx.base.block;
    // A person's `[@key]` makes every word between the quotation marks the key's, whoever typed it.
    if (mixed.has(qi)) {
      for (let k = q.open + 1; k < q.close; k++) if (role[k] !== "mark") attr[k] = a;
    } else fill(q.open + 1, q.close, a);
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
