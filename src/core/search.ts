import type { Stripped } from "./strip";

/**
 * What may sit between two letters in the source: marker and formatting
 * characters, and citations. A citation's key starts with a letter none of
 * the single characters match, so each run of gap splits only one way and the
 * match stays linear.
 */
const GAP = "(?:[@&*=~`[\\]]|\\[@[^\\s@&*=~`[\\]][^\\s[\\]]*\\])*";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A regex source that matches `text` with a gap allowed between any two of its
 * characters; a run of whitespace matches any run of whitespace. Case is left
 * to the flags, as Obsidian's search sets them from its "Match case" toggle.
 */
export function looseRegexSource(text: string): string {
  const parts: string[] = [];
  for (const ch of Array.from(text)) {
    if (!/\s/.test(ch)) parts.push(escapeRe(ch));
    else if (parts[parts.length - 1] !== "\\s+") parts.push("\\s+");
  }
  return parts.join(GAP);
}

export function looseRegex(text: string, flags = "gi"): RegExp {
  return new RegExp(looseRegexSource(text), flags);
}

/** Where `query` occurs in `text`, ignoring formatting and case. */
export function findLoose(text: string, query: string, limit = 1000): Array<{ from: number; to: number }> {
  const q = query.trim();
  if (!q) return [];
  const hits: Array<{ from: number; to: number }> = [];
  for (const m of text.matchAll(looseRegex(q))) {
    hits.push({ from: m.index, to: m.index + m[0].length });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** A hit: its range in the source, and in the text without markers. */
export interface PlainHit {
  from: number;
  to: number;
  plainFrom: number;
  plainTo: number;
}

/** Where `query` occurs in the note with its markers removed, mapped back to the source. */
export function findPlain(p: Stripped, query: string, limit = 1000): PlainHit[] {
  return findLoose(p.text, query, limit).map(({ from, to }) => ({ from: p.map[from], to: p.map[to - 1] + 1, plainFrom: from, plainTo: to }));
}

/** The line of `text` holding [from, to), cut to `before` / `after` characters around it. */
export function excerpt(text: string, from: number, to: number, before = 40, after = 80): { before: string; hit: string; after: string } {
  const lineFrom = text.lastIndexOf("\n", from - 1) + 1;
  const nl = text.indexOf("\n", to);
  const lineTo = nl < 0 ? text.length : nl;
  const a = Math.max(lineFrom, from - before);
  const b = Math.min(lineTo, to + after);
  return {
    before: (a > lineFrom ? "…" : "") + text.slice(a, from).trimStart(),
    hit: text.slice(from, to),
    after: text.slice(to, b).trimEnd() + (b < lineTo ? "…" : ""),
  };
}

/** Marker runs in a short piece of text whose context is unknown (an excerpt, a match). */
export function dropMarkerRuns(text: string): string {
  // No lookbehind: older iOS cannot parse it, and the whole plugin would fail to load.
  return text.replace(/\[@[^\]\s]+\]|&{2,}(?=\S)|(\S)&{2,}|@{2,}/g, (_, before: string | undefined) => before ?? "");
}

// ── Obsidian search queries ──────────────────────────────────────────────

/** Operators whose value is text to find in the note; path:, file: and tag: look elsewhere. */
const TEXT_OPERATORS = new Set(["content", "line", "block", "section", "task", "task-todo", "task-done", "match-case", "ignore-case"]);

/** Words Obsidian's search reads as keywords, not as text. */
const KEYWORDS = new Set(["OR", "TRUE", "FALSE", "EMPTY"]);

/** Tokens that pass through without starting or ending a value. */
const PASS = new Set([" ", ":", "-", "<", ">", "]"]);

/**
 * One token of a query, read the way Obsidian reads it: a phrase or a regex
 * (either may still be open at the end), a negation, a word, or one character
 * of syntax or space.
 */
const TOKEN = /"(?:\\[\s\S]?|[^"\\])*"?|\/(?:\\[\s\S]?|[^/\\])*\/?|-|[^ ()[\]:<>]+|[\s\S]/g;

let wordClassCache: string | undefined;

/**
 * Letters and digits as Obsidian's phrase search counts them for whole
 * words (Chinese, kana and Hangul syllables are not), written as a class body
 * that needs no `u` flag: Obsidian compiles search regexes without it.
 */
function wordClass(): string {
  if (wordClassCache !== undefined) return wordClassCache;
  const letter = /[\p{L}\p{Nd}]/u;
  const cjk = /[\u3041-\u3096\u30a1-\u30fa\u4e00-\u9fff\uac00-\ud7a3]/;
  const isWord = (c: number) => letter.test(String.fromCharCode(c)) && !cjk.test(String.fromCharCode(c));
  const hex = (c: number) => `\\u${c.toString(16).padStart(4, "0")}`;
  let out = "";
  for (let c = 0; c < 0x10000; c++) {
    if (!isWord(c)) continue;
    const from = c;
    while (c < 0xffff && isWord(c + 1)) c++;
    out += c > from ? `${hex(from)}-${hex(c)}` : hex(from);
  }
  return (wordClassCache = out);
}

/**
 * A quoted phrase. Obsidian matches one only as whole words: an end that is a
 * letter or digit must not touch another. The character before is matched
 * too, as in Obsidian's own regex: lookbehind would fail on older iOS.
 */
function phraseSource(text: string): string {
  const w = wordClass();
  const word = new RegExp(`[${w}]`);
  const isWord = (ch: string) => word.test(ch);
  const before = isWord(text.charAt(0)) ? `(?:^|[^${w}])` : "";
  const after = isWord(text.charAt(text.length - 1)) ? `(?![${w}])` : "";
  return before + looseRegexSource(text) + after;
}

/**
 * Rewrite an Obsidian search query so its words and phrases match across
 * markers: each becomes a regex. The query is read token by token as Obsidian
 * reads it. What looks at something other than the note's text (path:, file:,
 * tag:, #tags, [properties]) stays as it is, and so do regexes, keywords,
 * negation and grouping.
 */
export function looseQuery(query: string): string {
  const tokens = query.match(TOKEN) ?? [];
  // Per open parenthesis: whether its words are text to find in the note.
  const groups = [true];
  // Set by an operator, for the one value after its colon.
  let operand: boolean | null = null;
  let inProperty = false;
  return tokens
    .map((tok, k) => {
      if (inProperty) {
        if (tok === "]") inProperty = false;
        return tok;
      }
      if (tok === "[") {
        inProperty = true;
        return tok;
      }
      if (PASS.has(tok)) return tok;
      const isText = operand ?? groups[groups.length - 1];
      operand = null;
      if (tok === "(") groups.push(isText);
      else if (tok === ")" && groups.length > 1) groups.pop();
      if (tok === "(" || tok === ")" || tok.startsWith("/")) return tok;
      if (tok.startsWith('"')) {
        const text = /^"((?:\\[\s\S]?|[^"\\])*)/.exec(tok)![1].replace(/\\([\s\S])/g, "$1");
        return isText && text.trim() ? `/${phraseSource(text)}/` : tok;
      }
      // A word followed by a colon names an operator; its value comes next.
      if (tokens.slice(k + 1).find((t) => t !== " ") === ":") {
        operand = isText && TEXT_OPERATORS.has(tok.toLowerCase());
        return tok;
      }
      return isText && !KEYWORDS.has(tok) && !tok.startsWith("#") ? `/${looseRegexSource(tok)}/` : tok;
    })
    .join("");
}
