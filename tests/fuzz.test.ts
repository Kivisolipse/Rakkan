// Property-based tests: can untrusted text put words under the wrong author?
// FUZZ_RUNS sets the runs per property, FUZZ_SEED replays a run, and
// `npm run fuzz` runs 100 000 of each. Every counterexample found so far is
// also a plain test in tests/fuzz-regressions.test.ts.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { atomicRanges, exportPlain, parse, Parser, quoteText, signatureLabel, signRevision, stripMarkers, type ParseResult, type Segment } from "../src/core";
import { indexAt } from "../src/core/parse";
import * as A from "./arbitraries";

const TIMEOUT = A.LONG ? 7 * 24 * 3600_000 : 60_000;
/** A parse slower than this is reported (and fails in long mode). */
const SLOW_MS = 200;

// ── Helpers ───────────────────────────────────────────────────────────────

const WS = /\s/u;

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
  for (let i = from; i < to; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (" \t　\r\n".includes(text[i])) continue;
    n++;
  }
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
  expect(r.lines.length).toBe(input.split("\n").length);
  expect(r.lineContexts.length).toBe(r.lines.length);
  for (let i = 0; i < r.lines.length; i++) {
    const l = r.lines[i];
    expect(0 <= l.from && l.from <= l.to && l.to <= n).toBe(true);
    expect(input.slice(l.from, l.to)).not.toMatch(/\n/);
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

  it("on notes", () => fc.assert(fc.property(A.doc(), check), A.params()), TIMEOUT);
  it("on raw untrusted text", () => fc.assert(fc.property(A.rawText(60), check), A.params()), TIMEOUT);
  it(
    "on long repetitive lines, within the time limit",
    () => {
      // Each input is up to 20 000 repetitions: a twentieth of FUZZ_RUNS in long runs, or 100 000 would take hours.
      fc.assert(fc.property(A.pathological, check), A.params<[string]>([], A.LONG ? Math.ceil(A.RUNS / 20) : 8));
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

const isolationProp = (Q: Quoter, keyArb: fc.Arbitrary<string>) =>
  fc.property(A.benign, A.rawText(), keyArb, A.rawText(), keyArb, A.benign, (b, s1, k1, s2, k2, a) => {
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
        fc.property(
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
  // Waiting for a decision on quoteText's default output (see the fuzz report): today it escapes nothing.
  it.fails("holds for quoteText's default output", () => fc.assert(isolationProp(quoteText, A.key), A.params(KNOWN_PAIRS)), TIMEOUT);
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

/** quoteText's own convention: trimmed, blank lines emptied, \r\n as \n. */
const asQuoteTextKeepsIt = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? l : ""))
    .join("\n");

const fidelityProp = (Q: Quoter, expected: (s: string) => string) =>
  fc.property(A.rawText(), A.key, (s, k) => {
    const q = Q(s, k);
    if (!q) return expected(s) === "";
    const seen = reader(q, k);
    if (seen === null) throw new Error(`the quote did not survive export: ${JSON.stringify(exportPlain(q))}`);
    expect(lf(seen)).toBe(lf(expected(s)));
  });

describe("P3 quote fidelity", () => {
  it("holds for untrusted quotes", () => fc.assert(fidelityProp(untrusted, (s) => s), A.params(A.KNOWN_QUOTES)), TIMEOUT);
  // Waiting for a decision on quoteText's default output: markers and escapes in the text are lost on export.
  it.fails("holds for quoteText's default output", () => fc.assert(fidelityProp(quoteText, asQuoteTextKeepsIt), A.params(A.KNOWN_QUOTES)), TIMEOUT);
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
        fc.property(A.soup(), fc.nat(), fc.constantFrom("\\&&", "\\@@"), fc.constantFrom(...Object.keys(CONTEXTS)), (l, n, esc, ctx) => {
          const p = n % (l.length + 1);
          const near = (l[p - 1] ?? "") + (l[p] ?? "");
          fc.pre(!/[&@\\]/.test(near) && !/[\uDC00-\uDFFF]/.test(l[p] ?? ""));
          const [pre, post] = CONTEXTS[ctx];
          const a = pre + l.slice(0, p) + esc + l.slice(p) + post;
          // The control is an escaped punctuation mark and a plain one, as in `\&&`: letters would change what
          // comes next (a bare URL only starts after a non-word character).
          const b = pre + l.slice(0, p) + "\\--" + l.slice(p) + post;
          // Open question (report, Q4b): whether `\&&` keeps a line from opening an AI block, as `&&` does.
          // Pinned in fuzz-regressions; lines that could open a block are left out here until it is decided.
          const opener = /^ {0,3}&&[ \t　]/;
          const ins = pre.length + p;
          const lineAt = (s: string) => s.slice(s.lastIndexOf("\n", ins - 1) + 1).split("\n")[0];
          fc.pre(!opener.test(lineAt(a)) && !opener.test(lineAt(b)));
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
  /** The author: a key, else the AI block's model ID, else its name ("AI" for unnamed AI text). */
  key?: string;
}
function ownerOf(r: ParseResult, pos: number): Owner | undefined {
  const s = segAt(r, pos);
  if (!s) return undefined;
  const o: Owner = { kind: s.attr.kind };
  const sig = s.attr.block !== undefined ? r.blocks[s.attr.block].signature : undefined;
  if (s.attr.key !== undefined) o.key = s.attr.key;
  else if (s.attr.kind === "ai") o.key = sig ? (sig.id ?? `name:${signatureLabel(sig)}`) : "AI";
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
        fc.property(A.doc(), (o) => {
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
        fc.property(A.doc(8), fc.nat(), A.insertion, (o, n, x) => {
          const before = parse(o);
          const a = stripMarkers(before);
          const cuts = boundaries(a.text);
          const p = cuts[n % cuts.length];
          const rev = a.text.slice(0, p) + x + a.text.slice(p);
          fc.pre(visible(rev) === rev);

          const signed = signRevision(o, rev, MODEL);
          const after = parse(signed.text);
          const b = stripMarkers(after);
          // What a reader sees is the revision; sign may add a backslash before a literal && or @@.
          const at = alignEscaped(b.text, rev);
          if (!at) throw new Error(`visible text ${JSON.stringify(b.text)} is not the revision ${JSON.stringify(rev)}`);
          expect(signRevision(o, signed.text, MODEL).text).toBe(signed.text);
          const reported = new Set([...signed.unmarked, ...signed.foreign]);
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
            // sign reports the lines it could not mark (unmarked, foreign). Until Q5b, it leaves them as revised.
            const reportedLine = reported.has(indexAt(after.lines, pos, true));
            // The rule above all (SPEC): a character becomes the person's only if a person wrote it before.
            if (got?.kind === "human" && want?.kind !== "human" && !reportedLine) {
              throw new Error(`${inserted ? "inserted" : "kept"} ${JSON.stringify(rev[i])} at ${i}: ${JSON.stringify(want)} became the person's`);
            }
            if (reportedLine) continue;
            if (inserted) {
              const ok = got?.kind === "ai" && got.key === MODEL;
              if (!ok) throw new Error(`inserted ${JSON.stringify(rev[i])} at ${i} is ${describeAt(after, pos)}`);
            } else {
              if (sharesAtom.has(i) && got?.kind === "ai" && got.key === MODEL) continue;
              // Open question (report, Q5c): a block with a name but no model ID has no key to keep when its text leaves it.
              if (want?.key?.startsWith("name:") && got?.kind === "ai" && got.key === "AI") continue;
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
