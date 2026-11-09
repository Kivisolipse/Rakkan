// Property-based tests: can untrusted text put words under the wrong author?
// FUZZ_RUNS sets the runs per property, FUZZ_SEED replays a run, and
// `npm run fuzz` runs 100 000 of each. Every counterexample found so far is
// also a plain test in tests/fuzz-regressions.test.ts.

import fc from "fast-check";
import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import { describe, expect, it } from "vitest";
import { atomicRanges, clarifications, clarifyQuote, exportPlain, parse, Parser, keyFromName, quotesOf, quoteText, signRevision, stripMarkers, type ParseResult, type Segment } from "../src/core";
import { scanInline } from "../src/core/inline";
import { indexAt } from "../src/core/parse";
import { quoteMarkdown } from "../src/core/quote";
import * as A from "./arbitraries";

const TIMEOUT = A.LONG ? 7 * 24 * 3600_000 : 60_000;
/** A parse slower than this is reported (and fails in long mode). */
const SLOW_MS = 200;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * `fc.property`, letting the event loop run every 50 runs: a property that holds it for a minute makes the
 * test runner's worker miss its calls ("Timeout calling onTaskUpdate"), which fails a run that passed.
 */
let runsSinceYield = 0;
function prop<Ts extends [unknown, ...unknown[]]>(...args: [...arbs: { [K in keyof Ts]: fc.Arbitrary<Ts[K]> }, predicate: (...v: Ts) => void]) {
  const predicate = args.pop() as (...v: Ts) => void;
  const arbs = args as unknown as { [K in keyof Ts]: fc.Arbitrary<Ts[K]> };
  const run = async (...v: unknown[]) => {
    predicate(...(v as Ts));
    if (++runsSinceYield >= 50) {
      runsSinceYield = 0;
      await new Promise((done) => setImmediate(done));
    }
  };
  return fc.asyncProperty(...(arbs as unknown as [fc.Arbitrary<unknown>]), run) as unknown as fc.IAsyncPropertyWithHooks<Ts>;
}

/** Not counted, so no one's (SPEC §7): Unicode whitespace and default-ignorable characters. */
const WS = /[\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

function segAt(r: ParseResult, pos: number): Segment | undefined {
  const i = indexAt(r.segments, pos);
  return i < 0 ? undefined : r.segments[i];
}

const describeAt = (r: ParseResult, pos: number) => {
  const s = segAt(r, pos);
  return s ? `${s.role}/${s.attr.kind}${s.attr.key !== undefined ? "@" + s.attr.key : ""}` : "none";
};

/** The counting rule of the implementation, used to check that stats agree with segments. */
function countLikeParser(text: string, from: number, to: number): number {
  let n = 0;
  for (const c of text.slice(from, to)) if (!WS.test(c)) n++;
  return n;
}

const slow: Array<{ ms: number; input: string }> = [];

function timedParse(input: string, parser?: Parser): ParseResult {
  const t0 = performance.now();
  const r = parser ? parser.parse(input) : parse(input);
  let ms = performance.now() - t0;
  // A garbage collection in a long run can take this long by itself: time it twice more, keep the fastest.
  for (let k = 0; k < 2 && ms > SLOW_MS; k++) {
    const t1 = performance.now();
    parse(input);
    ms = Math.min(ms, performance.now() - t1);
  }
  if (ms > SLOW_MS) {
    slow.push({ ms, input });
    if (A.LONG) throw new Error(`parse took ${ms.toFixed(0)} ms on ${JSON.stringify(input.slice(0, 80))}… (${input.length} chars)`);
  }
  return r;
}

/** Everything parse promises about its result (types.ts), checked on one input. */
function checkInvariants(input: string, r: ParseResult) {
  const n = input.length;
  expect(r.text).toBe(input);
  // Lines end at \r\n, \r or \n (SPEC §3).
  expect(r.lines.length).toBe(input.split(/\r\n|\r|\n/).length);
  expect(r.lineContexts.length).toBe(r.lines.length);
  for (let i = 0; i < r.lines.length; i++) {
    const l = r.lines[i];
    expect(0 <= l.from && l.from <= l.to && l.to <= n).toBe(true);
    expect(input.slice(l.from, l.to)).not.toMatch(/[\r\n]/);
    if (i > 0) expect(r.lines[i - 1].to < l.from).toBe(true);
  }
  let prev = 0;
  for (const s of r.segments) {
    if (!(s.from < s.to && s.from >= prev && s.to <= n)) {
      throw new Error(`segment [${s.from}, ${s.to}) after ${prev} in ${n} chars`);
    }
    prev = s.to;
  }
  for (const s of r.spans) {
    expect(0 <= s.from && s.from <= s.contentFrom && s.contentFrom <= s.contentTo && s.contentTo <= s.to && s.to <= n).toBe(true);
  }
  for (const d of r.diagnostics) expect(0 <= d.from && d.from <= d.to && d.to <= n && d.line < r.lines.length).toBe(true);
  for (const b of r.blocks) expect(b.openLine <= b.lastLine && b.lastLine < r.lines.length).toBe(true);

  const st = { human: 0, ai: 0, quote: 0 };
  for (const s of r.segments) if (s.role === "text") st[s.attr.kind] += countLikeParser(input, s.from, s.to);
  expect({ human: r.stats.human, ai: r.stats.ai, quote: r.stats.quote }).toEqual(st);
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  expect(sum(r.stats.aiByAuthor)).toBe(r.stats.ai);
  expect(sum(r.stats.quoteByKey)).toBe(r.stats.quote);
}

const view = (r: ParseResult) => JSON.stringify([r.segments, r.spans, r.blocks, r.diagnostics, r.definitions, r.stats, r.lineContexts]);

// ── P1: parse is robust ───────────────────────────────────────────────────

describe("P1 parse is robust", () => {
  const shared = new Parser();
  const check = (input: string) => {
    const r = timedParse(input);
    checkInvariants(input, r);
    expect(view(parse(input))).toBe(view(r));
    // A parser that has cached other lines must agree with a fresh one.
    expect(view(timedParse(input, shared))).toBe(view(r));
  };

  it("on notes", () => fc.assert(prop(A.doc(), check), A.params()), TIMEOUT);
  it("on raw untrusted text", () => fc.assert(prop(A.rawText(60), check), A.params()), TIMEOUT);
  it(
    "on long repetitive lines, within the time limit",
    async () => {
      // Each input is up to 20 000 repetitions: a twentieth of FUZZ_RUNS in long runs, or 100 000 would take hours.
      // Each one lets the event loop run, or the test runner's worker misses its calls and fails the whole run.
      await fc.assert(
        fc.asyncProperty(A.pathological, async (input) => {
          check(input);
          await new Promise((done) => setImmediate(done));
        }),
        A.params<[string]>([], A.LONG ? Math.ceil(A.RUNS / 20) : 8),
      );
      if (slow.length) {
        const worst = slow.sort((a, b) => b.ms - a.ms)[0];
        console.warn(`${slow.length} slow parses, worst ${worst.ms.toFixed(0)} ms on ${JSON.stringify(worst.input.slice(0, 40))}…`);
      }
    },
    TIMEOUT,
  );
});

// ── P2: quote isolation ───────────────────────────────────────────────────

type Quoter = (text: string, key: string) => string;

/** Offsets in `q` that are the quote's own syntax: `> `, the cite line, the quotation marks. */
function quoteSyntax(q: string, key: string): Set<number> {
  const own = new Set<number>();
  const cite = `[@${key}]`;
  const inline = (q.startsWith("「") && q.endsWith(`」${cite}`)) || (q.startsWith('"') && q.endsWith(`"${cite}`));
  if (inline && !q.includes("\n")) {
    own.add(0);
    for (let i = q.length - cite.length - 1; i < q.length; i++) own.add(i);
    return own;
  }
  let at = 0;
  const lines = q.split("\n");
  lines.forEach((l, li) => {
    const p = li === lines.length - 1 ? l.length : /^> ?/.exec(l)?.[0].length ?? 0;
    for (let i = 0; i < p; i++) own.add(at + i);
    at += l.length + 1;
  });
  return own;
}

/** Null when the property holds, else what went wrong. */
function isolation(Q: Quoter, before: string, s1: string, k1: string, s2: string, k2: string, after: string): string | null {
  const q1 = Q(s1, k1);
  const q2 = Q(s2, k2);
  const parts: Array<[string, string | null, string]> = [
    [before, null, "before"],
    ["\n\n", null, ""],
    [q1, k1, "Q1"],
    ["\n\n", null, ""],
    [q2, k2, "Q2"],
    ["\n\n", null, ""],
    [after, null, "after"],
  ];
  const doc = parts.map((p) => p[0]).join("");
  const r = parse(doc);
  let at = 0;
  for (const [text, key, name] of parts) {
    if (r.text.slice(at, at + text.length) !== text) return `${name} changed`;
    const own = key !== null ? quoteSyntax(text, key) : new Set<number>();
    for (let i = 0; i < text.length; i++) {
      if (WS.test(text[i]) || own.has(i)) continue;
      const pos = at + i;
      const s = segAt(r, pos);
      const ok =
        key === null
          ? !name || (s?.role === "text" && s.attr.kind === "human")
          : (s?.role === "text" || s?.role === "syntax") && s.attr.kind === "quote" && s.attr.key === key;
      if (!ok) return `${name}: ${JSON.stringify(text[i])} at ${i} is ${describeAt(r, pos)}`;
    }
    at += text.length;
  }
  if (Object.keys(r.definitions).length) return `new definitions: ${Object.keys(r.definitions).join(", ")}`;
  if (r.stats.ai || r.blocks.length) return "AI text";
  return null;
}

const untrusted: Quoter = (t, k) => quoteText(t, k, { untrusted: true });

const isolationProp = (Q: Quoter, keyArb: fc.Arbitrary<string>, text: fc.Arbitrary<string> = A.rawText()) =>
  prop(A.benign, text, keyArb, text, keyArb, A.benign, (b, s1, k1, s2, k2, a) => {
    const why = isolation(Q, b, s1, k1, s2, k2, a);
    if (why) throw new Error(why);
  });

const KNOWN_PAIRS: Array<[string, string, string, string, string, string]> = [
  ...A.KNOWN_QUOTES.map(([s, k]): [string, string, string, string, string, string] => ["我写的前文", s, k, "另一段", "dorian", "我写的后文"]),
  ["我写的前文", "读数 %% 开始", "heater", "结束 %% 读数", "lock", "我写的后文"],
];

describe("P2b code and math in a cited blockquote", () => {
  // Guards the fix for "a code block inside a cited blockquote loses the quote".
  const codeLine = A.soup().filter((l) => !/^[\s>]*(`{3,}|~{3,})/.test(l));
  const mathLine = A.soup().filter((l) => !l.includes("$$"));
  it(
    "stays the quote's, whatever the code and math hold",
    () =>
      fc.assert(
        prop(
          A.benignLine,
          fc.array(codeLine, { maxLength: 4 }),
          A.benignLine,
          fc.array(mathLine, { maxLength: 3 }),
          A.key,
          A.benign,
          (p1, code, p2, math, k, after) => {
            const body = [p1, "```js", ...code, "```", p2, "$$", ...math, "$$", p1];
            const q = [...body.map((l) => `> ${l}`), `> [@${k}]`].join("\n");
            const doc = `${q}\n\n${after}`;
            const r = parse(doc);
            const own = quoteSyntax(q, k);
            for (let i = 0; i < q.length; i++) {
              if (WS.test(q[i]) || own.has(i)) continue;
              const s = segAt(r, i);
              const ok = (s?.role === "text" || s?.role === "syntax") && s.attr.kind === "quote" && s.attr.key === k;
              if (!ok) throw new Error(`${JSON.stringify(q[i])} at ${i} is ${describeAt(r, i)}`);
            }
            for (let i = q.length + 2; i < doc.length; i++) {
              if (!WS.test(doc[i]) && segAt(r, i)?.attr.kind !== "human") throw new Error(`after: ${describeAt(r, i)}`);
            }
          },
        ),
        A.params(),
      ),
    TIMEOUT,
  );
});

describe("P2 quote isolation", () => {
  it("holds for untrusted quotes", () => fc.assert(isolationProp(untrusted, A.key), A.params(KNOWN_PAIRS)), TIMEOUT);
  it("holds for untrusted quotes with any SPEC key", () => fc.assert(isolationProp(untrusted, A.anyKey), A.params()), TIMEOUT);
  // The default output is for Markdown (Q1): it escapes `@ & %` and closes code and math.
  it("holds for quoteText's default output", () => fc.assert(isolationProp(quoteText, A.key), A.params(KNOWN_PAIRS)), TIMEOUT);
  it("holds for quoteText's default output on Markdown", () => fc.assert(isolationProp(quoteText, A.key, A.markdown), A.params()), TIMEOUT);
  // One line, as `「…」[@key]` where it shows the same, else a blockquote.
  it("holds for quoteText's default output on one line", () => fc.assert(isolationProp(quoteText, A.key, A.markdownLine), A.params()), TIMEOUT);
});

// ── P3: quote fidelity ────────────────────────────────────────────────────

const unescape = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
const lf = (s: string) => s.replace(/\r\n|\r/g, "\n");

/** What a reader of the exported note sees inside the quote, or null when the quote did not survive. */
function reader(q: string, key: string): string | null {
  const plain = exportPlain(q);
  if (!q.includes("\n") && (q.startsWith("「") || q.startsWith('"'))) {
    const close = q[0] === "「" ? "」" : '"';
    if (!plain.startsWith(q[0]) || !plain.endsWith(close)) return null;
    return unescape(plain.slice(1, -1));
  }
  const lines = plain.split("\n");
  if (lines.pop() !== `> — ${key}`) return null;
  return unescape(lines.map((l) => l.replace(/^> ?/, "")).join("\n"));
}


const fidelityProp = (Q: Quoter, expected: (s: string) => string) =>
  prop(A.rawText(), A.key, (s, k) => {
    const q = Q(s, k);
    if (!q) return expected(s) === "";
    const seen = reader(q, k);
    if (seen === null) throw new Error(`the quote did not survive export: ${JSON.stringify(exportPlain(q))}`);
    expect(lf(seen)).toBe(lf(expected(s)));
  });

describe("P3 quote fidelity", () => {
  it("holds for untrusted quotes", () => fc.assert(fidelityProp(untrusted, (s) => s), A.params(A.KNOWN_QUOTES)), TIMEOUT);
  // The default output is Markdown and keeps how the text shows, not its characters: P6 checks it.
});

// ── P6: a Markdown quote shows as the text does ──────────────────────────

const md = new MarkdownIt({ html: true });
// Math, with `$` rules close to Obsidian's: `$…$` with no space inside either `$` and no digit outside,
// `$$…$$` inline or as a block. What a formula holds is shown as its source, which is all P6 compares.
md.use(texmath, {
  delimiters: "dollars",
  engine: {
    // texmath puts this in its template with String.replace: a `$` would be read there as `$&` and the like.
    renderToString: (tex: string, o: { displayMode?: boolean }) =>
      `<math${o.displayMode ? " display" : ""}>${md.utils.escapeHtml(tex).replace(/\$/g, "&#36;")}</math>`,
  },
});
// markdown-it caches where closing backticks are, and a `[` scanned for a link label before them can leave
// the cache wrong (a code span then shows as text). CommonMark's rule, without the cache:
md.inline.ruler.at("backticks", (state, silent) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x60) return false;
  let pos = start;
  while (pos < state.posMax && state.src.charCodeAt(pos) === 0x60) pos++;
  const marker = state.src.slice(start, pos);
  for (let at = state.src.indexOf("`", pos); at !== -1 && at < state.posMax; at = state.src.indexOf("`", at)) {
    let end = at;
    while (end < state.posMax && state.src.charCodeAt(end) === 0x60) end++;
    if (end - at === marker.length) {
      if (!silent) {
        const token = state.push("code_inline", "code", 0);
        token.markup = marker;
        token.content = state.src.slice(pos, at).replace(/\n/g, " ").replace(/^ (.+) $/, "$1");
      }
      state.pos = end;
      return true;
    }
    at = end;
  }
  if (!silent) state.pending += marker;
  state.pos += marker.length;
  return true;
});

/**
 * HTML the way a browser reads it, as far as quoteText is concerned: raw HTML
 * gets `@ & %` as entities (a backslash would show there), and `&amp;` is `&`
 * wherever no entity name follows it. markdown-it drops the last line break of
 * raw HTML and of code at the end of a list item or blockquote: whitespace
 * between tags, and a last line break in `<pre>`, which shows no line. A code
 * span folded onto one line keeps the next line's indentation in markdown-it,
 * which CommonMark strips: runs of spaces in inline code are one.
 */
const dom = (html: string) =>
  html
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\n+(?=<\/(?:li|blockquote)>|<\/code><\/pre>)/g, "")
    // Space before a tag at the start of a line of raw HTML shows nothing.
    .replace(/^[ \t]+(?=<)/gm, "")
    .replace(/(?<!<pre>)<code>([^<]*)<\/code>/g, (_, c: string) => `<code>${c.replace(/ +/g, " ")}</code>`)
    // Whitespace in TeX shows nothing (and texmath turns a formula's line breaks to spaces in a blockquote).
    // texmath leaves a blockquote's `>` in a formula's lines in a list item in it (one of the text's own is
    // not compared: see `exempt`).
    .replace(/(<math[^>]*>)([^<]*)<\/math>/g, (_, open: string, tex: string) =>
      `${open}${tex.replace(/(^|[\n\u2028\u2029])(?:\s*&gt;)+/g, "$1").replace(/\s+/g, " ").trim()}</math>`,
    )
    .replace(/\n+$/, "");

/** Lines of code fences, delimiters and all, as CommonMark and as the parser read `t`. */
function fenced(t: string): { cm: string; parser: string } {
  const lines = t.split("\n");
  const cm: number[] = [];
  const cmCode: number[] = [];
  for (const tok of md.parse(t + "\n", {})) {
    if (tok.type !== "fence" || !tok.map) continue;
    const [s, e] = tok.map;
    for (let i = s; i < Math.min(e, lines.length); i++) cm.push(i);
    const last = lines[e - 1] ?? "";
    const close = e - 1 > s && new RegExp(`^${tok.markup[0]}{${tok.markup.length},}[ \\t]*$`).test(last.replace(/^[ \t>]*/, ""));
    for (let i = s + 1; i < Math.min(close ? e - 1 : e, lines.length); i++) cmCode.push(i);
  }
  const p = parse(lines.map((l) => `> ${l}`).join("\n"));
  const code = p.lineContexts.flatMap((c, i) => (c.codeFence !== undefined ? [i] : []));
  const all = p.lineContexts.flatMap((c, i) =>
    c.codeFence !== undefined || (c.mode === "other" && /^(?:`{3,}|~{3,})/.test(lines[i].replace(/^[ \t>]*/, ""))) ? [i] : [],
  );
  return { cm: cm.join(",") + "|" + cmCode.join(","), parser: all.join(",") + "|" + code.join(",") };
}

/**
 * Why the comparison does not apply to `t`, or null. Where the parser and CommonMark read the text
 * differently, isolation wins and the quote shows what the parser reads; where markdown-it parts from
 * CommonMark, it is no judge.
 */
/**
 * `t` with the `$$` lines the quote closes math left open with, when they are all at its end; else null.
 * The quote keeps blank lines at the end only where math holds them: the text keeps as many.
 */
function closed(t: string): string | null {
  const q = quoteMarkdown(t);
  const n = q.mathClosers.length;
  if (!n) return t;
  if (!q.mathClosers.every((at, k) => at === q.lines.length - n + k)) return null;
  let kept = 0;
  while (kept < q.lines.length - n && BLANK.test(q.lines[q.lines.length - n - 1 - kept])) kept++;
  const lines = t.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  let blank = 0;
  while (blank < lines.length && BLANK.test(lines[lines.length - 1 - blank])) blank++;
  return [...lines.slice(0, lines.length - (blank - Math.min(blank, kept))), ...q.mathClosers.map((at) => q.lines[at])].join("\n");
}
const BLANK = /^[ \t>]*$/;

/** The formulas in `t`, as texmath and as the parser read them: what each holds, whitespace aside. */
function formulas(t: string): { cm: string; parser: string } {
  const norm = (xs: string[]) => xs.map((x) => x.replace(/\s+/g, " ").trim()).sort().join("\u0000");
  const cm: string[] = [];
  const walk = (ts: ReturnType<typeof md.parse>) => {
    for (const k of ts) {
      if (k.type.startsWith("math_")) cm.push((k.type.startsWith("math_block") ? "block " : "inline ") + k.content);
      if (k.children) walk(k.children);
    }
  };
  walk(md.parse(t + "\n", {}));
  const parser: string[] = [];
  const contexts = parse(t).lineContexts;
  let block: string | null = null;
  t.split("\n").forEach((line, i) => {
    if (contexts[i]?.codeFence !== undefined || /^(?:`{3,}|~{3,})/.test(line.replace(/^[ \t>]*/, ""))) return;
    const rest = line.replace(/^[ \t>]*/, "");
    if (block !== null) {
      const end = rest.indexOf("$$");
      if (end < 0) block += `${rest}\n`;
      else {
        parser.push(`block ${block}${rest.slice(0, end)}`);
        block = null;
      }
    } else if (rest.startsWith("$$") && rest.indexOf("$$", 2) < 0) block = rest.slice(2);
    else
      for (const k of scanInline(line.replace(/[@&%]/g, "x"), { ampLen: 0, atLen: 0, prose: true }).skips)
        if (k.type === "math") parser.push("inline " + line.slice(k.from, k.to).replace(/^\$\$?|\$\$?$/g, ""));
  });
  return { cm: norm(cm), parser: norm(parser) };
}

function exempt(t: string): string | null {
  // A `$$` block left open: the parser reads it to the end, so the quote closes it before its `[@key]` line
  // (Q1), and the text is compared with the same closer at its end. One closed where a blockquote or list
  // item ends, mid-text, has nothing to compare with.
  if (closed(t) === null) return "math left open mid-text";
  if (t.includes("$")) {
    // Formulas the parser reads and texmath does not, or reads as a block where texmath reads one in the
    // line, or the other way round (`$$x$` is one to texmath).
    // In the text, or in the quote, whose code spans are on one line.
    const f = formulas(t);
    const g = formulas(quoteMarkdown(t).lines.join("\n"));
    if (f.cm !== f.parser || g.cm !== g.parser) return "math read apart";
    // texmath takes out every `>` at the start of a formula's line in a blockquote, its own included.
    // (Its `^` is JavaScript's, after U+2028 and U+2029 too, and its space any `\s`, U+00A0 included.)
    if (/\$\$[^$]*[\n\u2028\u2029]\s*>/.test(t)) return "markdown-it";
  }
  // A fence the parser reads and CommonMark does not, or the other way round.
  const f = fenced(t);
  if (f.cm !== f.parser) return "fences read apart";
  // A bare URL runs over a backtick that opens or closes a code span for CommonMark.
  if (/:[/][/][^ \n]*`/.test(t)) return "URL over a backtick";
  // `$…$` math holding a backtick: the parser reads math, CommonMark a code span.
  const math = quoteMarkdown(t).lines.some((l) =>
    scanInline(l.replace(/[@&%]/g, "x"), { ampLen: 0, atLen: 0, prose: true }).skips.some((k) => k.type === "math" && l.slice(k.from, k.to).includes("`")),
  );
  if (math) return "math over a backtick";
  // markdown-it takes `>` after any indentation for a blockquote's, and reads tables before blockquotes,
  // headings and lists: a `>` line, a heading or a list item can be a table's header. It also lets a table
  // on a paragraph's lazy line break out of the paragraph's list or blockquote.
  const tokens = md.parse(t + "\n", {});
  const lines = t.split("\n");
  const header = /^ {0,3}(?:>|#|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;
  const table = tokens.some(
    (k, n) =>
      k.type === "table_open" &&
      k.map &&
      (header.test(lines[k.map[0]]) ||
        (/_close$/.test(tokens[n - 1]?.type ?? "") && tokens[n - 1].type !== "paragraph_close" && !/^[ \t]*$/.test(lines[k.map[0] - 1] ?? ""))),
  );
  if (/^(?: {4,}|\t)[ \t]*>/m.test(t) || table) return "markdown-it";
  // A code span over lines that, on one line, would make a table: it stays over lines.
  const q = quoteMarkdown(t);
  if (q.unfolded) return "code span kept over lines";
  // A list item starting with indented code, set off from the paragraph above: its list, or the outer one,
  // loosens.
  if (q.loosened) return "list loosened";
  return null;
}

/** The blockquote without its `[@key]` line, rendered. */
function shown(t: string, k: string): string | null {
  const q = quoteText(t, k);
  if (!q) return null;
  const lines = q.split("\n").map((l) => l.slice(l.startsWith("> ") ? 2 : 1));
  lines.pop();
  // `$$ % @@`, which quoteText makes of `$$ %@@`, is the same LaTeX comment.
  const body = lines.map((l) => l.replace(/^([ \t>]*\$\$[ \t]*%) (@)/, "$1$2"));
  return md.render(body.map((l) => (l ? `> ${l}` : ">")).join("\n"));
}

/** The text rendered as a passage of a note, its last line ended (markdown-it drops a last unended blank line in code). */
const alone = (t: string) => md.render(/[\r\n]$/.test(t) ? t : t + "\n");

/** The P6 property for one text, counting what it can't judge in `exempted`. */
function showsAsAlone(t: string, k: string, exempted: Record<string, number>, forms: Record<string, number>) {
  const q = quoteText(t, k);
  // Nothing to quote: nothing to compare.
  if (!q) {
    forms.empty = (forms.empty ?? 0) + 1;
    return;
  }
  // One line in the line: the quote renders as `「…」[@key]` around what the line renders as, a paragraph.
  if (!q.startsWith(">")) {
    forms.inline = (forms.inline ?? 0) + 1;
    const p = /^<p>([^]*)<\/p>\n$/.exec(alone(t));
    expect(p, "on its own, a paragraph").not.toBeNull();
    // The key is no part of the text (and the blockquote's `[@key]` line is left out above): a plain one.
    expect(md.render(quoteText(t, "k") + "\n")).toBe(`<p>「${p![1]}」[@k]</p>\n`);
    return;
  }
  const why = exempt(t);
  if (why) {
    exempted[why] = (exempted[why] ?? 0) + 1;
    return;
  }
  forms.blockquote = (forms.blockquote ?? 0) + 1;
  const got = shown(t, k)!;
  // A raw HTML block loses its last line break inside a blockquote: whitespace only.
  const inner = /^<blockquote>\n([^]*)<\/blockquote>\n$/.exec(got)?.[1] ?? got;
  // Math left open runs to the end, as the closer the quote adds there says.
  const ref = closed(t)!;
  if (ref !== t) forms.closed = (forms.closed ?? 0) + 1;
  expect(dom(inner)).toBe(dom(alone(ref)));
}

// Passages are compared about 64% of the time and single lines about 97% (20000 runs); the floors leave room
// for the spread of a few hundred runs.
const MIN_PASSAGES = 0.5;
const MIN_LINE = 0.9;

describe("P6 Markdown quotes", () => {
  // The least share of texts actually compared, inline or as a blockquote: below it, the generator has
  // drifted into what P6 can't judge, and a pass would say little.
  for (const [name, arb, least] of [
    ["passages", A.markdown, MIN_PASSAGES],
    ["one line", A.markdownLine, MIN_LINE],
  ] as const)
    it(
      `show as the text shows on its own: ${name}`,
      async () => {
        const exempted: Record<string, number> = {};
        const forms: Record<string, number> = {};
        let runs = 0;
        await fc.assert(
          prop(arb, A.key, (t, k) => {
            runs++;
            showsAsAlone(t, k, exempted, forms);
          }),
          A.params(),
        );
        // Isolation wins over looks in the exempted ones; how often, so a rise shows.
        const n = (r: Record<string, number>, key: string) => r[key] ?? 0;
        const skipped = Object.values(exempted).reduce((a, b) => a + b, 0);
        const compared = n(forms, "inline") + n(forms, "blockquote");
        console.log(
          `P6 ${name}: ${runs} texts = ${n(forms, "inline")} compared inline + ${n(forms, "blockquote")} compared as a blockquote` +
            ` (${n(forms, "closed")} of them with math closed) + ${skipped} not compared + ${n(forms, "empty")} empty;` +
            ` compared ${((100 * compared) / runs).toFixed(1)}%. Not compared:`,
          exempted,
        );
        expect(compared + skipped + n(forms, "empty"), "every text counted once").toBe(runs);
        expect(compared / runs, "share of texts compared").toBeGreaterThanOrEqual(least);
      },
      TIMEOUT,
    );
});

// ── P4: escapes ───────────────────────────────────────────────────────────

const CONTEXTS: Record<string, [string, string]> = {
  human: ["", ""],
  "AI block": ["&& AI\n\n", "\n\n&&"],
  "cited blockquote": ["> ", "\n> [@k]"],
  "inline quote": ["「", "」[@k]"],
};

describe("P4 escapes", () => {
  // `\&&` (or `\@@`) must act exactly like `\--`: same roles and owners everywhere else.
  it(
    "an escaped pair is not a marker and changes nothing around it",
    () =>
      fc.assert(
        prop(A.soup(), fc.nat(), fc.constantFrom("\\&&", "\\@@"), fc.constantFrom(...Object.keys(CONTEXTS)), (l, n, esc, ctx) => {
          const p = n % (l.length + 1);
          const near = (l[p - 1] ?? "") + (l[p] ?? "");
          fc.pre(!/[&@\\]/.test(near) && !/[\uDC00-\uDFFF]/.test(l[p] ?? ""));
          const [pre, post] = CONTEXTS[ctx];
          const a = pre + l.slice(0, p) + esc + l.slice(p) + post;
          // The control is an escaped punctuation mark and a plain one, as in `\&&`: letters would change what
          // comes next (a bare URL only starts after a non-word character).
          const b = pre + l.slice(0, p) + "\\--" + l.slice(p) + post;
          const ra = parse(a);
          const rb = parse(b);
          for (let i = 0; i < a.length; i++) {
            const sa = segAt(ra, i);
            const sb = segAt(rb, i);
            if (sa?.role !== sb?.role || sa?.attr.kind !== sb?.attr.kind) {
              throw new Error(`${ctx}: at ${i} ${describeAt(ra, i)} vs ${describeAt(rb, i)}`);
            }
          }
          // Where the control is a marker as well, the pair is part of one: a cite key such as `[@k\&&]` (§4.1).
          const at = pre.length + p + 1;
          if (segAt(rb, at)?.role !== "mark") expect(segAt(ra, at)?.role).not.toBe("mark");
        }),
        A.params(),
      ),
    TIMEOUT,
  );
});

// ── P5: signRevision ──────────────────────────────────────────────────────

const visible = (t: string) => stripMarkers(parse(t)).text;

interface Owner {
  kind: string;
  /** The author: a key, else the AI block's model ID, else the key made from its name (Q5c), else "AI". */
  key?: string;
}
function ownerOf(r: ParseResult, pos: number): Owner | undefined {
  const s = segAt(r, pos);
  if (!s) return undefined;
  const o: Owner = { kind: s.attr.kind };
  const sig = s.attr.block !== undefined ? r.blocks[s.attr.block].signature : undefined;
  if (s.attr.key !== undefined) o.key = s.attr.key;
  else if (s.attr.kind === "ai") o.key = (sig ? (sig.id ?? keyFromName(sig.name ?? "")) : "") || "AI";
  return o;
}

/** Visible-text offsets where an insertion leaves every word whole (the diff works word by word). */
function boundaries(t: string): number[] {
  const out = [0];
  for (const m of t.matchAll(/[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*|\s+|[\s\S]/gu)) {
    const end = m.index! + m[0].length;
    if (!/[\uDC00-\uDFFF]/.test(t[end] ?? "")) out.push(end);
  }
  return out;
}

const MODEL = "claude-opus-5-5";

/**
 * For each character of `want`, its offset in `got`, when `got` is `want` with
 * backslashes added before some `&&` or `@@` (escapes that render as nothing).
 */
function alignEscaped(got: string, want: string): number[] | null {
  const out: number[] = [];
  let g = 0;
  for (let i = 0; i < want.length; i++, g++) {
    if (got[g] !== want[i] && got[g] === "\\" && /^(&&|@@)/.test(got.slice(g + 1))) g++;
    if (got[g] !== want[i]) return null;
    out.push(g);
  }
  return g === got.length ? out : null;
}

describe("P5 signRevision", () => {
  it(
    "leaves a note alone when nothing changed",
    () =>
      fc.assert(
        prop(A.doc(), (o) => {
          const s = signRevision(o, o, MODEL);
          expect(s.text).toBe(o);
          expect(s.changed).toBe(0);
        }),
        A.params(),
      ),
    TIMEOUT,
  );

  it(
    "marks an insertion as the model's, keeps every other owner, and is stable when signed again",
    () =>
      fc.assert(
        prop(A.doc(8), fc.nat(), A.insertion, (o, n, x) => {
          const before = parse(o);
          const a = stripMarkers(before);
          const cuts = boundaries(a.text);
          const p = cuts[n % cuts.length];
          const rev = a.text.slice(0, p) + x + a.text.slice(p);
          fc.pre(visible(rev) === rev);

          const signed = signRevision(o, rev, MODEL);
          expect(signRevision(o, signed.text, MODEL).text).toBe(signed.text);
          const out = parse(signed.text);
          const sameAt = (r1: ParseResult, p1: number, r2: ParseResult, p2: number) =>
            segAt(r1, p1)?.role === segAt(r2, p2)?.role && JSON.stringify(ownerOf(r1, p1)) === JSON.stringify(ownerOf(r2, p2));

          // Q5b: what sign could not mark it put back, and those lines read as in the original.
          for (const g of signed.rejected) {
            for (let k = 0; k < g.count; k++) {
              const ol = before.lines[g.original + k];
              const nl = out.lines[g.line + k];
              expect(signed.text.slice(nl.from, nl.to)).toBe(o.slice(ol.from, ol.to));
              for (let c = 0; c < ol.to - ol.from; c++) {
                if (!sameAt(out, nl.from + c, before, ol.from + c)) throw new Error(`put-back line ${g.line + k} reads otherwise at ${c}: ${describeAt(out, nl.from + c)}`);
              }
            }
          }
          // The other lines are the revision's, signed: put the revision's lines back in place of the
          // others to compare with it.
          const lines = out.lines.map((l, k) => ({
            text: signed.text.slice(l.from, l.to),
            eol: signed.text.slice(l.to, k + 1 < out.lines.length ? out.lines[k + 1].from : signed.text.length),
            from: k as number | null,
          }));
          const recon: typeof lines = [];
          let k = 0;
          for (const g of [...signed.rejected].sort((x, y) => x.line - y.line)) {
            while (k < g.line) recon.push(lines[k++]);
            // Lines and their line ends, alternately.
            const put = g.revised.split(/(\r\n|\r|\n)/);
            let eol = g.count ? lines[g.line + g.count - 1].eol : "\n";
            if (!g.count && recon.length && recon[recon.length - 1].eol === "") {
              recon[recon.length - 1] = { ...recon[recon.length - 1], eol: "\n" };
              eol = "";
            }
            for (let m = 0; m < put.length; m += 2) recon.push({ text: put[m], eol: m + 1 < put.length ? put[m + 1] : eol, from: null });
            k = g.line + g.count;
          }
          while (k < lines.length) recon.push(lines[k++]);
          const after = parse(recon.map((l) => l.text + l.eol).join(""));
          for (let li = 0; li < recon.length; li++) {
            const from = recon[li].from;
            if (from === null) continue;
            for (let c = 0; c < recon[li].text.length; c++) {
              if (!sameAt(after, after.lines[li].from + c, out, out.lines[from].from + c)) throw new Error(`line ${from} reads otherwise once the revision is put back`);
            }
          }
          const b = stripMarkers(after);
          // What a reader sees is the revision; sign may add a backslash before a literal && or @@.
          const at = alignEscaped(b.text, rev);
          if (!at) throw new Error(`visible text ${JSON.stringify(b.text)} is not the revision ${JSON.stringify(rev)}`);
          const foreign = new Set(signed.foreign);
          // A link, cite or the like that took part of the insertion is never split: all of it may be the model's.
          const sharesAtom = new Set<number>();
          const rr = parse(rev);
          rr.lines.forEach((l, li) => {
            const from = l.from + rr.lineContexts[li].prefix;
            for (const atom of atomicRanges(rev.slice(from, l.to))) {
              const [f, t] = [from + atom.from, from + atom.to];
              if (f < p + x.length && t > p) for (let k = f; k < t; k++) sharesAtom.add(k);
            }
          });
          for (let i = 0; i < rev.length; i++) {
            if (WS.test(rev[i])) continue;
            const pos = b.map[at[i]];
            const seg = segAt(after, pos);
            // Leaders, table pipes and the like are syntax, no one's (§7).
            if (seg?.role !== "text") continue;
            const got = ownerOf(after, pos);
            const inserted = i >= p && i < p + x.length;
            const want = inserted ? undefined : ownerOf(before, a.map[i < p ? i : i - x.length]);
            const from = recon[indexAt(after.lines, pos, true)].from;
            // A line sign put back is checked above: none of the revision's text there is in the result.
            if (from === null) continue;
            // The rule above all (SPEC): a character becomes the person's only if a person wrote it before.
            if (got?.kind === "human" && want?.kind !== "human") {
              throw new Error(`${inserted ? "inserted" : "kept"} ${JSON.stringify(rev[i])} at ${i}: ${JSON.stringify(want)} became the person's`);
            }
            // In an AI block another model signed, the model's words count as that model's (reported).
            if (foreign.has(from)) continue;
            if (inserted) {
              const ok = got?.kind === "ai" && got.key === MODEL;
              if (!ok) throw new Error(`inserted ${JSON.stringify(rev[i])} at ${i} is ${describeAt(after, pos)}`);
            } else {
              if (sharesAtom.has(i) && got?.kind === "ai" && got.key === MODEL) continue;
              if (JSON.stringify(got) !== JSON.stringify(want)) {
                throw new Error(`kept ${JSON.stringify(rev[i])} at ${i}: ${JSON.stringify(want)} became ${JSON.stringify(got)}`);
              }
            }
          }
        }),
        A.params(),
      ),
    TIMEOUT,
  );
});

// ── P5: clarifying a quote ──────────────────────────────────────────────

/** Every visible character with its author: the letter, kind, key and whether marked explicitly. A backslash
 * that keeps a pair of markers from pairing renders as nothing. */
function visibleAuthors(r: ParseResult, from: number, to: number) {
  const out: Array<{ ch: string; kind: string; key?: string; explicit: boolean; at: number }> = [];
  for (const s of r.segments) {
    if (s.role !== "text" || s.to <= from || s.from >= to) continue;
    for (let k = Math.max(s.from, from); k < Math.min(s.to, to); k++) {
      if (r.text[k] === "\\" && /^(&&|@@)/.test(r.text.slice(k + 1))) continue;
      out.push({ ch: r.text[k], kind: s.attr.kind, key: s.attr.key, explicit: s.attr.explicit, at: k });
    }
  }
  return out;
}
// Whitespace may move outside markers: it is nobody's.
const sig = (xs: ReturnType<typeof visibleAuthors>) => xs.map((x) => (/\s/.test(x.ch) ? x.ch : `${x.ch}${x.kind}${x.key ?? ""}${x.explicit ? "!" : ""}`)).join("|");

describe("P5 Clarify quote", () => {
  it(
    "changes only the quote; only d makes words human, and as an explicit island",
    async () => {
      let done = 0;
      let refused = 0;
      await fc.assert(
        prop(A.quoteNote, fc.nat(), fc.nat(), (text, n, m) => {
          const r = parse(text);
          const qs = quotesOf(r);
          if (!qs.length) return;
          const q = qs[n % qs.length];
          const choices = clarifications(q);
          const how = choices[m % choices.length];
          const c = clarifyQuote(r, q, how);
          if (!c) {
            refused++;
            return;
          }
          done++;
          const next = text.slice(0, c.from) + c.insert + text.slice(c.to);
          const after = parse(next);

          // Outside the quote, every word keeps its author.
          const before = sig(visibleAuthors(r, 0, q.from));
          const behind = sig(visibleAuthors(r, q.to, text.length));
          const all = visibleAuthors(after, 0, next.length);
          const all_ = sig(all);
          if (!all_.startsWith(before)) throw new Error(`before the quote: ${JSON.stringify(next)}`);
          if (!all_.endsWith(behind)) throw new Error(`after the quote: ${JSON.stringify(next)}`);
          const nb = visibleAuthors(r, 0, q.from).length;
          const na = visibleAuthors(r, q.to, text.length).length;
          const middle = all.slice(nb, all.length - na);

          // The quote's words, quotation marks left out. Its marks and the space before `[@key]` are the text
          // around it.
          const words = visibleAuthors(r, q.kind === "inline" ? q.from + 1 : q.from, q.close);
          const MARKS = /["「」『』“”]/;
          switch (how) {
            case "confirm":
              for (const x of middle) if (!(x.kind === "quote" && x.key === q.key) && !((MARKS.test(x.ch) || /\s/.test(x.ch)) && x.kind === "human")) throw new Error(`not the source's: ${JSON.stringify(next)}`);
              break;
            case "ai":
              for (const x of middle) if (x.kind !== "ai") throw new Error(`not the model's: ${JSON.stringify(next)}`);
              break;
            case "remove":
            case "human": {
              // Whitespace may move outside markers, or out of a line's indent: it is nobody's.
              const ink = (xs: typeof words) => xs.filter((x) => !/\s/.test(x.ch));
              words.splice(0, words.length, ...ink(words));
              const shown = ink(middle);
              middle.splice(0, middle.length, ...shown);
              const at = alignWords(middle.map((x) => x.ch).join(""), words.map((x) => x.ch).join(""));
              if (!at) throw new Error(`the words changed: ${JSON.stringify(next)}`);
              words.forEach((w, i) => {
                const x = middle[at[i]];
                if (how === "human") {
                  if (x.kind !== "human" || !x.explicit) throw new Error(`not an explicit island: ${JSON.stringify(next)}`);
                } else if (x.kind === "quote" || (w.kind !== "quote" && (x.kind !== w.kind || (x.kind === "ai" && x.key !== w.key)))) {
                  throw new Error(`a word changed author: ${JSON.stringify(next)}`);
                }
              });
              break;
            }
          }
          // Signed again with nothing changed, the note stays as it is.
          expect(signRevision(next, next, MODEL).text).toBe(next);
        }),
        A.params(),
      );
      console.log(`P5 Clarify quote: ${done} clarified, ${refused} refused`);
    },
    TIMEOUT,
  );
});

/** Where each character of `want` is in `got`, which may add a backslash before `&&` or `@@`. */
function alignWords(got: string, want: string): number[] | null {
  const out: number[] = [];
  let g = 0;
  for (let i = 0; i < want.length; i++, g++) {
    if (got[g] !== want[i] && got[g] === "\\" && /^(&&|@@)/.test(got.slice(g + 1))) g++;
    if (got[g] !== want[i]) return null;
    out.push(g);
  }
  return g === got.length ? out : null;
}
