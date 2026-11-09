#!/usr/bin/env node
// Built by `npm run build` from cli/rakkan.ts; edit that instead.

// cli/rakkan.ts
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// src/core/inline.ts
var isSpace = (c) => c === " " || c === "	" || c === "\u3000";
var isDigit = (c) => c >= "0" && c <= "9";
var isAsciiWord = (c) => /[A-Za-z0-9_]/.test(c);
function runLength(text, i) {
  const c = text[i];
  let j = i;
  while (j < text.length && text[j] === c) j++;
  return j - i;
}
function entityAt(text, i) {
  if (text[i] !== "&") return false;
  let j = i + 1;
  if (text[j] === "#") j++;
  const start = j;
  while (j < text.length && /[A-Za-z0-9]/.test(text[j])) j++;
  return j > start && text[j] === ";";
}
function hasMarkerRun(text, from, to) {
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
function escapedMask(text) {
  const out = new Uint8Array(text.length + 1);
  for (let i = 1; i <= text.length; i++) out[i] = text[i - 1] === "\\" && !out[i - 1] ? 1 : 0;
  return out;
}
function firstAfter(list, x) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (list[mid] > x) hi = mid;
    else lo = mid + 1;
  }
  return lo < list.length ? list[lo] : -1;
}
var LinkEnds = class {
  constructor(text, escaped) {
    this.closesAt = /* @__PURE__ */ new Map();
    this.depth = new Int32Array(text.length);
    let d = 0;
    for (let j = 0; j < text.length; j++) {
      if (!escaped[j] && text[j] !== "\\") {
        if (text[j] === "(") d++;
        else if (text[j] === ")") {
          d--;
          let list = this.closesAt.get(d);
          if (!list) this.closesAt.set(d, list = []);
          list.push(j);
        }
      }
      this.depth[j] = d;
    }
  }
  /** The end of the destination opened at `open`, or -1 when it never closes. */
  end(open) {
    const close = firstAfter(this.closesAt.get(this.depth[open] - 1) ?? [], open);
    return close < 0 ? -1 : close + 1;
  }
};
function urlEnd(text, i, opts, open) {
  const trim = (j2) => {
    while (j2 > i && /[.,;:!?]/.test(text[j2 - 1])) j2--;
    return j2;
  };
  const full = trim(bareUrlEnd(text, i));
  let j = full;
  const min = i + (text[i + 4] === ":" ? 7 : 8);
  const ends = [];
  for (; ; ) {
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
function bareUrlEnd(text, i) {
  let j = i;
  let parens = 0;
  while (j < text.length) {
    const c = text[j];
    const code = c.charCodeAt(0);
    if (isSpace(c) || c === "<" || c === ">" || c === '"' || code > 126 || code < 33) break;
    if (c === "(") parens++;
    else if (c === ")") {
      if (parens === 0) break;
      parens--;
    }
    j++;
  }
  while (j > i && /[.,;:!?]/.test(text[j - 1])) j--;
  return j;
}
function startsWithCI(text, i, s) {
  return text.slice(i, i + s.length).toLowerCase() === s;
}
function scanInline(text, opts) {
  const out = {
    skips: [],
    tokens: [],
    literals: [],
    cites: [],
    endsInComment: false,
    mathSwallow: []
  };
  const n = text.length;
  let i = 0;
  const open = { amp: false, at: false };
  let escapedAt;
  const escaped = () => escapedAt ??= escapedMask(text);
  let linkEnds;
  let closes;
  const dollarCloses = () => {
    if (closes) return closes;
    const esc = escaped();
    closes = [];
    for (let j = 1; j < n; j++) {
      if (text[j] !== "$" || esc[j] || isSpace(text[j - 1])) continue;
      const next = text[j + 1];
      if (!(next !== void 0 && isDigit(next))) closes.push(j);
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
      const literal = want === 0 || len !== want || (opts.literalRuns?.has(i) ?? false) || c === "&" && opts.prose && entityAt(text, i + len - 1);
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
      const after = text[i + 1];
      if (after !== void 0 && !isSpace(after)) {
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
    if ((c === "h" || c === "H") && (startsWithCI(text, i, "http://") || startsWithCI(text, i, "https://")) && (i === 0 || !isAsciiWord(text[i - 1]))) {
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
function isActive(ctx, type) {
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
function pairTokens(tokens, ctx) {
  const pairs = [];
  let i = 0;
  while (i < tokens.length) {
    const t2 = tokens[i];
    if (!isActive(ctx, t2.type)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < tokens.length && tokens[j].type !== t2.type) j++;
    if (j >= tokens.length) {
      i++;
      continue;
    }
    const inner = t2.type === "amp" ? "ai-inline" : "island";
    pairs.push({
      open: t2,
      close: tokens[j],
      ctx: inner,
      children: pairTokens(tokens.slice(i + 1, j), inner)
    });
    i = j + 1;
  }
  return pairs;
}
var QUOTE_OPEN = { "\u300D": "\u300C", "\u300F": "\u300E", "\u201D": "\u201C" };
function rangeMask(n, ranges) {
  const out = new Uint8Array(n);
  for (const r of ranges) out.fill(1, r.from, Math.min(r.to, n));
  return out;
}
function quoteOpens(text, skipped) {
  const out = /* @__PURE__ */ new Map();
  const stacks = { "\u300C": [], "\u300E": [], "\u201C": [] };
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
var Covered = class {
  constructor(n) {
    this.next = new Int32Array(n + 2).map((_, i) => i);
  }
  find(x) {
    while (this.next[x] !== x) {
      this.next[x] = this.next[this.next[x]];
      x = this.next[x];
    }
    return x;
  }
  has(x) {
    return this.find(x) !== x;
  }
  /** Mark [from, to] (inclusive). */
  add(from, to) {
    for (let x = this.find(from); x <= to; x = this.find(x)) this.next[x] = x + 1;
  }
};
function compact(n, role, attr, mark) {
  const segs = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || role[i] !== role[start] || attr[i] !== attr[start] || mark[i] !== mark[start]) {
      const seg = { from: start, to: i, role: role[start], attr: attr[start] };
      if (mark[start]) seg.mark = mark[start];
      segs.push(seg);
      start = i;
    }
  }
  return segs;
}
function parseLine(text, ctx) {
  const n = text.length;
  const role = new Array(n).fill("text");
  const attr = new Array(n).fill(ctx.base);
  const mark = new Array(n).fill(void 0);
  const result = { segments: [], spans: [], claims: [], diagnostics: [], endsInComment: false };
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
    rendered: ctx.rendered
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
      message: "\u7F72\u540D\u6807\u8BB0\u88AB\u516C\u5F0F\u541E\u6CA1\uFF1A\u6B64\u5904\u7684 $ \u53EF\u80FD\u662F\u91D1\u989D\uFF0C\u8BF7\u5199\u4F5C \\$"
    });
  }
  const citeAt = /* @__PURE__ */ new Map();
  for (const c of scan.cites) citeAt.set(c.from, c);
  const usedCites = /* @__PURE__ */ new Set();
  const quotes = [];
  if (prose && scan.cites.length) {
    const skipped = rangeMask(n, scan.skips);
    const opens = quoteOpens(text, skipped);
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
  const zoneAt = [];
  {
    const stack = [];
    let next = 0;
    for (const t2 of scan.tokens) {
      while (next < quotes.length && quotes[next].open < t2.from) stack.push(next++);
      while (stack.length && quotes[stack[stack.length - 1]].close < t2.to) stack.pop();
      zoneAt.push(stack.length ? stack[stack.length - 1] : -1);
    }
  }
  const zones = /* @__PURE__ */ new Map();
  for (const [ti, t2] of scan.tokens.entries()) {
    const z = zoneAt[ti];
    let list = zones.get(z);
    if (!list) zones.set(z, list = []);
    list.push(t2);
  }
  const fill = (from, to, a) => {
    for (let k = from; k < to; k++) attr[k] = a;
  };
  const setMark = (from, to, m, a) => {
    for (let k = from; k < to; k++) {
      role[k] = "mark";
      mark[k] = m;
      attr[k] = a;
    }
  };
  const applyPairs = (pairs, outer) => {
    for (const p of pairs) {
      let cite = citeAt.get(p.close.to);
      if (!cite && text[p.close.to] === " ") cite = citeAt.get(p.close.to + 1);
      if (cite && usedCites.has(cite)) cite = void 0;
      const a = p.ctx === "ai-inline" ? { kind: "ai", explicit: true } : { kind: "human", explicit: true };
      if (outer.block !== void 0) a.block = outer.block;
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
        type: "marker"
      });
      applyPairs(p.children, a);
    }
  };
  applyPairs(pairTokens(zones.get(-1) ?? [], ctx.pair), ctx.base);
  quotes.forEach((q, qi) => {
    const writer = attr[q.cite.from];
    if (writer.kind === "ai") {
      setMark(q.cite.from, q.cite.to, "cite", writer);
      result.claims.push({ from: q.open + 1, to: q.close, key: q.cite.key, cite: { from: q.cite.from, to: q.cite.to } });
      applyPairs(pairTokens(zones.get(qi) ?? [], "ai-inline"), writer);
      return;
    }
    const a = { kind: "quote", key: q.cite.key, explicit: true };
    if (ctx.base.block !== void 0) a.block = ctx.base.block;
    fill(q.open + 1, q.close, a);
    setMark(q.cite.from, q.cite.to, "cite", a);
    result.spans.push({
      from: q.open,
      to: q.cite.to,
      contentFrom: q.open + 1,
      contentTo: q.close,
      attr: a,
      type: "quote"
    });
    applyPairs(pairTokens(zones.get(qi) ?? [], "quote"), a);
  });
  for (const s of scan.skips) {
    if (s.type === "comment") for (let k = s.from; k < s.to; k++) role[k] = "meta";
  }
  result.segments = compact(n, role, attr, mark);
  result.spans.sort((a, b) => a.from - b.from);
  return result;
}

// src/core/signature.ts
function parseSignature(raw) {
  const s = raw.trim();
  const last = s[s.length - 1];
  if (last === ")" || last === "\uFF09") {
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      const c = s[i];
      if (c === ")" || c === "\uFF09") depth++;
      else if (c === "(" || c === "\uFF08") {
        depth--;
        if (depth === 0) {
          const id = s.slice(i + 1, s.length - 1).trim();
          const name = s.slice(0, i).trim();
          if (!id) break;
          return { raw: s, ...name ? { name } : {}, id };
        }
      }
    }
  }
  return { raw: s, name: s };
}
var FAMILIES = [
  [["claude"], { id: "claude", label: "Claude" }],
  [["gpt", "chatgpt", "o1", "o3", "o4"], { id: "gpt", label: "GPT" }],
  [["gemini"], { id: "gemini", label: "Gemini" }],
  [["deepseek"], { id: "deepseek", label: "DeepSeek" }],
  [["grok"], { id: "grok", label: "Grok" }],
  [["llama"], { id: "llama", label: "Llama" }],
  [["muse"], { id: "muse", label: "Muse" }],
  [["qwen"], { id: "qwen", label: "Qwen" }],
  [["mistral", "mixtral"], { id: "mistral", label: "Mistral" }],
  [["kimi", "moonshot"], { id: "kimi", label: "Kimi" }],
  [["glm"], { id: "glm", label: "GLM" }]
];
var BUILTIN_FAMILIES = FAMILIES.map(([, f]) => f);
function matchPrefix(s, extra) {
  const lower = s.toLowerCase();
  for (const e of extra) {
    if (e.prefix && lower.startsWith(e.prefix.toLowerCase())) {
      return { id: e.family, label: e.label ?? e.family };
    }
  }
  for (const [prefixes, family] of FAMILIES) {
    for (const p of prefixes) {
      if (!lower.startsWith(p)) continue;
      const next = lower.charAt(p.length);
      if (p.length <= 2 && next && /[a-z]/.test(next)) continue;
      if (p === "muse" && next && !/[-\d]/.test(next)) continue;
      return family;
    }
  }
  return null;
}
function familyOf(idOrName, extra = []) {
  if (!idOrName) return null;
  const direct = matchPrefix(idOrName.trim(), extra);
  if (direct) return direct;
  for (const word of idOrName.split(/[\s/·・,，]+/)) {
    const f = matchPrefix(word, extra);
    if (f) return f;
  }
  return null;
}
function signatureFamily(sig, extra = []) {
  return familyOf(sig.id, extra) ?? familyOf(sig.name, extra);
}
function signatureLabel(sig, extra = []) {
  if (sig.name) return sig.name;
  return signatureFamily(sig, extra)?.label ?? sig.id ?? "AI";
}

// src/core/syntax.ts
var LEADER_RE = /^[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\[\^[^\]\s]+\]:[ \t]*)/;
var TASK_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX](?=\])/;
var DELIMITER_RE = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?$/;
var isTableRow = (content) => /^[ \t]*\|/.test(content);
function lineSyntax(content) {
  if (isTableRow(content) && DELIMITER_RE.test(content)) return [[0, content.length]];
  const out = [];
  const lead = LEADER_RE.exec(content)?.[0].length ?? 0;
  if (lead) out.push([0, lead]);
  if (isTableRow(content)) {
    let slashes = 0;
    for (let k = lead; k < content.length; k++) {
      const c = content[k];
      if (c === "|" && slashes % 2 === 0) out.push([k, k + 1]);
      slashes = c === "\\" ? slashes + 1 : 0;
    }
  }
  return out;
}

// src/core/parse.ts
var HUMAN = Object.freeze({ kind: "human", explicit: false });
var FENCE_RE = /^(`{3,}|~{3,})([^]*)$/;
var DEF_RE = /^(?:[-*+]\s+)?@([^\s[\]]+):\s+(.*)$/;
var BLANK_RE = /^\s*$/;
function containerPrefix(line) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "	" || c === ">") i++;
    else break;
  }
  return i;
}
function quotePrefix(line) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  if (line[i] !== ">") return 0;
  while (i < line.length && (line[i] === ">" || line[i] === " " || line[i] === "	")) i++;
  return i;
}
function blockLine(line) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  if (line[i] !== "&" || line[i + 1] !== "&" || line[i + 2] === "&") return null;
  const rest = line.slice(i + 2);
  if (BLANK_RE.test(rest)) return { type: "close" };
  if (rest[0] !== " " && rest[0] !== "	" && rest[0] !== "\u3000") return null;
  if (pairIn(rest)) return null;
  return { type: "open", sig: unescapePairs(rest.trim()) };
}
function unescapePairs(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "&" && s[i + 2] === "&") continue;
    out += s[i];
    if (s[i] === "\\") out += s[++i] ?? "";
  }
  return out;
}
function pairIn(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      if (s[i + 1] === "&") while (s[i + 1] === "&") i++;
      else i++;
    } else if (s[i] === "&" && s[i + 1] === "&") return true;
  }
  return false;
}
var UNCOUNTED = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]$/u;
function codePoints(s, from, to) {
  let count = 0;
  for (const c of s.slice(from, to)) if (!UNCOUNTED.test(c)) count++;
  return count;
}
function emptyStats() {
  return { human: 0, ai: 0, quote: 0, aiByAuthor: {}, quoteByKey: {} };
}
var Parser = class {
  constructor() {
    this.memo = /* @__PURE__ */ new Map();
    this.commentMemo = /* @__PURE__ */ new Map();
  }
  /** Drop cached line results (they are rebuilt on demand). */
  clear() {
    this.memo.clear();
    this.commentMemo.clear();
  }
  parseLineCached(text, ctx) {
    const key = `${ctx.mode}|${ctx.pair}|${ctx.base.kind}|${ctx.base.key ?? ""}|${ctx.base.block ?? ""}|${ctx.ampLen}|${ctx.atLen}|${ctx.inComment ? 1 : 0}\0${text}`;
    let r = this.memo.get(key);
    if (!r) {
      if (this.memo.size > 5e4) this.memo.clear();
      r = parseLine(text, ctx);
      this.memo.set(key, r);
    }
    return r;
  }
  endsInComment(text, inComment) {
    if (!inComment && !text.includes("%%")) return false;
    if (inComment && !text.includes("%%")) return true;
    const key = (inComment ? "1" : "0") + text;
    let r = this.commentMemo.get(key);
    if (r === void 0) {
      if (this.commentMemo.size > 2e4) this.commentMemo.clear();
      r = scanInline(text, { ampLen: 2, atLen: 2, prose: true, inComment }).endsInComment;
      this.commentMemo.set(key, r);
    }
    return r;
  }
  parse(text) {
    const lines = [];
    const lineText = [];
    const eol = /\r\n?|\n/g;
    let offset = 0;
    for (let m = eol.exec(text); ; m = eol.exec(text)) {
      const end = m ? m.index : text.length;
      lines.push({ from: offset, to: end });
      lineText.push(text.slice(offset, end));
      if (!m) break;
      offset = end + m[0].length;
    }
    const N = lines.length;
    const diagnostics = [];
    const diag = (line, from, to, code, message) => diagnostics.push({ line, from, to, code, message });
    let bodyStart = 0;
    if (N > 1 && lineText[0].trimEnd() === "---") {
      for (let i = 1; i < N; i++) {
        const t2 = lineText[i].trimEnd();
        if (t2 === "---" || t2 === "...") {
          bodyStart = i + 1;
          break;
        }
      }
    }
    let bodyEnd = N;
    for (let i = N - 2; i >= bodyStart; i--) {
      if (lineText[i].trimEnd() === "---" && lineText[i + 1].startsWith("Annotations:")) {
        bodyEnd = i;
        break;
      }
    }
    const definitions = {};
    let defStart = bodyEnd;
    {
      let i = bodyEnd - 1;
      let sawDef = false;
      while (i >= bodyStart) {
        const t2 = lineText[i];
        if (BLANK_RE.test(t2)) {
          i--;
          continue;
        }
        const m = DEF_RE.exec(t2);
        if (!m) break;
        sawDef = true;
        definitions[m[1]] ??= m[2].trim();
        defStart = i;
        i--;
      }
      if (!sawDef) defStart = bodyEnd;
    }
    const structs = new Array(N);
    const blocks = [];
    let fence = null;
    let math = false;
    let mathAt = 0;
    let mathLine = -1;
    let inComment = false;
    let open = null;
    const closeBlock = (lastLine, closeLine) => {
      if (!open) return;
      open.lastLine = lastLine;
      open.closeLine = closeLine;
      open.to = lines[lastLine].to;
      open = null;
    };
    for (let i = 0; i < N; i++) {
      const t2 = lineText[i];
      const base = { type: "prose", block: open?.index ?? null, inComment, amp: 0, at: 0, prefix: 0 };
      if (i < bodyStart || i >= defStart) {
        structs[i] = { ...base, type: "meta", block: null };
        continue;
      }
      if (fence) {
        const rest2 = t2.slice(containerPrefix(t2));
        const m = FENCE_RE.exec(rest2);
        if (m && m[1][0] === fence.char && m[1].length >= fence.len && BLANK_RE.test(m[2])) {
          structs[i] = { ...base, type: "fence" };
          fence = null;
        } else {
          structs[i] = { ...base, type: "code", amp: fence.amp, at: fence.at, fenceLine: fence.line };
        }
        continue;
      }
      if (math) {
        if (mathAt && t2.slice(containerPrefix(t2)).trim() === "$$") {
          structs[i] = { ...base, type: "fence" };
          math = false;
          mathAt = 0;
          continue;
        }
        structs[i] = mathAt ? { ...base, type: "code", amp: 0, at: mathAt, fenceLine: mathLine } : { ...base, type: "plain" };
        if (t2.includes("$$")) {
          math = false;
          mathAt = 0;
        }
        continue;
      }
      if (inComment) {
        structs[i] = { ...base };
        inComment = this.endsInComment(t2, true);
        continue;
      }
      const bl = blockLine(t2);
      if (bl?.type === "open") {
        if (open) {
          diag(i, lines[i].from, lines[i].to, "implicit-close", "\u4E0A\u4E00\u4E2A AI \u5757\u7F3A\u5C11\u7ED3\u5C3E &&\uFF0C\u5DF2\u5728\u6B64\u5904\u7ED3\u675F");
          closeBlock(i - 1, null);
        }
        const b = {
          index: blocks.length,
          signature: parseSignature(bl.sig),
          openLine: i,
          closeLine: null,
          lastLine: N - 1,
          from: lines[i].from,
          to: lines[N - 1].to
        };
        blocks.push(b);
        open = b;
        structs[i] = { ...base, type: "block-open", block: b.index };
        continue;
      }
      if (bl?.type === "close") {
        if (open) {
          structs[i] = { ...base, type: "block-close", block: open.index };
          closeBlock(i, i);
        } else {
          diag(i, lines[i].from, lines[i].to, "lone-closer", "\u6B64 && \u4E4B\u524D\u6CA1\u6709\u5E26\u7F72\u540D\u7684\u5F00\u5934\uFF0C\u6309\u539F\u6837\u663E\u793A");
          structs[i] = { ...base };
        }
        continue;
      }
      const cp = containerPrefix(t2);
      const rest = t2.slice(cp);
      const fm = FENCE_RE.exec(rest);
      if (fm && !(fm[1][0] === "`" && fm[2].includes("`"))) {
        const info = fm[2];
        let amp = 0;
        let at = 0;
        const decls = [];
        const infoStart = cp + fm[1].length;
        const wordRe = /\S+/g;
        let wm;
        while (wm = wordRe.exec(info)) {
          const w = wm[0];
          if (/^&{2,}$/.test(w)) amp = w.length;
          else if (/^@{2,}$/.test(w)) at = w.length;
          else continue;
          decls.push([infoStart + wm.index, infoStart + wm.index + w.length]);
        }
        fence = { char: fm[1][0], len: fm[1].length, amp, at, line: i };
        structs[i] = { ...base, type: "fence", decls };
        continue;
      }
      if (rest.startsWith("$$") && rest.indexOf("$$", 2) < 0) {
        math = true;
        const md = /^\$\$[ \t]*(%(@{2,}))[ \t]*$/.exec(rest);
        if (md) {
          mathAt = md[2].length;
          mathLine = i;
          const start = cp + rest.indexOf("%");
          structs[i] = { ...base, type: "fence", decls: [[start, start + md[1].length]] };
        } else structs[i] = { ...base, type: "plain" };
        continue;
      }
      structs[i] = { ...base, prefix: quotePrefix(t2) };
      inComment = this.endsInComment(t2, false);
    }
    if (fence) {
      const l = fence.line;
      diag(l, lines[l].from, lines[l].to, "unclosed-fence", "\u4EE3\u7801\u56F4\u680F\u672A\u95ED\u5408\uFF1A\u5176\u540E\u7684\u7F72\u540D\u6807\u8BB0\u5168\u90E8\u5931\u6548");
    }
    if (open) {
      const b = open;
      diag(b.openLine, lines[b.openLine].from, lines[b.openLine].to, "unclosed-block", "AI \u5757\u7F3A\u5C11\u7ED3\u5C3E &&\uFF0C\u6309\u539F\u6837\u663E\u793A");
      blocks.pop();
      structs[b.openLine] = { ...structs[b.openLine], type: "prose", block: null, prefix: 0 };
      for (let i = b.openLine; i < N; i++) if (structs[i].block === b.index) structs[i].block = null;
      open = null;
    }
    for (const b of blocks) {
      for (const l of [b.openLine, b.closeLine]) {
        if (l === null) continue;
        const prevBad = l > bodyStart && !BLANK_RE.test(lineText[l - 1]);
        const nextBad = l < N - 1 && !BLANK_RE.test(lineText[l + 1]);
        if (prevBad || nextBad) {
          diag(l, lines[l].from, lines[l].to, "blank-line", "&& \u6240\u5728\u884C\u7684\u524D\u540E\u9700\u5404\u6709\u4E00\u4E2A\u7A7A\u884C");
        }
      }
    }
    const quoted = (k) => {
      const s = structs[k];
      if (s.inComment) return false;
      if (s.type === "prose") return s.prefix > 0;
      return (s.type === "fence" || s.type === "code" || s.type === "plain") && quotePrefix(lineText[k]) > 0;
    };
    const claims = [];
    for (let i = 0; i < N; i++) {
      if (!quoted(i)) continue;
      let j = i;
      while (j + 1 < N && quoted(j + 1)) j++;
      const content = lineText[j].slice(structs[j].prefix);
      const m = structs[j].type === "prose" ? /^\[@([^\s[\]]+)\]\s*$/.exec(content) : null;
      if (m && j > i) {
        const from = structs[j].prefix;
        structs[j].citeLine = [from, from + m[0].trimEnd().length];
        if (structs[j].block !== null) {
          const cite = lines[j].from + from;
          claims.push({ from: lines[i].from, to: lines[j - 1].to, key: m[1], cite: { from: cite, to: cite + m[1].length + 3 } });
        } else for (let k = i; k <= j; k++) structs[k].quoteKey = m[1];
      }
      i = j;
    }
    const segments = [];
    const spans = [];
    const blockAttr = blocks.map((b) => Object.freeze({ kind: "ai", block: b.index, explicit: false }));
    const push = (from, to, role, attr, mark) => {
      if (to <= from) return;
      const s = { from, to, role, attr };
      if (mark) s.mark = mark;
      segments.push(s);
    };
    const lineContexts = new Array(N);
    for (let i = 0; i < N; i++) {
      const st = structs[i];
      const { from, to } = lines[i];
      const t2 = lineText[i];
      const outer = st.block !== null ? blockAttr[st.block] : HUMAN;
      const base = st.quoteKey !== void 0 && st.type !== "prose" ? { kind: "quote", key: st.quoteKey, explicit: true, ...st.block !== null ? { block: st.block } : {} } : outer;
      const qp = st.type === "code" || st.type === "plain" ? quotePrefix(t2) : 0;
      const blockPair = st.block !== null ? "ai-block" : "human";
      const codePair = st.quoteKey !== void 0 ? "quote" : blockPair;
      lineContexts[i] = {
        mode: st.type === "prose" && !st.citeLine ? "prose" : st.type === "code" && (st.amp || st.at) ? "code" : "other",
        base: st.type === "meta" ? HUMAN : base,
        pair: codePair,
        prefix: 0,
        inComment: st.inComment,
        ampLen: st.type === "code" ? st.amp : 2,
        atLen: st.type === "code" ? st.at : 2,
        ...st.fenceLine !== void 0 ? { codeFence: st.fenceLine } : {}
      };
      switch (st.type) {
        case "meta":
          push(from, to, "meta", HUMAN);
          continue;
        case "block-open":
          push(from, to, "mark", base, "block-open");
          continue;
        case "block-close":
          push(from, to, "mark", base, "block-close");
          continue;
        case "fence": {
          let p = from;
          for (const [a, b] of st.decls ?? []) {
            push(p, from + a, "syntax", base);
            push(from + a, from + b, "mark", base, "decl");
            p = from + b;
          }
          push(p, to, "syntax", base);
          continue;
        }
        case "plain":
          push(from, from + qp, "syntax", base);
          push(from + qp, to, "text", base);
          continue;
        case "code": {
          if (st.amp === 0 && st.at === 0) {
            push(from, from + qp, "syntax", base);
            push(from + qp, to, "text", base);
            continue;
          }
          push(from, from + qp, "syntax", base);
          const r = this.parseLineCached(t2.slice(qp), {
            base,
            pair: codePair,
            mode: "code",
            ampLen: st.amp,
            atLen: st.at,
            inComment: false
          });
          const o = from + qp;
          for (const s of r.segments) push(o + s.from, o + s.to, s.role, s.attr, s.mark);
          for (const s of r.spans) spans.push({ ...s, from: o + s.from, to: o + s.to, contentFrom: o + s.contentFrom, contentTo: o + s.contentTo });
          continue;
        }
        case "prose": {
          let lineBase = base;
          let pair = st.block !== null ? "ai-block" : "human";
          if (st.quoteKey !== void 0) {
            lineBase = { kind: "quote", key: st.quoteKey, explicit: true };
            if (st.block !== null) lineBase.block = st.block;
            pair = "quote";
          }
          const pre = st.inComment ? 0 : st.prefix;
          lineContexts[i].base = lineBase;
          lineContexts[i].pair = pair;
          lineContexts[i].prefix = pre;
          push(from, from + pre, "syntax", lineBase);
          if (st.citeLine) {
            push(from + st.citeLine[0], from + st.citeLine[1], "mark", lineBase, "cite");
            push(from + st.citeLine[1], to, "text", lineBase);
            continue;
          }
          const r = this.parseLineCached(t2.slice(pre), {
            base: lineBase,
            pair,
            mode: "prose",
            ampLen: 2,
            atLen: 2,
            inComment: st.inComment
          });
          const o = from + pre;
          const cuts = st.inComment ? [] : lineSyntax(t2.slice(pre));
          for (const s of r.segments) {
            if (s.role !== "text" || !cuts.length) {
              push(o + s.from, o + s.to, s.role, s.attr, s.mark);
              continue;
            }
            let at = s.from;
            for (const [a, b] of cuts) {
              if (b <= at || a >= s.to) continue;
              if (a > at) push(o + at, o + a, "text", s.attr);
              at = Math.min(b, s.to);
              push(o + Math.max(a, s.from), o + at, "syntax", s.attr);
            }
            if (at < s.to) push(o + at, o + s.to, "text", s.attr);
          }
          for (const s of r.spans) spans.push({ ...s, from: o + s.from, to: o + s.to, contentFrom: o + s.contentFrom, contentTo: o + s.contentTo });
          for (const c of r.claims) claims.push({ ...c, from: o + c.from, to: o + c.to, cite: { from: o + c.cite.from, to: o + c.cite.to } });
          for (const d of r.diagnostics) diag(i, o + d.from, o + d.to, d.code, d.message);
          continue;
        }
      }
    }
    const stats = emptyStats();
    for (const s of segments) {
      if (s.role !== "text") continue;
      const n = codePoints(text, s.from, s.to);
      if (!n) continue;
      const a = s.attr;
      if (a.kind === "human") stats.human += n;
      else if (a.kind === "ai") {
        stats.ai += n;
        const label = a.key ? `@${a.key}` : a.block !== void 0 ? signatureLabel(blocks[a.block].signature) : "AI";
        stats.aiByAuthor[label] = (stats.aiByAuthor[label] ?? 0) + n;
      } else {
        stats.quote += n;
        const k = a.key ?? "";
        stats.quoteByKey[k] = (stats.quoteByKey[k] ?? 0) + n;
      }
    }
    diagnostics.sort((a, b) => a.from - b.from);
    claims.sort((x, y) => x.from - y.from);
    return { text, lines, lineContexts, segments, spans, claims, blocks, diagnostics, definitions, stats, bodyStart };
  }
};
function indexAt(ranges, pos, inclusiveEnd = false) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const r = ranges[mid];
    if (pos < r.from) hi = mid - 1;
    else if (pos > r.to || pos === r.to && !inclusiveEnd) lo = mid + 1;
    else return mid;
  }
  return -1;
}
function parse(text) {
  return new Parser().parse(text);
}

// src/core/strip.ts
var BLANK_RE2 = /^\s*$/;
function stripMarkers(r, from = 0, to = r.text.length) {
  const { text, lines } = r;
  const drop = new Uint8Array(text.length);
  for (const s of r.segments) {
    if (s.role !== "mark" || s.to <= from || s.from >= to) continue;
    for (let k = s.from; k < s.to; k++) drop[k] = 1;
    if (s.mark === "decl" && text[s.from - 1] === " ") drop[s.from - 1] = 1;
  }
  for (const b of r.blocks) {
    for (const l of [b.openLine, b.closeLine]) {
      if (l === null) continue;
      const line = lines[l];
      const next = lines[l + 1];
      if (!next) continue;
      for (let k = line.to; k < next.from; k++) drop[k] = 1;
      const prev = lines[l - 1];
      const prevBlank = !prev || BLANK_RE2.test(text.slice(prev.from, prev.to));
      const nextBlank = BLANK_RE2.test(text.slice(next.from, next.to));
      if (prevBlank && nextBlank && lines[l + 2]) {
        for (let k = next.from; k < lines[l + 2].from; k++) drop[k] = 1;
      }
    }
  }
  let out = "";
  const map = [];
  for (let k = from; k < to; k++) {
    if (drop[k]) continue;
    out += text[k];
    map.push(k);
  }
  return { text: out, map };
}

// src/core/rewrite.ts
function atomicRanges(content) {
  const out = [];
  const scan = scanInline(content, { ampLen: 2, atLen: 2, prose: true });
  for (const s of scan.skips) if (s.type !== "comment") out.push({ from: s.from, to: s.to });
  for (const c of scan.cites) out.push({ from: c.from, to: c.to });
  const patterns = [
    /!?\[\[[^\]\n]*\]\]/g,
    // wikilinks and embeds
    /!?\[[^\]\n]*\]\([^)\n]*\)/g,
    // Markdown links and images
    /\[\^[^\]\s]+\]/g,
    // footnotes
    /(^|[\s(（])#[^\s#.,;:!?，。；：！？、()（）]+/g,
    // tags
    // Block references, without the space before them: a change that ends in that space would take the
    // reference into the markers, where it no longer ends the line.
    /([ \t])\^[A-Za-z0-9-]+$/g
  ];
  for (const re of patterns) {
    let m;
    while (m = re.exec(content)) {
      const lead = m[1] ? m[1].length : 0;
      out.push({ from: m.index + lead, to: m.index + m[0].length });
    }
  }
  const emphasis = /(\*\*|__|==|~~)\S(?:.*?\S)?\1/g;
  let e;
  while (e = emphasis.exec(content)) out.push({ from: e.index, to: e.index + e[0].length });
  const italic = /(^|[^*])(\*[^\s*](?:[^*]*[^\s*])?\*)(?!\*)/g;
  while (e = italic.exec(content)) out.push({ from: e.index + e[1].length, to: e.index + e[0].length });
  out.sort((x, y) => x.from - y.from || y.to - x.to);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.from < last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}
function joinWhitespace(chars, baseOwner) {
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
function ownersOf(content, ctx, code = false, units = false) {
  const r = parseLine(content, {
    base: ctx.base,
    pair: ctx.pair,
    mode: code ? "code" : "prose",
    ampLen: code ? 0 : 2,
    atLen: code ? ctx.atLen : 2,
    inComment: code ? false : ctx.inComment
  });
  const quotes = r.spans.filter((s) => s.type === "quote");
  if (quotes.length && !units) return null;
  const fixed = /* @__PURE__ */ new Map();
  if (units) {
    const ranges = [...quotes.map((q) => [q.from, q.to]), ...r.claims.map((c) => [c.from - 1, c.cite.to])].sort((x, y) => x[0] - y[0]);
    for (const [from, to] of ranges) for (let k = from; k < to; k++) if (!fixed.has(k)) fixed.set(k, from);
  } else for (const c of r.claims) for (let k = c.cite.from; k < c.cite.to; k++) fixed.set(k, -1);
  const chars = [];
  for (const s of r.segments) {
    const owner = s.attr.kind === "ai" ? "ai" : "human";
    for (let k = s.from; k < s.to; k++) {
      const f = fixed.get(k);
      if (s.role === "mark" && f === void 0) continue;
      const c = { ch: content[k], owner, at: k, orig: "" };
      if (s.attr.key && s.attr.explicit && s.attr.kind !== "quote") c.key = s.attr.key;
      if (f !== void 0) {
        c.fixed = true;
        if (f >= 0) c.unit = f;
      }
      c.orig = owner + (c.key ?? "");
      chars.push(c);
    }
  }
  const head = /* @__PURE__ */ new Map();
  for (const c of chars) if (c.unit !== void 0 && c.at === c.unit) head.set(c.unit, c);
  for (const c of chars) {
    const h = c.unit !== void 0 ? head.get(c.unit) : void 0;
    if (!h) continue;
    c.owner = h.owner;
    if (h.key) c.key = h.key;
    else delete c.key;
    c.orig = h.orig;
  }
  return chars;
}
function unify(chars) {
  const head = /* @__PURE__ */ new Map();
  for (const c of chars) if (c.unit !== void 0 && !head.has(c.unit)) head.set(c.unit, c);
  for (const c of chars) {
    const h = c.unit !== void 0 ? head.get(c.unit) : void 0;
    if (!h || h === c) continue;
    c.owner = h.owner;
    if (h.key) c.key = h.key;
    else delete c.key;
  }
}
function serialize(chars, baseOwner, escape, marker = baseOwner === "human" ? "&&" : "@@", spacesInside = false) {
  let out = "";
  let i = 0;
  const escText = (s) => escape ? s.replace(/(^|[^&@\\])(&&|@@)(?![&@])/g, "$1\\$2") : s;
  const esc = (run) => {
    let s = "";
    for (let k = 0; k < run.length; ) {
      let m = k + 1;
      while (m < run.length && !!run[m].fixed === !!run[k].fixed) m++;
      const part = run.slice(k, m).map((x) => x.ch).join("");
      s += run[k].fixed ? part : escText(part);
      k = m;
    }
    return s;
  };
  while (i < chars.length) {
    const c = chars[i];
    let j = i + 1;
    while (j < chars.length && chars[j].owner === c.owner && chars[j].key === c.key) j++;
    const run = chars.slice(i, j);
    const text = run.map((x) => x.ch).join("");
    if (c.owner === baseOwner || !text.trim()) out += esc(run);
    else {
      const lead = spacesInside ? 0 : text.length - text.trimStart().length;
      const trail = spacesInside ? 0 : text.length - text.trimEnd().length;
      out += text.slice(0, lead) + marker + esc(run.slice(lead, run.length - trail)) + marker + (c.key ? `[@${c.key}]` : "") + text.slice(text.length - trail);
    }
    i = j;
  }
  return out;
}
function signature(chars) {
  return chars.map((c) => (c.fixed ? "F" : "") + (/\s/.test(c.ch) && !c.fixed ? "S" : c.owner === "ai" ? "A" : "H") + c.ch).join("");
}
function keepSyntaxOutside(chars, content, baseOwner) {
  const visible = chars.map((c) => c.ch).join("");
  const atoms = isTableRow(visible) ? atomicRanges(content) : [];
  for (const [from, to] of lineSyntax(visible)) {
    for (let i = from; i < to; i++) {
      const c = chars[i];
      if (c.ch === "|" && atoms.some((a) => c.at >= a.from && c.at < a.to)) continue;
      c.owner = baseOwner;
      delete c.key;
    }
  }
}
function rewriteLineDetailed(line, ctx, edit, opts = {}) {
  if (ctx.mode !== "prose" || ctx.pair === "quote") return null;
  const { split, units = false } = opts;
  const prefix = line.slice(0, ctx.prefix);
  const content = line.slice(ctx.prefix);
  const chars = ownersOf(content, ctx, false, units);
  if (!chars) return null;
  edit(chars);
  unify(chars);
  const baseOwner = ctx.pair === "ai-block" ? "ai" : "human";
  keepSyntaxOutside(chars, content, baseOwner);
  const byAt = new Map(chars.map((c) => [c.at, c]));
  for (const a of atomicRanges(content)) {
    if (split?.has(a.from)) continue;
    let changed;
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
  unify(chars);
  const want = signature(chars);
  for (const [escape, spacesInside] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ]) {
    const out = serialize(chars, baseOwner, escape, void 0, spacesInside);
    const check = ownersOf(out, ctx, false, units);
    if (!check) continue;
    const visible = escape ? check.filter((c) => c.fixed || !(c.ch === "\\" && /[&@]/.test(out[c.at + 1] ?? ""))) : check;
    if (signature(visible) === want) {
      const map = /* @__PURE__ */ new Map();
      chars.forEach((c, i) => map.set(c.at + ctx.prefix, visible[i].at + ctx.prefix));
      return { text: prefix + out, map };
    }
  }
  return null;
}
function rewriteCodeLine(line, ctx, edit) {
  if (ctx.mode !== "code" || ctx.atLen < 2) return null;
  if (ctx.pair === "quote") ctx = { ...ctx, base: { kind: "ai", explicit: false }, pair: "ai-block" };
  if (ctx.pair !== "ai-block") return null;
  const chars = ownersOf(line, ctx, true);
  if (!chars) return null;
  edit(chars);
  joinWhitespace(chars, "ai");
  const out = serialize(chars, "ai", false, "@".repeat(ctx.atLen));
  const check = ownersOf(out, ctx, true);
  if (!check || signature(check) !== signature(chars)) return null;
  const map = /* @__PURE__ */ new Map();
  chars.forEach((c, i) => map.set(c.at, check[i].at));
  return { text: out, map };
}

// src/core/authors.ts
var KIND_WORDS = {
  \u4EBA: "human",
  \u4EBA\u7C7B: "human",
  human: "human",
  ai: "ai",
  \u6A21\u578B: "ai",
  \u6765\u6E90: "source",
  source: "source",
  reference: "source",
  ref: "source"
};
var COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
function parseAuthor(key, raw, extra = []) {
  const parts = raw.split(/\s*[·•|｜]\s*/).map((p) => p.trim());
  const sig = parseSignature(parts[0] ?? "");
  const author = { key, kind: "human" };
  if (sig.name) author.name = sig.name;
  if (sig.id) author.id = sig.id;
  let kind;
  for (const p of parts.slice(1)) {
    if (COLOR_RE.test(p)) author.color = p;
    else kind ??= KIND_WORDS[p.toLowerCase()];
  }
  author.kind = kind ?? (signatureFamily(sig, extra) && sig.id ? "ai" : "human");
  return author;
}
var LINE_RE = /^\s*(?:[-*+]\s+)?@([^\s[\]]+):\s+(.+?)\s*$/;
function parseBook(text, extra = []) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = LINE_RE.exec(line.replace(/\r$/, ""));
    if (m && !(m[1] in out)) out[m[1]] = parseAuthor(m[1], m[2], extra);
  }
  return out;
}
function keyFromName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[@:[\]「」『』“”"]/g, "");
}

// src/core/quote.ts
var ATTR = String.raw`(?:\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\s*=\s*(?:[^"'=<>${"`"}\x00-\x20]+|'[^']*'|"[^"]*"))?)`;
var OPEN_CLOSE = String.raw`<[A-Za-z][A-Za-z0-9\-]*${ATTR}*\s*\/?>|<\/[A-Za-z][A-Za-z0-9\-]*\s*>`;
var INLINE_HTML = new RegExp(
  String.raw`^(?:${OPEN_CLOSE}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\s\S]*?[?]>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)`
);
var BLOCK_NAMES = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var HTML_BLOCKS = [
  [/^<(script|pre|style|textarea)(?=(\s|>|$))/i, /<\/(script|pre|style|textarea)>/i, true],
  [/^<!--/, /-->/, true],
  [/^<\?/, /\?>/, true],
  [/^<![A-Za-z]/, />/, true],
  [/^<!\[CDATA\[/, /\]\]>/, true],
  [new RegExp(String.raw`^</?(${BLOCK_NAMES})(?=(\s|/?>|$))`, "i"), null, true],
  [new RegExp(String.raw`^(?:${OPEN_CLOSE})\s*$`), null, false]
];

// src/core/pasteedits.ts
var TOKEN_RE = /[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*|\s+|[\s\S]/gu;
var tokenize = (s) => Array.from(s.matchAll(TOKEN_RE), (m) => m[0]);
var splitLines = (s) => s.match(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g) ?? [];
var MAX_CELLS = 6e6;
function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(n + m, 2e3, Math.floor(MAX_CELLS / (n + m + 1)));
  const off = maxD + 1;
  const v = new Int32Array(2 * off + 1);
  const trace = [];
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || k !== d && v[off + k - 1] < v[off + k + 1] ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return walkBack(trace, n, m);
    }
  }
  return null;
}
function walkBack(trace, n, m) {
  const pairs = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const at = (k2) => v[k2 + d + 1];
    const k = x - y;
    const prev = k === -d || k !== d && at(k - 1) < at(k + 1) ? k + 1 : k - 1;
    const px = at(prev);
    const py = px - prev;
    while (x > px && y > py) pairs.push([--x, --y]);
    if (d > 0) {
      x = px;
      y = py;
    }
  }
  return pairs.reverse();
}
function carryWords(original, owners, edited, before) {
  const a = tokenize(original);
  const b = tokenize(edited);
  const pairs = lcs(a, b);
  if (!pairs) return { owners: "A".repeat(edited.length), changed: edited === original ? 0 : 1, from: new Array(edited.length).fill(-1) };
  const start = [];
  let at = 0;
  for (const t2 of a) {
    start.push(at);
    at += t2.length;
  }
  const kept = new Map(pairs.map(([i, j]) => [j, i]));
  let own = "";
  let changed = 0;
  let inChange = false;
  const from = [];
  for (let j = 0; j < b.length; j++) {
    const t2 = b[j];
    const i = kept.get(j);
    if (i !== void 0) {
      own += owners.slice(start[i], start[i] + t2.length);
      for (let k = 0; k < t2.length; k++) from.push(start[i] + k);
      inChange = false;
      continue;
    }
    for (let k = 0; k < t2.length; k++) from.push(-1);
    if (/\S/.test(t2)) {
      if (!inChange) changed++;
      inChange = true;
      own += "A".repeat(t2.length);
    } else {
      own += inChange ? "A".repeat(t2.length) : (own.slice(-1) || before).repeat(t2.length);
    }
  }
  return { owners: own, changed, from };
}
function anchors(a, b) {
  const count = (lines) => {
    const m = /* @__PURE__ */ new Map();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const keep = (l) => ca.get(l) === 1 && cb.get(l) === 1 && /\S/.test(l);
  return [a.map((l, i) => keep(l) ? l : `\0a${i}`), b.map((l, i) => keep(l) ? l : `\0b${i}`)];
}
function carry(original, owners, edited) {
  const a = splitLines(original);
  const b = splitLines(edited);
  const start = [];
  let at = 0;
  for (const l of a) {
    start.push(at);
    at += l.length;
  }
  start.push(at);
  const pairs = lcs(...anchors(a, b)) ?? [];
  pairs.push([a.length, b.length]);
  let own = "";
  let changed = 0;
  const from = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    if (pj > j) {
      const r = carryWords(a.slice(i, pi).join(""), owners.slice(start[i], start[pi]), b.slice(j, pj).join(""), own.slice(-1) || "H");
      own += r.owners;
      changed += r.changed;
      for (const f of r.from) from.push(f < 0 ? f : start[i] + f);
    }
    if (pi < a.length) {
      own += owners.slice(start[pi], start[pi + 1]);
      for (let k = start[pi]; k < start[pi + 1]; k++) from.push(k);
    }
    i = pi + 1;
    j = pj + 1;
  }
  return { owners: own, changed, from };
}

// src/core/ia.ts
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var HOLE = String.fromCharCode(57344);

// src/core/lint.ts
function active(a, type) {
  if (a.kind === "quote") return true;
  if (a.kind === "ai") return type === "at";
  return !a.explicit && type === "amp";
}
function lint(r, authors = {}, extra = []) {
  const issues = r.diagnostics.map((d) => ({ ...d }));
  const reported = (from) => r.diagnostics.some((d) => from >= d.from && from < d.to);
  for (let i = 0; i < r.lines.length; i++) {
    const c = r.lineContexts[i];
    if (c.mode === "other") continue;
    const from = r.lines[i].from + c.prefix;
    const scan = scanInline(r.text.slice(from, r.lines[i].to), {
      ampLen: c.ampLen,
      atLen: c.atLen,
      prose: c.mode === "prose",
      inComment: c.inComment
    });
    for (const t2 of scan.tokens) {
      const pos = from + t2.from;
      const seg = r.segments[indexAt(r.segments, pos)];
      if (!seg || seg.role === "mark" || reported(pos)) continue;
      const at = { from: pos, to: from + t2.to, line: i, vars: { mark: r.text.slice(pos, from + t2.to) } };
      if (active(seg.attr, t2.type)) issues.push({ ...at, code: "unpaired-marker", message: "{mark} \u5728\u8FD9\u4E00\u884C\u6CA1\u6709\u914D\u5BF9\uFF0C\u6309\u539F\u6837\u663E\u793A" });
      else if (seg.attr.kind === "ai") issues.push({ ...at, code: "inert-marker", message: "AI \u6587\u5B57\u91CC\u7684 {mark} \u4E0D\u662F\u6807\u8BB0\uFF0C\u6309\u539F\u6837\u663E\u793A" });
      else if (seg.attr.explicit) issues.push({ ...at, code: "inert-marker", message: "\u539F\u521B\u5C9B\u91CC\u7684 {mark} \u4E0D\u662F\u6807\u8BB0\uFF0C\u6309\u539F\u6837\u663E\u793A" });
      else issues.push({ ...at, code: "inert-marker", message: "{mark} \u53EA\u5728 AI \u6587\u5B57\u548C\u5F15\u7528\u91CC\u6807\u51FA\u4EBA\u5199\u7684\u5B57\uFF0C\u8FD9\u91CC\u6309\u539F\u6837\u663E\u793A" });
    }
  }
  const content = (i) => r.text.slice(r.lines[i].from + r.lineContexts[i].prefix, r.lines[i].to);
  const ends = (i) => r.lineContexts[i].mode === "other" || /^[ \t]*$|^ {0,3}(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t]|>)/.test(content(i));
  for (let i = 0; i < r.lines.length; i++) {
    const c = r.lineContexts[i];
    if (c.mode === "other") continue;
    const text = content(i);
    const scan = scanInline(text, { ampLen: c.ampLen, atLen: c.atLen, prose: c.mode === "prose", inComment: c.inComment });
    const run = /`+/g;
    for (let m = run.exec(text); m; m = run.exec(text)) {
      const at = m.index;
      if (scan.skips.some((k) => at >= k.from && at < k.to) || text[at - 1] === "\\") continue;
      let close = -1;
      for (let j = i + 1; j < r.lines.length && !ends(j); j++) {
        if (new RegExp(`(?<!\`)\`{${m[0].length}}(?!\`)`).test(content(j))) {
          close = j;
          break;
        }
      }
      if (close < 0) continue;
      const from = r.lines[i].from + c.prefix + at;
      issues.push({
        from,
        to: from + m[0].length,
        line: i,
        code: "split-code-span",
        message: "\u8FD9\u6BB5\u4EE3\u7801\u8DE8\u4E86\u884C\uFF1ARakkan \u4E00\u884C\u4E00\u884C\u8BFB\uFF0C\u770B\u4E0D\u5230\u5B83\uFF0C\u91CC\u9762\u7684\u6807\u8BB0\u7167\u6837\u751F\u6548\u3002\u628A\u5B83\u5199\u5728\u4E00\u884C\u91CC"
      });
      i = close - 1;
      break;
    }
  }
  const seen = /* @__PURE__ */ new Set();
  for (const s of r.segments) {
    const key = s.attr.key;
    if (s.mark !== "cite" || !key || seen.has(key)) continue;
    seen.add(key);
    if (key in authors || key in r.definitions) continue;
    const at = { from: s.from, to: s.to, line: indexAt(r.lines, s.from, true), code: "unknown-key", vars: { key } };
    if (s.attr.kind !== "ai") issues.push({ ...at, message: "[@{key}] \u6CA1\u6709\u5B9A\u4E49\uFF1A\u5728\u7B14\u8BB0\u672B\u5C3E\u52A0\u4E00\u884C @{key}: \u540D\u5B57 \xB7 \u6765\u6E90\uFF0C\u6216\u5199\u8FDB\u7F72\u540D\u7C3F" });
    else if (!familyOf(key, extra)) issues.push({ ...at, message: "[@{key}] \u6CA1\u6709\u5B9A\u4E49\uFF0C\u4E5F\u4E0D\u662F\u8BA4\u5F97\u51FA\u7684\u6A21\u578B ID" });
  }
  return issues.sort((a, b) => a.from - b.from);
}

// src/core/sign.ts
function whoOf(a, r) {
  const w = { owner: a.kind === "ai" ? "ai" : "human" };
  if (a.kind === "quote") w.quote = true;
  if (a.key && a.explicit) w.key = a.key;
  else if (a.kind === "ai" && a.block !== void 0) {
    const sig = r.blocks[a.block]?.signature;
    const k = sig?.id ?? (sig?.name ? keyFromName(sig.name) : "");
    if (k) w.key = k;
    else if (sig) w.nokey = true;
  }
  return w;
}
function attrAt(r, pos) {
  return r.segments[indexAt(r.segments, pos)]?.attr;
}
function signRevision(original, revised, key) {
  const before = parse(original);
  const after = parse(revised);
  const a = stripMarkers(before);
  const b = stripMarkers(after);
  const whos = /* @__PURE__ */ new Map([
    ["H", { owner: "human" }],
    ["A", key ? { owner: "ai", key } : { owner: "ai" }]
  ]);
  const codes = /* @__PURE__ */ new Map([["human||", "H"]]);
  let owners = "";
  for (const pos of a.map) {
    const attr = attrAt(before, pos);
    const w = attr ? whoOf(attr, before) : { owner: "human" };
    const id = `${w.owner}|${w.key ?? ""}|${w.quote ? "q" : ""}${w.nokey ? "n" : ""}`;
    let code = codes.get(id);
    if (!code) {
      code = String.fromCharCode(57344 + codes.size);
      codes.set(id, code);
      whos.set(code, w);
    }
    owners += code;
  }
  const carried = carry(a.text, owners, b.text);
  const want = /* @__PURE__ */ new Map();
  b.map.forEach((pos, i) => want.set(pos, whos.get(carried.owners[i])));
  for (const pos of b.map) if (revised[pos] === "\\" && /^(?:&&|@@)/.test(revised.slice(pos + 1, pos + 3))) want.delete(pos);
  const boxes = (r, map) => {
    const at = new Map(map.map((pos, i) => [pos, i]));
    const out = /* @__PURE__ */ new Map();
    r.lines.forEach((l, n) => {
      const ctx = r.lineContexts[n];
      if (ctx.mode !== "prose") return;
      const from = l.from + ctx.prefix;
      const m = TASK_RE.exec(r.text.slice(from, l.to));
      const i = m ? at.get(from + m[0].length - 1) : void 0;
      if (i !== void 0) out.set(i, n);
    });
    return out;
  };
  const tasks = [];
  const oldBoxes = boxes(before, a.map);
  if (oldBoxes.size) {
    let tagged = "";
    for (let i = 0; i < a.text.length; i++) tagged += oldBoxes.has(i) ? "T" : "H";
    const own = carry(a.text, tagged, b.text).owners;
    for (const [i, n] of boxes(after, b.map)) if (own[i] !== "T" && own[i - 1] !== "A" && own[i + 1] !== "A") tasks.push(n);
  }
  const changedText = whos.get("A");
  const mixed = /* @__PURE__ */ new Set();
  const split = /* @__PURE__ */ new Map();
  for (let n = 0; n < after.lines.length; n++) {
    const ctx = after.lineContexts[n];
    if (ctx.mode !== "prose") continue;
    const from = after.lines[n].from + ctx.prefix;
    for (const atom of atomicRanges(revised.slice(from, after.lines[n].to))) {
      let changed = false;
      let two = false;
      let first;
      for (let k = from + atom.from; k < from + atom.to; k++) {
        const w = want.get(k);
        if (!w) continue;
        if (w === changedText) changed = true;
        else if (/\S/.test(revised[k])) {
          if (first && w !== first) two = true;
          first ??= w;
        }
      }
      if (two && changed) mixed.add(n);
      else if (two) {
        if (!split.has(n)) split.set(n, /* @__PURE__ */ new Set());
        split.get(n).add(atom.from);
      } else if (changed) {
        for (let k = from + atom.from; k < from + atom.to; k++) if (want.has(k)) want.set(k, changedText);
      }
    }
  }
  const same = (w, pos) => {
    const at = attrAt(after, pos);
    const cur = at ? whoOf(at, after) : void 0;
    return !w || !!cur && w.owner === cur.owner && w.key === cur.key && !w.quote === !cur.quote;
  };
  const units = [
    ...after.spans.filter((x) => x.type === "quote").map((x) => [x.from, x.contentFrom, x.contentTo]),
    // Inline claims: a cited blockquote in an AI block is the block's lines.
    ...after.claims.filter((c) => c.from > 0 && indexAt(after.lines, c.from - 1) === indexAt(after.lines, c.cite.from)).map((c) => [c.from - 1, c.from, c.to])
  ];
  const claimed = /* @__PURE__ */ new Set();
  for (const [head, from, to] of units) {
    let kept = same(want.get(head), head);
    for (let pos = from; pos < to && kept; pos++) kept = same(want.get(pos), pos);
    if (kept) continue;
    want.set(head, changedText);
    for (let pos = from; pos < to; pos++) claimed.add(pos);
  }
  const dirty = /* @__PURE__ */ new Set();
  const foreign = /* @__PURE__ */ new Set();
  for (const s of after.segments) {
    if (s.role !== "text") continue;
    const cur = whoOf(s.attr, after);
    const block = cur.owner === "ai" && s.attr.block !== void 0 ? after.blocks[s.attr.block] : void 0;
    const line = indexAt(after.lines, s.from, true);
    for (let pos = s.from; pos < s.to; pos++) {
      const w = want.get(pos);
      if (!w) continue;
      if (block) {
        if (key && w === changedText && block.signature.id !== key && /\S/.test(revised[pos])) foreign.add(line);
        if (w.owner === "ai") continue;
      } else if (w.owner === cur.owner && w.key === cur.key && w.quote === cur.quote && !w.nokey) continue;
      dirty.add(line);
    }
  }
  const unmarked = [];
  let text = "";
  let last = 0;
  for (const n of [...dirty].sort((x, y) => x - y)) {
    const { from, to } = after.lines[n];
    const ctx = after.lineContexts[n];
    const edit = (offset) => (chars) => {
      for (const c of chars) {
        const w = want.get(from + offset + c.at);
        if (!w) continue;
        c.owner = w.owner;
        if (w.key) c.key = w.key;
        else delete c.key;
      }
    };
    const line = revised.slice(from, to);
    let quoted = false;
    for (let pos = from; pos < to && !quoted; pos++) {
      const w = want.get(pos);
      quoted = w?.quote === true && !same(w, pos) && !claimed.has(pos) || w?.nokey === true;
    }
    const done = quoted || mixed.has(n) ? null : ctx.mode === "prose" ? rewriteLineDetailed(line, ctx, edit(ctx.prefix), { split: split.get(n), units: true }) : ctx.mode === "code" && ctx.pair !== "quote" ? rewriteCodeLine(line, ctx, edit(0)) : null;
    if (!done) {
      unmarked.push(n);
      continue;
    }
    text += revised.slice(last, from) + done.text;
    last = to;
  }
  text += revised.slice(last);
  const signed = { text, changed: carried.changed, unmarked, rejected: [], foreign: [...foreign].sort((x, y) => x - y), tasks };
  return unmarked.length ? putBack(before, after, a, b, carried.from, signed) : signed;
}
function putBack(before, after, a, b, from, signed) {
  const original = before.text;
  const revised = after.text;
  const O = before.lines.length;
  const R = after.lines.length;
  const whole = () => ({
    text: original,
    changed: signed.changed,
    unmarked: before.lines.map((_, n) => n),
    rejected: [{ line: 0, count: O, original: 0, revised }],
    foreign: [],
    tasks: []
  });
  const keys = (r, st) => {
    const vis = r.lines.map(() => "");
    st.map.forEach((pos, i) => {
      const n = indexAt(r.lines, pos);
      if (n >= 0) vis[n] += st.text[i];
    });
    return r.lines.map((l, n) => vis[n] || `\0${r.text.slice(l.from, l.to).trim()}`);
  };
  const ka = keys(before, a);
  const kb = keys(after, b);
  const span = (n) => ({ lo: Array(n).fill(Infinity), hi: Array(n).fill(-1) });
  const toO = span(R);
  const toR = span(O);
  from.forEach((f, j) => {
    if (f < 0) return;
    const rl = indexAt(after.lines, b.map[j]);
    const ol = indexAt(before.lines, a.map[f]);
    if (rl < 0 || ol < 0) return;
    toO.lo[rl] = Math.min(toO.lo[rl], ol);
    toO.hi[rl] = Math.max(toO.hi[rl], ol);
    toR.lo[ol] = Math.min(toR.lo[ol], rl);
    toR.hi[ol] = Math.max(toR.hi[ol], rl);
  });
  const within = (x, n, lo, hi) => x.hi[n] < 0 || x.lo[n] >= lo && x.hi[n] < hi;
  const stretchOf = [];
  const pair = (r, o) => ka[o] === kb[r] && within(toO, r, o, o + 1) && within(toR, o, r, r + 1);
  const one = (r, o) => stretchOf[r] = { r1: r, r2: r + 1, o1: o, o2: o + 1 };
  const anchors2 = [];
  for (let r = 0; r < R; r++) {
    const o = toO.lo[r];
    if (toO.hi[r] === o && toR.lo[o] === r && toR.hi[o] === r) anchors2.push([r, o]);
  }
  let r0 = 0;
  let o0 = 0;
  for (const [ar, ao] of [...anchors2, [R, O]]) {
    let r1 = r0;
    let o1 = o0;
    let r2 = ar;
    let o2 = ao;
    while (r1 < r2 && o1 < o2 && pair(r1, o1)) one(r1++, o1++);
    while (r1 < r2 && o1 < o2 && pair(r2 - 1, o2 - 1)) one(--r2, --o2);
    let oneToOne = r2 - r1 === o2 - o1;
    for (let k = 0; oneToOne && k < r2 - r1; k++) oneToOne = within(toO, r1 + k, o1 + k, o1 + k + 1) && within(toR, o1 + k, r1 + k, r1 + k + 1);
    const hunk = { r1, r2, o1, o2 };
    for (let n = r1; n < r2; n++) stretchOf[n] = oneToOne ? { r1: n, r2: n + 1, o1: o1 + n - r1, o2: o1 + n - r1 + 1 } : hunk;
    if (ar < R) one(ar, ao);
    r0 = ar + 1;
    o0 = ao + 1;
  }
  const back = [...new Set(signed.unmarked.map((n) => stretchOf[n]))].sort((x, y) => x.r1 - y.r1);
  for (const s of back) {
    for (let n = s.r1; n < s.r2; n++) if (!within(toO, n, s.o1, s.o2)) return whole();
    for (let n = s.o1; n < s.o2; n++) if (!within(toR, n, s.r1, s.r2)) return whole();
  }
  const plain = parse(signed.text);
  const eol = (r, n) => r.text.slice(r.lines[n].to, n + 1 < r.lines.length ? r.lines[n + 1].from : r.text.length);
  const pieces = [];
  const lineOut = [];
  const rejected = [];
  const unmarked = [];
  for (let n = 0, g = 0; n < R; ) {
    const s = back[g];
    if (s?.r1 !== n) {
      lineOut[n] = pieces.length;
      pieces.push({ text: plain.text.slice(plain.lines[n].from, plain.lines[n].to), eol: eol(plain, n), r: plain, n });
      n++;
      continue;
    }
    const line = pieces.length;
    for (let o = s.o1; o < s.o2; o++) {
      const last = o === s.o2 - 1;
      pieces.push({ text: original.slice(before.lines[o].from, before.lines[o].to), eol: last ? eol(plain, s.r2 - 1) : eol(before, o), r: before, n: o });
    }
    if (s.o1 === s.o2 && s.r2 === R && pieces.length) pieces[pieces.length - 1].eol = eol(plain, R - 1);
    rejected.push({ line, count: s.o2 - s.o1, original: s.o1, revised: revised.slice(after.lines[s.r1].from, after.lines[s.r2 - 1].to) });
    for (let k = 0; k < Math.max(1, s.o2 - s.o1); k++) unmarked.push(line + k);
    n = s.r2;
    g++;
  }
  const text = pieces.map((p) => p.text + p.eol).join("");
  const out = parse(text);
  if (out.lines.length !== Math.max(1, pieces.length)) return whole();
  const reading = (r, n) => {
    let sig = "";
    for (let pos = r.lines[n].from; pos < r.lines[n].to; pos++) {
      const seg = r.segments[indexAt(r.segments, pos)];
      const blk = seg?.attr.block !== void 0 ? r.blocks[seg.attr.block].signature.raw : "";
      sig += seg ? `${seg.role}|${seg.attr.kind}|${seg.attr.key ?? ""}|${blk}\0` : "\0";
    }
    return sig;
  };
  for (let k = 0; k < pieces.length; k++) if (reading(out, k) !== reading(pieces[k].r, pieces[k].n)) return whole();
  const moved = (lines) => lines.flatMap((n) => lineOut[n] === void 0 ? [] : [lineOut[n]]);
  return { text, changed: signed.changed, unmarked, rejected, foreign: moved(signed.foreign), tasks: moved(signed.tasks) };
}

// src/i18n/en.ts
var en = {
  // commands
  "\u5BFC\u51FA\u4E3A PDF\uFF08Rakkan\uFF09\u2026": "Export as PDF (Rakkan)\u2026",
  "\u6807\u8BB0\u4E3A AI \u751F\u6210": "Mark as AI-generated",
  "\u6807\u8BB0\u4E3A\u539F\u521B": "Mark as human-written",
  "\u79FB\u9664\u6807\u8BB0\uFF08\u9009\u533A\u6216\u6574\u7BC7\uFF09": "Remove markers (selection or whole note)",
  "\u63D2\u5165 AI \u5757": "Insert AI block",
  "\u8865\u5168\u5757\u5F00\u5408\u884C\u7684\u7A7A\u884C": "Add blank lines around block fences",
  "\u5F00\u5408\u884C\u524D\u540E\u5747\u5DF2\u6709\u7A7A\u884C": "Every block fence already has blank lines around it",
  "\u5DF2\u8865\u5168 {n} \u4E2A\u7A7A\u884C": "Added {n} blank lines",
  "\u7C98\u8D34\u4E3A\u5F15\u7528": "Paste as quote",
  "\u7C98\u8D34\u4FEE\u6539\uFF08\u4EC5\u5C06\u6539\u52A8\u5904\u6807\u8BB0\u4E3A\u6A21\u578B\u6240\u5199\uFF09": "Paste revision (mark only the changed parts as the model's)",
  "\u65B0\u5EFA\u7F72\u540D\u7C3F": "Create author book",
  "\u7C98\u8D34\u4E3A AI \u751F\u6210": "Paste as AI-generated",
  "\u5BFC\u51FA\u4E3A\u65B0\u7B14\u8BB0\uFF1A\u79FB\u9664\u6807\u8BB0": "Export as new note: markers removed",
  "\u5BFC\u51FA\u4E3A\u65B0\u7B14\u8BB0\uFF1APandoc \u683C\u5F0F": "Export as new note: Pandoc format",
  "\u5BFC\u51FA\u4E3A\u65B0\u7B14\u8BB0\uFF1AiA \u6807\u6CE8\u683C\u5F0F": "Export as new note: iA Annotations format",
  "\u5BFC\u51FA\u4E3A\u65B0\u7B14\u8BB0\uFF1AObsidian Publish \u7528\uFF08\u5E26\u6837\u5F0F\u7C7B\uFF09": "Export as new note: for Obsidian Publish (with style classes)",
  "\u5BFC\u51FA\u4E3A PDF\u2026": "Export as PDF\u2026",
  "\u751F\u6210 Obsidian Publish \u6837\u5F0F\uFF08publish.css\uFF09": "Generate Obsidian Publish styles (publish.css)",
  "\u4ECE iA \u6807\u6CE8\u8F6C\u6362\uFF08\u5F53\u524D\u7B14\u8BB0\uFF09": "Convert from iA Annotations (current note)",
  "\u5207\u6362\u5199\u4F5C / \u5BA1\u9605\u663E\u793A": "Toggle writing / review display",
  "\u5BA1\u9605\u663E\u793A": "Review display",
  "\u5199\u4F5C\u663E\u793A": "Writing display",
  "\u641C\u7D22\uFF08\u5FFD\u7565\u683C\u5F0F\uFF09": "Search (ignore formatting)",
  "\u5728\u5F53\u524D\u7B14\u8BB0\u4E2D\u67E5\u627E\uFF08\u5FFD\u7565\u683C\u5F0F\uFF09": "Find in current note (ignore formatting)",
  "\u67E5\u770B\u63D0\u9192": "Show warnings",
  "\u79FB\u9664\u9009\u533A\u7684\u6807\u8BB0": "Remove markers in selection",
  // notices
  "\u65E0\u6CD5\u8BFB\u53D6\u526A\u8D34\u677F": "Can't read the clipboard",
  "\u7C98\u8D34\u4FEE\u6539": "Paste revision",
  "\u8BF7\u5148\u9009\u4E2D\u88AB\u4FEE\u6539\u7684\u539F\u6587\uFF0C\u518D\u8FD0\u884C\u6B64\u547D\u4EE4": "Select the original passage first, then run this command",
  "\u9009\u533A\u5305\u542B AI \u5757\u7684\u5F00\u5408\u884C\uFF0C\u8BF7\u4EC5\u9009\u62E9\u6B63\u6587": "The selection includes an AI block's opening or closing line; select the body only",
  "\u9009\u533A\u5305\u542B\u5F15\u7528\uFF0C\u7C98\u8D34\u4FEE\u6539\u4F1A\u4E22\u5931\u51FA\u5904\uFF0C\u8BF7\u907F\u5F00\u5F15\u7528": "The selection contains quotes, and a revision would lose their sources; avoid them",
  "\u526A\u8D34\u677F\u4E3A\u7A7A": "The clipboard is empty",
  "\u9009\u62E9\u4F5C\u8005\u671F\u95F4\u539F\u6587\u5DF2\u6539\u52A8\uFF0C\u8BF7\u91CD\u8BD5": "The text changed while you were choosing an author; please try again",
  "\u672A\u53D1\u73B0\u6539\u52A8": "No changes found",
  "\u4E0D\u6807\u6CE8\u6A21\u578B": "Don't name a model",
  "\u8BF7\u5148\u65B0\u5EFA\u7F72\u540D\u7C3F": "Create the author book first",
  "{n} \u884C\u542B\u5F15\u7528\u6216\u4EE3\u7801\uFF0C\u672A\u4F5C\u6539\u52A8": "{n} lines contain quotes or code and were left unchanged",
  "{n} \u5904\u6539\u52A8\u542B\u5F15\u7528\u6216\u4EE3\u7801\uFF0C\u65E0\u6CD5\u6807\u8BB0\uFF0C\u5DF2\u4FDD\u7559\u539F\u6587": "{n} changes hold quotes or code and can't be marked, so the original was kept there",
  "{n} \u4E2A\u4EFB\u52A1\u7684\u52FE\u9009\u72B6\u6001\u88AB\u6539\u52A8\uFF0C\u52FE\u9009\u8005\u4E0D\u4F1A\u8BB0\u5F55": "{n} tasks were ticked or unticked; who ticked them isn't recorded",
  "{n} \u884C\u7684\u6539\u52A8\u5728\u5176\u4ED6\u6A21\u578B\u7F72\u540D\u7684 AI \u5757\u91CC\uFF0C\u7B97\u4F5C\u8BE5\u6A21\u578B\u6240\u5199": "{n} changed lines are in an AI block another model signed, so the changes count as that model's",
  "\u5DF2\u6807\u8BB0 {n} \u5904\u6539\u52A8": "Marked {n} changes",
  "\u5DF2\u590D\u5236\uFF08\u5DF2\u79FB\u9664\u6807\u8BB0\uFF09": "Copied (markers removed)",
  "\u5DF2\u65B0\u5EFA publish.css": "Created publish.css",
  "\u5DF2\u66F4\u65B0 publish.css \u4E2D Rakkan \u7684\u90E8\u5206": "Updated Rakkan's part of publish.css",
  // author book / picker
  "\u4EBA": "human",
  "\u6765\u6E90": "source",
  "\u9009\u62E9\u4F5C\u8005\uFF0C\u6216\u8F93\u5165\u65B0\u7684 key": "Pick an author, or type a new key",
  " \xB7 \u65B0 key": " \xB7 new key",
  // export / iA
  "\u65E0\u6807\u8BB0": "plain",
  "\u5DF2\u5BFC\u51FA\uFF1A{path}": "Exported: {path}",
  "{n} \u4E2A\u5B57": "{n} chars",
  "\u4EE5\u4E0B\u4EBA\u5458\u5747\u4E0D\u5728\u7F72\u540D\u7C3F\u4E2D\uFF1A\u8BF7\u9009\u62E9\u672C\u5E93\u7684\u6240\u6709\u8005\uFF0C\u5176\u4F59\u4EBA\u5458\u5C06\u8F6C\u4E3A\u5F15\u7528": "None of these people are in the author book. Which one owns this vault? The rest become quotes",
  "\u5747\u4E0D\u662F\uFF0C\u5168\u90E8\u8F6C\u4E3A\u5F15\u7528": "None of them; make all of them quotes",
  "\u8FD9\u4E9B\u4EBA\u6240\u5199\u7684\u6587\u5B57\u5747\u89C6\u4E3A\u4ED6\u4EBA\u6240\u4F5C": "What these people wrote is someone else's",
  "\u672C\u7B14\u8BB0\u672B\u5C3E\u6CA1\u6709 iA \u6807\u6CE8\u5757": "This note has no iA annotation block at the end",
  "\u6807\u6CE8\u4E0E\u6B63\u6587\u4E0D\u4E00\u81F4\uFF08\u54C8\u5E0C\u4E0D\u7B26\uFF09\uFF0C\u672A\u8F6C\u6362\u3002\u6807\u6CE8\u751F\u6210\u540E\u6B63\u6587\u53EF\u80FD\u5DF2\u88AB\u4FEE\u6539": "The annotations don't match the text (hash mismatch); nothing was converted. The text may have been edited after the annotations were made",
  "\u5DF2\u8F6C\u6362": "Converted",
  "{n} \u5904\u53C2\u8003\u5DF2\u8F6C\u4E3A\u5F15\u7528": "{n} reference ranges became quotes",
  "{names} \u7684\u6587\u5B57\u5DF2\u8F6C\u4E3A\u5F15\u7528": "Text by {names} became quotes",
  "\u53E6\u6709 {n} \u4E2A\u5B57\u7684\u53C2\u8003\u65E0\u6CD5\u8F6C\u4E3A\u5F15\u7528\uFF08\u5176\u4E2D\u5DF2\u542B\u5F15\u53F7\uFF09\uFF0C\u4FDD\u7559\u4E3A\u666E\u901A\u6587\u5B57": "{n} more characters of references could not become quotes (they already contain quote marks) and stay plain text",
  "\uFF0C": ", ",
  "\u3001": ", ",
  "\uFF1A": ": ",
  // pdf
  "\u5BFC\u51FA\u4E3A PDF": "Export as PDF",
  "\u628A\u300C{name}\u300D\u5BFC\u51FA\u4E3A PDF\u3002": "Export \u201C{name}\u201D as PDF.",
  "\u5185\u5BB9": "Content",
  "\u5E26\u989C\u8272\uFF1AAI \u6587\u5B57\u6309\u6A21\u578B\u7740\u8272\uFF0C\u4E0D\u663E\u793A\u6807\u8BB0\u3002\u7EAF\u6587\u5B57\uFF1A\u65E0\u989C\u8272\uFF0C\u65E0\u6807\u8BB0\u3002": "In colour: AI text is coloured by model and markers are hidden. Plain text: no colour and no markers.",
  "\u5E26\u989C\u8272": "In colour",
  "\u7EAF\u6587\u5B57": "Plain text",
  "\u7B14\u8BB0\u540D\u4F5C\u6807\u9898": "Note name as title",
  "\u9875\u9762\u5C3A\u5BF8": "Page size",
  "\u6A2A\u5411\u6253\u5370": "Landscape",
  "\u9875\u8FB9\u8DDD": "Margins",
  "\u9ED8\u8BA4": "Default",
  "\u6700\u5C0F": "Minimum",
  "\u65E0": "None",
  "\u9875\u7801": "Page numbers",
  "\u6587\u672B\u7F72\u540D\u7EDF\u8BA1": "Authorship summary",
  "\u539F\u521B\u3001AI \u751F\u6210\uFF08\u6309\u6A21\u578B\uFF09\u4E0E\u5F15\u7528\u5404\u81EA\u7684\u5B57\u6570\u3002": "How many characters are human-written, AI-generated (by model) and quoted.",
  "\u7F29\u653E\u6BD4\u4F8B": "Scale (%)",
  "\u9884\u89C8": "Preview",
  "\u5BFC\u51FA": "Export",
  "\u53D6\u6D88": "Cancel",
  "\u7F72\u540D": "Authorship",
  "\u539F\u521B": "Human",
  "{n} \u5B57": "{n} chars",
  "\u5F15\u7528 \xB7 {name}": "Quote \xB7 {name}",
  "\u65E0\u51FA\u5904": "no source",
  "\u5F53\u524D\u7248\u672C\u7684 Obsidian \u4E0D\u5141\u8BB8\u63D2\u4EF6\u8C03\u7528\u4FDD\u5B58\u5BF9\u8BDD\u6846\uFF0C\u65E0\u6CD5\u5BFC\u51FA": "This version of Obsidian doesn't let plugins open a save dialog, so the export can't run",
  "\u65E0\u6CD5\u6253\u5F00\u7528\u4E8E\u6253\u5370\u7684\u9690\u85CF\u7A97\u53E3": "Couldn't open the hidden window used for printing",
  "\u6B63\u5728\u51C6\u5907 PDF\u2026": "Preparing the PDF\u2026",
  "\u5BFC\u51FA PDF \u5931\u8D25\uFF0C\u8BE6\u89C1\u5F00\u53D1\u8005\u5DE5\u5177\u63A7\u5236\u53F0": "PDF export failed; see the developer console for details",
  "\u5173\u95ED\uFF08Esc\uFF09": "Close (Esc)",
  "\u9884\u89C8\u4EC5\u652F\u6301\u684C\u9762\u7AEF": "Preview is only available on desktop",
  "\u65E0\u6CD5\u6253\u5F00\u9884\u89C8\u7A97\u53E3": "Couldn't open the preview window",
  "\u6B63\u5728\u51C6\u5907\u9884\u89C8\u2026": "Preparing the preview\u2026",
  "\u9884\u89C8\u5931\u8D25\uFF0C\u8BE6\u89C1\u5F00\u53D1\u8005\u5DE5\u5177\u63A7\u5236\u53F0": "Preview failed; see the developer console for details",
  "\u5BFC\u51FA\u5931\u8D25\uFF0C\u8BE6\u89C1\u5F00\u53D1\u8005\u5DE5\u5177\u63A7\u5236\u53F0": "Export failed; see the developer console for details",
  "\u6B63\u5728\u4E3A\u5F69\u8679\u5B57\u7740\u8272\u2026 {done} / {all}": "Colouring rainbow text\u2026 {done} / {all}",
  "PDF \u5DF2\u4FDD\u5B58\uFF1A{path}": "PDF saved: {path}",
  "{name} \xB7 \u9884\u89C8 \xB7 \u7EA6 {pages} \u9875\uFF08\u7EA2\u7EBF\u6807\u51FA\u6BCF\u9875\u7ED3\u675F\u7684\u4F4D\u7F6E\uFF09": "{name} \xB7 Preview \xB7 about {pages} pages (red lines mark where each page ends)",
  "{name}\uFF08\u9884\u89C8\uFF09": "{name} (preview)",
  "\u5F53\u524D\u8BBE\u5907\u65E0\u6CD5\u76F4\u63A5\u751F\u6210 PDF\uFF0C\u5DF2\u4FDD\u5B58\u4E3A\u7F51\u9875\uFF1A{path}\u3002\u8BF7\u7528\u6D4F\u89C8\u5668\u6253\u5F00\uFF0C\u9009\u62E9\u300C\u6253\u5370 \u2192 \u5B58\u4E3A PDF\u300D": "This device can't produce a PDF directly. Saved as a web page: {path}. Open it in a browser and choose Print \u2192 Save as PDF",
  // search
  "\u5FFD\u7565\u683C\u5F0F": "Ignore formatting",
  "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u7B14\u8BB0": "No matching notes",
  "\u6CA1\u6709\u627E\u5230": "No matches",
  "\u9009\u62E9": "to navigate",
  "\u6253\u5F00": "to open",
  "\u5728\u65B0\u6807\u7B7E\u9875\u6253\u5F00": "to open in new tab",
  "\u8DF3\u8F6C": "to jump",
  "\u5173\u95ED\u7A97\u53E3": "to dismiss",
  // status bar and warnings
  "\u539F\u521B {x}": "Human {x}",
  "\u5F15\u7528 {x}": "Quotes {x}",
  "\u539F\u521B {n} \u5B57": "Human {n} chars",
  "{name} {n} \u5B57": "{name} {n} chars",
  "\u5F15\u7528 {name} {n} \u5B57": "Quote {name} {n} chars",
  "{n} \u5904\u63D0\u9192\uFF08\u70B9\u51FB\u67E5\u770B\uFF09": "{n} warnings; click to view",
  "\u843D\u6B3E\u63D0\u9192": "Rakkan warnings",
  "\u6CA1\u6709\u63D0\u9192\u3002": "Nothing to warn about.",
  "\u7B2C {n} \u884C": "Line {n}",
  "\u4EC5\u5728\u7F16\u8F91\u6A21\u5F0F\u4E0B\u53EF\u8DF3\u8F6C": "Switch to editing mode to jump there",
  "\u4EC5\u5728\u7F16\u8F91\u6A21\u5F0F\u4E0B\u53EF\u4FEE\u590D": "Switch to editing mode to fix this",
  "\u6539\u6210 \\$": "Change to \\$",
  "\u8BE5\u4EE3\u7801\u5757\u5DF2\u542F\u7528 {mark} \u6807\u8BB0\uFF0C\u590D\u5236\u65F6\u81EA\u52A8\u79FB\u9664": "This code block uses the {mark} marker; it is removed when you copy",
  // diagnostics from the parser
  "\u7F72\u540D\u6807\u8BB0\u88AB\u516C\u5F0F\u541E\u6CA1\uFF1A\u6B64\u5904\u7684 $ \u53EF\u80FD\u662F\u91D1\u989D\uFF0C\u8BF7\u5199\u4F5C \\$": "The markers were swallowed by a formula: this $ may be a price; write it as \\$",
  "\u4E0A\u4E00\u4E2A AI \u5757\u7F3A\u5C11\u7ED3\u5C3E &&\uFF0C\u5DF2\u5728\u6B64\u5904\u7ED3\u675F": "The previous AI block has no closing &&; it ends here",
  "\u6B64 && \u4E4B\u524D\u6CA1\u6709\u5E26\u7F72\u540D\u7684\u5F00\u5934\uFF0C\u6309\u539F\u6837\u663E\u793A": "This && has no signed opening before it; shown as is",
  "\u4EE3\u7801\u56F4\u680F\u672A\u95ED\u5408\uFF1A\u5176\u540E\u7684\u7F72\u540D\u6807\u8BB0\u5168\u90E8\u5931\u6548": "The code fence is never closed: every marker after it is ignored",
  "AI \u5757\u7F3A\u5C11\u7ED3\u5C3E &&\uFF0C\u6309\u539F\u6837\u663E\u793A": "The AI block has no closing &&; shown as is",
  "&& \u6240\u5728\u884C\u7684\u524D\u540E\u9700\u5404\u6709\u4E00\u4E2A\u7A7A\u884C": "The line holding && needs a blank line before and after it",
  // lint (the rakkan command)
  "{mark} \u5728\u8FD9\u4E00\u884C\u6CA1\u6709\u914D\u5BF9\uFF0C\u6309\u539F\u6837\u663E\u793A": "{mark} has no partner on this line, so it shows as is",
  "AI \u6587\u5B57\u91CC\u7684 {mark} \u4E0D\u662F\u6807\u8BB0\uFF0C\u6309\u539F\u6837\u663E\u793A": "{mark} inside AI text is not a marker, so it shows as is",
  "\u539F\u521B\u5C9B\u91CC\u7684 {mark} \u4E0D\u662F\u6807\u8BB0\uFF0C\u6309\u539F\u6837\u663E\u793A": "{mark} inside a human island is not a marker, so it shows as is",
  "{mark} \u53EA\u5728 AI \u6587\u5B57\u548C\u5F15\u7528\u91CC\u6807\u51FA\u4EBA\u5199\u7684\u5B57\uFF0C\u8FD9\u91CC\u6309\u539F\u6837\u663E\u793A": "{mark} marks human words only inside AI text and quotes, so here it shows as is",
  "[@{key}] \u6CA1\u6709\u5B9A\u4E49\uFF1A\u5728\u7B14\u8BB0\u672B\u5C3E\u52A0\u4E00\u884C @{key}: \u540D\u5B57 \xB7 \u6765\u6E90\uFF0C\u6216\u5199\u8FDB\u7F72\u540D\u7C3F": "[@{key}] is not defined: add a line @{key}: Name \xB7 source at the end of the note, or to the author book",
  "[@{key}] \u6CA1\u6709\u5B9A\u4E49\uFF0C\u4E5F\u4E0D\u662F\u8BA4\u5F97\u51FA\u7684\u6A21\u578B ID": "[@{key}] is not defined, and it is not a model ID Rakkan recognises",
  "\u8FD9\u6BB5\u4EE3\u7801\u8DE8\u4E86\u884C\uFF1ARakkan \u4E00\u884C\u4E00\u884C\u8BFB\uFF0C\u770B\u4E0D\u5230\u5B83\uFF0C\u91CC\u9762\u7684\u6807\u8BB0\u7167\u6837\u751F\u6548\u3002\u628A\u5B83\u5199\u5728\u4E00\u884C\u91CC": "This code runs over lines: Rakkan reads a line at a time and doesn't see it, so markers inside still work. Put it on one line",
  // author manager
  "{n} \u4F4D\u4F5C\u8005": "{n} authors",
  "\u7BA1\u7406": "Manage",
  "\u6253\u5F00\u7F72\u540D\u7C3F": "Open author book",
  "\u7BA1\u7406\u4F5C\u8005": "Manage authors",
  "\u641C\u7D22\u4F5C\u8005": "Search authors",
  "\u540D\u5B57": "Name",
  "key\uFF08\u53EF\u9009\uFF09": "Key (optional)",
  "\u6DFB\u52A0": "Add",
  "\u8BF7\u5148\u586B\u5199\u540D\u5B57": "Enter a name first",
  "\u540D\u5B57\u65E0\u6CD5\u751F\u6210 key\uFF0C\u8BF7\u624B\u52A8\u586B\u5199 key": "A key can't be made from this name; enter one",
  "key\u300C{key}\u300D\u5DF2\u5B58\u5728": "The key \u201C{key}\u201D already exists",
  "\u4FEE\u6539 key\uFF08\u6682\u4E0D\u6DFB\u52A0\uFF09": "Change the key (don't add yet)",
  "\u4F7F\u7528 {key}": "Use {key}",
  "\u6CA1\u6709\u5339\u914D\u7684\u4F5C\u8005": "No matching authors",
  "\u5220\u9664": "Delete",
  "\u518D\u6B21\u70B9\u51FB\u4EE5\u5220\u9664": "Click again to delete",
  // settings
  "\u8BED\u8A00": "Language",
  "\u547D\u4EE4\u540D\u79F0\u9700\u91CD\u65B0\u52A0\u8F7D\u63D2\u4EF6\u540E\u751F\u6548\u3002": "Command names change after the plugin is reloaded.",
  "\u8DDF\u968F Obsidian": "Follow Obsidian",
  "\u5F69\u8272\u5B57": "Coloured text",
  "\u6E10\u53D8\u5B57": "Gradient text",
  "\u5F69\u8679\u5B57": "Rainbow text",
  "\u4E0B\u5212\u7EBF": "Underline",
  "\u5173\u95ED": "Off",
  "\u663E\u793A": "Display",
  "\u663E\u793A\u6A21\u5F0F": "Display mode",
  "\u5199\u4F5C\uFF1A\u6807\u8BB0\u4E0E\u989C\u8272\u6DE1\u5316\uFF1B\u5BA1\u9605\uFF1A\u5B8C\u6574\u989C\u8272\u3002\u53EF\u4E3A\u547D\u4EE4\u300C\u5207\u6362\u5199\u4F5C / \u5BA1\u9605\u663E\u793A\u300D\u8BBE\u7F6E\u5FEB\u6377\u952E\u3002": "Writing: markers and colours are faint. Review: full colour. You can bind a hotkey to the command \u201CToggle writing / review display\u201D.",
  "\u5BA1\u9605": "Review",
  "\u5199\u4F5C": "Writing",
  "\u5B9E\u65F6\u9884\u89C8\u9690\u85CF\u6807\u8BB0": "Hide markers in Live Preview",
  "\u5149\u6807\u4E0D\u5728\u8BE5\u6BB5\u65F6\uFF0C\u9690\u85CF && @@ \u4E0E [@key]\uFF0C\u5E76\u9690\u85CF\u5757\u7684\u5F00\u5408\u884C\u3002": "When the cursor is elsewhere, hide && @@ and [@key], along with a block's opening and closing lines.",
  "\u72B6\u6001\u680F": "Status bar",
  "\u663E\u793A\u539F\u521B\u3001AI\u3001\u5F15\u7528\u7684\u6BD4\u4F8B\u53CA\u63D0\u9192\u3002": "Show the share of human, AI and quoted text, and warnings.",
  "\u6837\u5F0F": "Styles",
  "\u6309\u6A21\u578B\u5BB6\u65CF\u4E0A\u8272": "Colour by model family",
  "\u5173\u95ED\u540E\uFF0C\u6240\u6709 AI \u4F7F\u7528\u540C\u4E00\u989C\u8272\u3002": "When off, all AI text uses one colour.",
  "AI \u6587\u5B57\u6837\u5F0F": "AI text style",
  "\u5F15\u7528\u6837\u5F0F": "Quote style",
  "\u7EDF\u4E00\u6837\u5F0F": "Override all styles",
  "\u4F18\u5148\u4E8E\u4E0B\u65B9\u6240\u6709\u6309\u5BB6\u65CF\u3001\u6309\u6A21\u578B\u7684\u8BBE\u7F6E\u3002": "Takes priority over every per-family and per-model setting below.",
  "\u4E0D\u4F7F\u7528": "Not used",
  "\u6A21\u578B\u5BB6\u65CF": "Model families",
  "\u5176\u4ED6 AI": "Other AI",
  "\u5F15\u7528": "Quotes",
  "\u8DDF\u968F\u9ED8\u8BA4": "Follow default",
  "\u6062\u590D\u9ED8\u8BA4\u989C\u8272": "Reset colours",
  "\u5DE6\uFF1A\u6D45\u8272\u4E3B\u9898\u989C\u8272\uFF1B\u53F3\uFF1A\u6DF1\u8272\u4E3B\u9898\u989C\u8272": "Left: colour on a light theme; right: on a dark theme",
  "\uFF1B\u6700\u53F3\uFF1A\u8BE5\u5BB6\u65CF\u7684\u6837\u5F0F": "; further right: this family's style",
  "\u4F5C\u8005": "Authors",
  "\u6062\u590D\u81EA\u52A8\u989C\u8272": "Reset to automatic colour",
  "\u989C\u8272\u6D53\u6DE1": "Colour intensity",
  "\u5199\u4F5C\u6A21\u5F0F\u989C\u8272\u6D53\u5EA6": "Writing mode colour strength",
  "0 \u4E3A\u4E0D\u7740\u8272\uFF0C1 \u4E0E\u5BA1\u9605\u6A21\u5F0F\u76F8\u540C\u3002": "0 is no colour at all; 1 matches review mode.",
  "\u6765\u6E90\u900F\u660E\u5EA6": "Source opacity",
  "\u65E0\u4F5C\u8005\u51FA\u5904\uFF08\u4E66\u3001\u7F51\u9875\uFF09\u7684\u663E\u793A\u6D53\u6DE1\uFF0C1 \u4E3A\u4E0D\u8C03\u6697\u3002": "How faint a source without an author (a book, a web page) looks; 1 means not dimmed.",
  "\u6309\u6A21\u578B\u6307\u5B9A\u6837\u5F0F": "Per-model styles",
  "\u6BCF\u884C\u4E00\u9879\uFF1A\u6A21\u578B ID \u6216 @key = \u6837\u5F0F\uFF08color\u3001gradient\u3001rainbow\u3001underline\u3001none\uFF09\u3002": "One per line: model ID or @key = style (color, gradient, rainbow, underline, none).",
  "\u81EA\u5B9A\u4E49\u5BB6\u65CF\u524D\u7F00": "Custom family prefixes",
  "\u6BCF\u884C\u4E00\u9879\uFF1A\u6A21\u578B ID \u524D\u7F00 = \u5BB6\u65CF\u540D\uFF0C\u4F8B\u5982 ernie = ERNIE\u3002": "One per line: model ID prefix = family name, e.g. ernie = ERNIE.",
  "\u7F16\u8F91": "Editing",
  "\u81EA\u52A8\u6807\u6CE8\u539F\u521B": "Auto-mark human-written text",
  "\u5728 AI \u5757\u4E0E &&\u2026&& \u5185\u8F93\u5165\u7684\u6587\u5B57\u81EA\u52A8\u5305\u5165 @@\u2026@@\u3002\u4F7F\u7528\u8F93\u5165\u6CD5\u65F6\uFF0C\u505C\u987F\u7EA6 0.6 \u79D2\u540E\u624D\u5904\u7406\uFF0C\u7EC4\u5B57\u8FC7\u7A0B\u4E2D\u4E0D\u6539\u52A8\u6587\u6863\u3002": "Text you type inside AI blocks and &&\u2026&& is wrapped in @@\u2026@@ automatically. With an IME the wrap happens after a pause of about 0.6 s, so the document isn't touched while you compose.",
  "\u590D\u5236\u65F6\u53BB\u9664\u6807\u8BB0": "Remove markers on copy",
  "\u526A\u8D34\u677F\u4E2D\u7684\u7EAF\u6587\u672C\u4E0D\u542B && @@\uFF1B\u5728\u5E93\u5185\u7C98\u8D34\u65F6\uFF0C\u6309\u843D\u70B9\u91CD\u65B0\u5199\u5165\u6807\u8BB0\u3002": "The plain text on the clipboard carries no && @@; pasting inside the vault writes the markers again to suit where it lands.",
  "\u641C\u7D22": "Search",
  "\u641C\u7D22\u65B9\u5F0F": "Search method",
  "Obsidian \u641C\u7D22\u680F\uFF1A\u5728\u641C\u7D22\u680F\u4E0E\u7B14\u8BB0\u7684\u67E5\u627E\u680F\uFF08Ctrl+F\uFF09\u4E2D\u52A0\u5165\u300C\u5FFD\u7565\u683C\u5F0F\u300D\u5F00\u5173\uFF0C\u4F9D\u8D56 Obsidian \u7684\u5185\u90E8\u5B9E\u73B0\u3002Rakkan \u641C\u7D22\u7A97\u53E3\uFF1A\u72EC\u7ACB\u7684\u641C\u7D22\u7A97\u53E3\uFF0C\u4E0D\u6539\u52A8 Obsidian\u3002": "Obsidian search: adds an \u201CIgnore formatting\u201D toggle to the search pane and the note\u2019s find bar (Ctrl+F); relies on Obsidian internals. Rakkan search window: a separate search window that leaves Obsidian unchanged.",
  "Obsidian \u641C\u7D22\u680F": "Obsidian search",
  "Rakkan \u641C\u7D22\u7A97\u53E3": "Rakkan search window",
  "\u517C\u5BB9 Omnisearch": "Omnisearch compatibility",
  "Omnisearch \u53EF\u641C\u5230\u88AB\u6807\u8BB0\u9694\u5F00\u7684\u8BCD\uFF0C\u6458\u8981\u4E2D\u4E0D\u663E\u793A\u6807\u8BB0\u3002": "Omnisearch finds words split by markers, and its excerpts leave the markers out.",
  "\u7F72\u540D\u7C3F": "Author book",
  "\u7F72\u540D\u7C3F\u4F4D\u7F6E": "Author book path",
  "\u5E93\u4E2D\u7684\u4E00\u7BC7\u7B14\u8BB0\uFF0C\u6BCF\u884C\u4E00\u4F4D\u4F5C\u8005\uFF1A- @key: \u540D\u5B57 (\u6807\u8BC6) \xB7 \u79CD\u7C7B \xB7 #\u989C\u8272\u3002\u79CD\u7C7B\u4E3A \u4EBA\u3001AI \u6216 \u6765\u6E90\uFF0C\u989C\u8272\u53EF\u7701\u7565\u3002\u4FEE\u6539\u540E\u81EA\u52A8\u91CD\u65B0\u8BFB\u53D6\u3002": "A note in the vault, one author per line: - @key: Name (id) \xB7 kind \xB7 #color. The kind is human, AI or source; the colour is optional. It is re-read when you change it.",
  "\u65B0\u5EFA": "Create",
  "\u9ED8\u8BA4\u7F72\u540D": "Default signature",
  "\u300C\u6807\u8BB0\u4E3A AI \u751F\u6210\u300D\u5C06\u6574\u6BB5\u8F6C\u4E3A AI \u5757\u65F6\u4F7F\u7528\u7684\u7F72\u540D\uFF0C\u4F8B\u5982 Claude (claude-opus-5-5)\u3002": "The signature \u201CMark as AI-generated\u201D uses when it turns a passage into an AI block, e.g. Claude (claude-opus-5-5)."
};

// src/i18n.ts
var current = "zh";
function setLanguage(pref, system = "en") {
  current = pref !== "auto" ? pref : system.toLowerCase().startsWith("zh") ? "zh" : "en";
}
function t(zh, vars) {
  const text = current === "en" ? en[zh] ?? zh : zh;
  return vars ? text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? "")) : text;
}

// cli/rakkan.ts
var USAGE = `Usage:
  rakkan lint <file or folder>... [--book <author book>]
  rakkan sign [--model <model ID>] <original> <revised>

lint   Checks Markdown notes for Rakkan markers that don't do what they look
       like: AI blocks without a closer or blank lines, markers without a
       partner, and [@key] that neither the note nor the author book defines.
       The author book is found through the Obsidian vault the note is in, or
       given with --book. Prints file:line:column, a code and a message for
       each problem.

sign   Compares <revised> with <original> and marks only what changed as
       written by the model, as Paste revision does in Obsidian. Every
       character that was kept keeps its author; markers the revision dropped
       are put back. Writes the result into <revised>.

Both exit with 1 when something needs a look, and with 2 on a usage error.`;
function* walk(path) {
  if (statSync(path).isFile()) {
    if (path.endsWith(".md")) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    yield* walk(join(path, name));
  }
}
var vaults = /* @__PURE__ */ new Map();
function vaultOf(file) {
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".obsidian"))) {
      let vault = vaults.get(dir);
      if (!vault) vaults.set(dir, vault = loadVault(dir));
      return vault;
    }
    if (dirname(dir) === dir) return { authors: {}, extra: [] };
  }
}
function loadVault(root) {
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(join(root, ".obsidian/plugins/rakkan/data.json"), "utf8"));
  } catch {
  }
  const extra = settings.extraPrefixes ?? [];
  const book = join(root, settings.bookPath ?? "AUTHORS.md");
  return { authors: existsSync(book) ? parseBook(readFileSync(book, "utf8"), extra) : {}, extra };
}
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function lintCommand(paths, bookFile) {
  setLanguage("en");
  const book = bookFile ? parseBook(readFileSync(bookFile, "utf8")) : void 0;
  const parser = new Parser();
  let notes = 0;
  let problems = 0;
  for (const path of paths) {
    for (const file of walk(path)) {
      notes++;
      const r = parser.parse(readFileSync(file, "utf8"));
      const vault = vaultOf(file);
      const name = relative(process.cwd(), file);
      for (const i of lint(r, book ?? vault.authors, vault.extra)) {
        problems++;
        console.log(`${name}:${i.line + 1}:${i.from - r.lines[i.line].from + 1}  ${i.code}  ${t(i.message, i.vars)}`);
      }
    }
  }
  const of = plural(notes, "note");
  console.log(problems ? `
${plural(problems, "problem")} in ${of}.` : `No problems in ${of}.`);
  return problems ? 1 : 0;
}
function rejectedNote(g, then) {
  const what = g.count ? `${plural(g.count, "line")} of the original kept here` : "lines the revision added left out here";
  return `This change holds a quote, code, or a link with two authors' words, which sign can't mark, so ${what}. The revision had: ${JSON.stringify(g.revised)}; ${then}.`;
}
function signCommand(original, revised, model) {
  const before = readFileSync(revised, "utf8");
  const r = signRevision(readFileSync(original, "utf8"), before, model);
  const name = relative(process.cwd(), revised);
  if (r.text !== before) writeFileSync(revised, r.text);
  const notes = [
    ...r.rejected.map((g) => [g.line, "unmarked", rejectedNote(g, "make the change by hand and mark your words")]),
    ...r.foreign.map((n) => [n, "foreign-block", "Your changes here are inside an AI block another model signed, so they count as that model's."]),
    ...r.tasks.map((n) => [n, "task", "You ticked or unticked this task. A task's box is syntax, so who ticked it isn't recorded."])
  ].sort((x, y) => x[0] - y[0]);
  for (const [n, code, message] of notes) console.log(`${name}:${n + 1}  ${code}  ${message}`);
  console.log(
    r.changed ? `${notes.length ? "\n" : ""}Signed ${plural(r.changed, "change")} in ${name}${model ? ` as ${model}` : ""}.` : `No changes from ${relative(process.cwd(), original)}.`
  );
  return notes.length ? 1 : 0;
}
function option(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return void 0;
  const value = args[at + 1];
  args.splice(at, 2);
  return value && !value.startsWith("--") ? value : null;
}
function main(args) {
  const [command, ...rest] = args;
  if (command === "-h" || command === "--help") {
    console.log(USAGE);
    return 0;
  }
  const book = option(rest, "--book");
  const model = option(rest, "--model");
  const usable = command === "lint" ? rest.length > 0 && book !== null && model === void 0 : command === "sign" && rest.length === 2 && book === void 0 && model !== null && !/[\s[\]]/.test(model ?? "");
  if (!usable) {
    console.error(USAGE);
    return 2;
  }
  const missing = [...rest, ...book ? [book] : []].filter((p) => !existsSync(p));
  if (missing.length) {
    console.error(`rakkan: no such file or folder: ${missing.join(", ")}`);
    return 2;
  }
  return command === "lint" ? lintCommand(rest, book ?? void 0) : signCommand(rest[0], rest[1], model ?? void 0);
}
process.exitCode = main(process.argv.slice(2));
