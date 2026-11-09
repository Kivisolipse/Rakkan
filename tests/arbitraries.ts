// Generators for the fuzz tests (tests/fuzz.test.ts). They lean on Rakkan's
// and Markdown's syntax, so that random text hits markers, skipped regions,
// quotes and line structure far more often than uniform strings would.

import fc from "fast-check";

/** Runs per property: FUZZ_RUNS, or a few hundred by default. */
export const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
/** Long mode (npm run fuzz): slow parses fail instead of being logged. */
export const LONG = process.env.FUZZ_RUNS !== undefined && RUNS >= 10_000;
/** FUZZ_SEED reproduces a run; fast-check prints the seed of every failure. */
export const SEED = process.env.FUZZ_SEED !== undefined ? Number(process.env.FUZZ_SEED) : undefined;

export function params<T>(examples: T[] = [], runs = RUNS): fc.Parameters<T> {
  const p: fc.Parameters<T> = { numRuns: runs, examples };
  if (SEED !== undefined) p.seed = SEED;
  return p;
}

// ── Tokens ────────────────────────────────────────────────────────────────

const PLAIN = ["的", "字", "引用", "门锁", "温度", "word", "Ink", "a", "b", "x", "13", "0", "2026"];

/** Rakkan and Markdown syntax, odd whitespace and tricky Unicode. */
export const SYNTAX = [
  "&&", "&&&", "@@", "@@@", "\\", "\\\\", "\\&&", "\\@@", "[@k]", "[@ ]", "[@", "]",
  "「", "」", "『", "』", '"', "“", "”", ">", "```", "````", "~~~", "`", "$", "$$", "\\$",
  "%%", "---", "Annotations:", "<!--", "-->", "&amp;", "&&amp;",
  "[t](https://x.y/&&)", "https://x.y/@@", "^blockid", "（", "）", "［", "］", "·", "•", "|",
  " ", "  ", "\t", "\n", "\r", "\r\n", " ", "\u0085", "﻿", " ",
  "😀", "👩‍💻", "é", "‍", "　",
];

/** Whole lines that mean something on their own. */
export const LINES = ["&& AI", "&&", "&& Claude (claude-opus-5-5)", "- @k: 名字 (id) · human", "@k: 名字 · source", "---", "```", "~~~", "$$", "%%"];

export const token = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...PLAIN) },
  { weight: 4, arbitrary: fc.constantFrom(...SYNTAX) },
  { weight: 1, arbitrary: fc.string({ maxLength: 3, unit: "grapheme" }) },
);

/** A run of tokens on one line (it may still hold U+2028 and the like, which end no line). */
export const soup = (maxTokens = 12) =>
  fc.array(token, { maxLength: maxTokens }).map((ts) => ts.join("").replace(/\r\n|\r|\n/g, " "));

/** Text with line breaks anywhere, as an untrusted source would send it. */
export const rawText = (maxTokens = 30) => fc.array(token, { maxLength: maxTokens }).map((ts) => ts.join(""));

const PREFIXES = ["", " ", "  ", "   ", "    ", "\t", ">", "> ", "> > ", "- ", "1. "];

export const line = fc.oneof(
  { weight: 5, arbitrary: fc.tuple(fc.constantFrom(...PREFIXES), soup()).map(([p, s]) => p + s) },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom(...PREFIXES), fc.constantFrom(...LINES)).map(([p, s]) => p + s) },
);

/** A note: lines joined by \n, \r\n or (rarely) a lone \r. */
export const doc = (maxLines = 12) =>
  fc
    .array(fc.tuple(line, fc.constantFrom("\n", "\n", "\n", "\r\n", "\r")), { maxLength: maxLines })
    .map((ls) => ls.map(([l, br]) => l + br).join(""));

/** Long, repetitive lines that make quadratic scans show. */
export const pathological = fc
  .tuple(
    fc.constantFrom("`", "$a ", "](", "」[@k]", "`a` 」[@k] ", "[@aa", "%", "\\", "&&", "&& ", "「", '"[@k] ', "http://a ", "$$ "),
    fc.integer({ min: 2_000, max: 20_000 }),
    fc.constantFrom("", "\n"),
  )
  .map(([t, n, br]) => Array.from({ length: Math.ceil(n / t.length) }, () => t).join(br));

// ── Markdown, as pasted or clipped into a note ─────────────────────────────

/** Markdown inline syntax, beside Rakkan's. */
const MD_INLINE = [
  "*x*", "_y_", "**b**", "~~s~~", "`c`", "``a`b``", "`", "``", "[t](u)", "[t]", "![i](p.png)", "<b>", "</b>",
  "&amp;", "&copy;", "&#38;", "&#x26;", "&nope;", "\\*", "\\`", "\\\\", "\\@", "\\&", "\\%", "$x$", "$ y$", "a@b.c",
];
const MD_TOKEN = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...PLAIN) },
  { weight: 3, arbitrary: fc.constantFrom(...SYNTAX.filter((t) => !/[\r\n\t]/.test(t))) },
  { weight: 3, arbitrary: fc.constantFrom(...MD_INLINE) },
);
const MD_PREFIXES = ["", "", "", " ", "    ", "> ", "- ", "* ", "1. ", "2) ", "# ", "## ", "| ", "  "];
const MD_LINES = ["```", "```js", "```js @@", "````", "~~~", "~~~ &&", "$$", "$$ %@@", "---", "***", "===", "| a | b |", "|---|---|", "<div>", "</div>", ""];
const mdLine = fc.oneof(
  { weight: 5, arbitrary: fc.tuple(fc.constantFrom(...MD_PREFIXES), fc.array(MD_TOKEN, { maxLength: 8 })).map(([p, ts]) => p + ts.join("")) },
  { weight: 2, arbitrary: fc.tuple(fc.constantFrom("", "", "> ", "  "), fc.constantFrom(...MD_LINES)).map(([p, l]) => p + l) },
);
/** A Markdown passage, the kind pasted or clipped into a note. */
export const markdown = fc.array(mdLine, { maxLength: 8 }).map((ls) => ls.join("\n"));

// ── Keys ──────────────────────────────────────────────────────────────────

const KEY_CHARS = ["a", "z", "Q", "0", "9", "-", ".", "_", "门", "锁", "热", "é"];
/** Keys the way people write them. */
export const key = fc.array(fc.constantFrom(...KEY_CHARS), { minLength: 1, maxLength: 8 }).map((cs) => cs.join(""));
/** Anything SPEC §4.1 allows: no whitespace or square brackets. */
export const anyKey = fc
  .string({ minLength: 1, maxLength: 8, unit: "grapheme" })
  .filter((k) => /^[^\s[\]]+$/u.test(k));

// ── Benign user text ──────────────────────────────────────────────────────

/** What the person wrote around a quote: no syntax of any kind, and no line that could be a definition. */
const BENIGN = ["我", "写", "的", "一段", "文字", "Note", "text", "42", " ", "，", "。"];
export const benignLine = fc
  .array(fc.constantFrom(...BENIGN), { minLength: 1, maxLength: 10 })
  .map((ws) => ws.join(""))
  .filter((l) => /\S/.test(l));
export const benign = fc.array(benignLine, { minLength: 1, maxLength: 3 }).map((ls) => ls.join("\n"));

// ── Inserted text for signRevision ────────────────────────────────────────

/** Characters no other generator makes, so a diff cannot align them with kept text. */
export const INSERT_CHARS = ["甲", "乙", "丙", "丁", "戊"];
export const insertion = fc
  .array(fc.constantFrom(...INSERT_CHARS, " "), { minLength: 1, maxLength: 6 })
  .map((cs) => cs.join(""))
  .filter((s) => /\S/.test(s));

// ── Known failing inputs (GitHub version, measured) ──────────────────────

/** [text, key] for quoteText. Each runs on every fuzz run. */
export const KNOWN_QUOTES: Array<[string, string]> = [
  ["运行时 13 A @@把门锁打开@@", "heater"],
  ["读数「关掉烘干机」[@dorian]", "heater"],
  ["第一行\n```\n第三行", "heater"],
  ["温度 %% 隐藏", "heater"],
  ["读数 \\\\@@x\\\\@@ 正常", "heater"],
  ["读数 %% 开始", "heater"],
  ["结束 %% 读数", "heater"],
];
