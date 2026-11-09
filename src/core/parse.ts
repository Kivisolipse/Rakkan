import { parseLine, scanInline, type LineCtx, type LineResult } from "./inline";
import { parseSignature, signatureLabel } from "./signature";
import { lineSyntax } from "./syntax";
import type {
  Attr,
  Block,
  Diagnostic,
  LineContext,
  LineInfo,
  MarkType,
  ParseResult,
  Role,
  Segment,
  Stats,
} from "./types";

const HUMAN: Attr = Object.freeze({ kind: "human", explicit: false });

type LineType =
  | "meta"
  | "fence" // opening or closing fence line
  | "code" // content of a fenced code block
  | "plain" // math block lines
  | "block-open"
  | "block-close"
  | "prose";

interface LineStruct {
  type: LineType;
  block: number | null;
  inComment: boolean;
  amp: number; // declared marker lengths inside code
  at: number;
  /** For code lines: the line of the opening fence. */
  fenceLine?: number;
  /** For fence lines: [from, to) ranges of declaration words. */
  decls?: Array<[number, number]>;
  quoteKey?: string;
  /** Length of the `>` container prefix to treat as syntax. */
  prefix: number;
  /** For the last line of a cited blockquote: where `[@key]` sits. */
  citeLine?: [number, number];
}

const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const DEF_RE = /^(?:[-*+]\s+)?@([^\s:[\]]+):\s+(.*)$/;
const BLANK_RE = /^\s*$/;

/** Leading whitespace and `>` markers (blockquotes, callouts, list indentation). */
function containerPrefix(line: string): number {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t" || c === ">") i++;
    else break;
  }
  return i;
}

/** Only the `>` part, plus one following space, for display as syntax. */
function quotePrefix(line: string): number {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  if (line[i] !== ">") return 0;
  while (i < line.length && (line[i] === ">" || line[i] === " " || line[i] === "\t")) i++;
  return i;
}

/** `&& sig` → opener, `&&` → closer, else null. Up to 3 spaces of indent. */
function blockLine(line: string): { type: "open"; sig: string } | { type: "close" } | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  if (line[i] !== "&" || line[i + 1] !== "&" || line[i + 2] === "&") return null;
  const rest = line.slice(i + 2);
  if (BLANK_RE.test(rest)) return { type: "close" };
  if (rest[0] !== " " && rest[0] !== "\t" && rest[0] !== "\u3000") return null;
  if (rest.includes("&&")) return null;
  return { type: "open", sig: rest.trim() };
}

function codePoints(s: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) continue; // low surrogate
    const c = s[i];
    if (c === " " || c === "\t" || c === "\u3000" || c === "\r" || c === "\n") continue;
    count++;
  }
  return count;
}

function emptyStats(): Stats {
  return { human: 0, ai: 0, quote: 0, aiByAuthor: {}, quoteByKey: {} };
}

export class Parser {
  private memo = new Map<string, LineResult>();
  private commentMemo = new Map<string, boolean>();

  /** Drop cached line results (they are rebuilt on demand). */
  clear() {
    this.memo.clear();
    this.commentMemo.clear();
  }

  private parseLineCached(text: string, ctx: LineCtx): LineResult {
    const key =
      `${ctx.mode}|${ctx.pair}|${ctx.base.kind}|${ctx.base.key ?? ""}|${ctx.base.block ?? ""}|` +
      `${ctx.ampLen}|${ctx.atLen}|${ctx.inComment ? 1 : 0}\u0000${text}`;
    let r = this.memo.get(key);
    if (!r) {
      if (this.memo.size > 50000) this.memo.clear();
      r = parseLine(text, ctx);
      this.memo.set(key, r);
    }
    return r;
  }

  private endsInComment(text: string, inComment: boolean): boolean {
    if (!inComment && !text.includes("%%")) return false;
    if (inComment && !text.includes("%%")) return true;
    const key = (inComment ? "1" : "0") + text;
    let r = this.commentMemo.get(key);
    if (r === undefined) {
      if (this.commentMemo.size > 20000) this.commentMemo.clear();
      r = scanInline(text, { ampLen: 2, atLen: 2, prose: true, inComment }).endsInComment;
      this.commentMemo.set(key, r);
    }
    return r;
  }

  parse(text: string): ParseResult {
    // A line ends at \r\n, \r or \n, as in CommonMark; the text itself is left as it is.
    const lines: LineInfo[] = [];
    const lineText: string[] = [];
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
    const diagnostics: Diagnostic[] = [];
    const diag = (line: number, from: number, to: number, code: Diagnostic["code"], message: string) =>
      diagnostics.push({ line, from, to, code, message });

    // ── Global regions: frontmatter, iA annotation block, trailing definitions ──
    let bodyStart = 0;
    if (N > 1 && lineText[0].trimEnd() === "---") {
      for (let i = 1; i < N; i++) {
        const t = lineText[i].trimEnd();
        if (t === "---" || t === "...") {
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
    const definitions: Record<string, string> = {};
    let defStart = bodyEnd;
    {
      let i = bodyEnd - 1;
      let sawDef = false;
      while (i >= bodyStart) {
        const t = lineText[i];
        if (BLANK_RE.test(t)) {
          i--;
          continue;
        }
        const m = DEF_RE.exec(t);
        if (!m) break;
        sawDef = true;
        definitions[m[1]] ??= m[2].trim();
        defStart = i;
        i--;
      }
      if (!sawDef) defStart = bodyEnd;
    }

    // ── Pass A: structure ──
    const structs = new Array<LineStruct>(N);
    const blocks: Block[] = [];
    let fence: { char: string; len: number; amp: number; at: number; line: number } | null = null;
    let math = false;
    // A math block that declares `@@` after a LaTeX comment sign (`$$ %@@`) takes islands, like a declared code block.
    let mathAt = 0;
    let mathLine = -1;
    let inComment = false;
    let open: Block | null = null;

    const closeBlock = (lastLine: number, closeLine: number | null) => {
      if (!open) return;
      open.lastLine = lastLine;
      open.closeLine = closeLine;
      open.to = lines[lastLine].to;
      open = null;
    };

    for (let i = 0; i < N; i++) {
      const t = lineText[i];
      const base: LineStruct = { type: "prose", block: open?.index ?? null, inComment, amp: 0, at: 0, prefix: 0 };
      if (i < bodyStart || i >= defStart) {
        structs[i] = { ...base, type: "meta", block: null };
        continue;
      }

      if (fence) {
        const rest = t.slice(containerPrefix(t));
        const m = FENCE_RE.exec(rest);
        if (m && m[1][0] === fence.char && m[1].length >= fence.len && BLANK_RE.test(m[2])) {
          structs[i] = { ...base, type: "fence" };
          fence = null;
        } else {
          structs[i] = { ...base, type: "code", amp: fence.amp, at: fence.at, fenceLine: fence.line };
        }
        continue;
      }

      if (math) {
        if (mathAt && t.slice(containerPrefix(t)).trim() === "$$") {
          structs[i] = { ...base, type: "fence" };
          math = false;
          mathAt = 0;
          continue;
        }
        structs[i] = mathAt ? { ...base, type: "code", amp: 0, at: mathAt, fenceLine: mathLine } : { ...base, type: "plain" };
        if (t.includes("$$")) {
          math = false;
          mathAt = 0;
        }
        continue;
      }

      if (inComment) {
        structs[i] = { ...base };
        inComment = this.endsInComment(t, true);
        continue;
      }

      const bl = blockLine(t);
      if (bl?.type === "open") {
        if (open) {
          diag(i, lines[i].from, lines[i].to, "implicit-close", "上一个 AI 块缺少结尾 &&，已在此处结束");
          closeBlock(i - 1, null);
        }
        const b: Block = {
          index: blocks.length,
          signature: parseSignature(bl.sig),
          openLine: i,
          closeLine: null,
          lastLine: N - 1,
          from: lines[i].from,
          to: lines[N - 1].to,
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
          diag(i, lines[i].from, lines[i].to, "lone-closer", "此 && 之前没有带署名的开头，按原样显示");
          structs[i] = { ...base };
        }
        continue;
      }

      const cp = containerPrefix(t);
      const rest = t.slice(cp);
      const fm = FENCE_RE.exec(rest);
      if (fm && !(fm[1][0] === "`" && fm[2].includes("`"))) {
        const info = fm[2];
        let amp = 0;
        let at = 0;
        const decls: Array<[number, number]> = [];
        const infoStart = cp + fm[1].length;
        const wordRe = /\S+/g;
        let wm: RegExpExecArray | null;
        while ((wm = wordRe.exec(info))) {
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

      structs[i] = { ...base, prefix: quotePrefix(t) };
      inComment = this.endsInComment(t, false);
    }

    if (fence) {
      const l = fence.line;
      diag(l, lines[l].from, lines[l].to, "unclosed-fence", "代码围栏未闭合：其后的署名标记全部失效");
    }

    if (open) {
      // An opener that never gets closed stays literal.
      const b = open;
      diag(b.openLine, lines[b.openLine].from, lines[b.openLine].to, "unclosed-block", "AI 块缺少结尾 &&，按原样显示");
      blocks.pop();
      structs[b.openLine] = { ...structs[b.openLine], type: "prose", block: null, prefix: 0 };
      for (let i = b.openLine; i < N; i++) if (structs[i].block === b.index) structs[i].block = null;
      open = null;
    }

    for (const b of blocks) {
      for (const l of [b.openLine, b.closeLine]) {
        if (l === null) continue;
        // No table can swallow a line right below the frontmatter, so it needs no blank line above.
        const prevBad = l > bodyStart && !BLANK_RE.test(lineText[l - 1]);
        const nextBad = l < N - 1 && !BLANK_RE.test(lineText[l + 1]);
        if (prevBad || nextBad) {
          diag(l, lines[l].from, lines[l].to, "blank-line", "&& 所在行的前后需各有一个空行");
        }
      }
    }

    // ── Pass B: blockquotes whose last line is `[@key]` ──
    // Code and math inside the blockquote belong to it too.
    const quoted = (k: number) => {
      const s = structs[k];
      if (s.inComment) return false;
      if (s.type === "prose") return s.prefix > 0;
      return (s.type === "fence" || s.type === "code" || s.type === "plain") && quotePrefix(lineText[k]) > 0;
    };
    for (let i = 0; i < N; i++) {
      if (!quoted(i)) continue;
      let j = i;
      while (j + 1 < N && quoted(j + 1)) j++;
      const content = lineText[j].slice(structs[j].prefix);
      const m = structs[j].type === "prose" ? /^\[@([^\s[\]]+)\]\s*$/.exec(content) : null;
      if (m && j > i) {
        for (let k = i; k <= j; k++) structs[k].quoteKey = m[1];
        const from = structs[j].prefix;
        structs[j].citeLine = [from, from + m[0].trimEnd().length];
      }
      i = j;
    }

    // ── Pass C: inline ──
    const segments: Segment[] = [];
    const spans: ParseResult["spans"] = [];
    const blockAttr = blocks.map((b) => Object.freeze({ kind: "ai", block: b.index, explicit: false }) as Attr);
    const push = (from: number, to: number, role: Role, attr: Attr, mark?: MarkType) => {
      if (to <= from) return;
      const s: Segment = { from, to, role, attr };
      if (mark) s.mark = mark;
      segments.push(s);
    };

    const lineContexts = new Array<LineContext>(N);
    for (let i = 0; i < N; i++) {
      const st = structs[i];
      const { from, to } = lines[i];
      const t = lineText[i];
      const outer = st.block !== null ? blockAttr[st.block] : HUMAN;
      // Code, math and fences in a cited blockquote take the quote's author, as its prose does.
      const base: Attr =
        st.quoteKey !== undefined && st.type !== "prose"
          ? { kind: "quote", key: st.quoteKey, explicit: true, ...(st.block !== null ? { block: st.block } : {}) }
          : outer;
      // The `> ` before a code or math line is syntax, as it is before prose.
      const qp = st.type === "code" || st.type === "plain" ? quotePrefix(t) : 0;
      const blockPair = st.block !== null ? "ai-block" : "human";
      // Declared code in a cited blockquote follows the quote's rules: `@@` marks the person's own words.
      const codePair = st.quoteKey !== undefined ? "quote" : blockPair;
      lineContexts[i] = {
        mode: st.type === "prose" && !st.citeLine ? "prose" : st.type === "code" && (st.amp || st.at) ? "code" : "other",
        base: st.type === "meta" ? HUMAN : base,
        pair: codePair,
        prefix: 0,
        inComment: st.inComment,
        ampLen: st.type === "code" ? st.amp : 2,
        atLen: st.type === "code" ? st.at : 2,
        ...(st.fenceLine !== undefined ? { codeFence: st.fenceLine } : {}),
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
          const r = this.parseLineCached(t.slice(qp), {
            base,
            pair: codePair,
            mode: "code",
            ampLen: st.amp,
            atLen: st.at,
            inComment: false,
          });
          const o = from + qp;
          for (const s of r.segments) push(o + s.from, o + s.to, s.role, s.attr, s.mark);
          for (const s of r.spans) spans.push({ ...s, from: o + s.from, to: o + s.to, contentFrom: o + s.contentFrom, contentTo: o + s.contentTo });
          continue;
        }
        case "prose": {
          let lineBase = base;
          let pair: LineCtx["pair"] = st.block !== null ? "ai-block" : "human";
          if (st.quoteKey !== undefined) {
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
          const r = this.parseLineCached(t.slice(pre), {
            base: lineBase,
            pair,
            mode: "prose",
            ampLen: 2,
            atLen: 2,
            inComment: st.inComment,
          });
          const o = from + pre;
          // Leaders, table pipes and delimiter rows are syntax: not counted, no one's (§7).
          const cuts = st.inComment ? [] : lineSyntax(t.slice(pre));
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
          for (const d of r.diagnostics) diag(i, o + d.from, o + d.to, d.code, d.message);
          continue;
        }
      }
    }

    // ── Stats ──
    const stats = emptyStats();
    for (const s of segments) {
      if (s.role !== "text") continue;
      const n = codePoints(text, s.from, s.to);
      if (!n) continue;
      const a = s.attr;
      if (a.kind === "human") stats.human += n;
      else if (a.kind === "ai") {
        stats.ai += n;
        const label = a.key
          ? `@${a.key}`
          : a.block !== undefined
            ? signatureLabel(blocks[a.block].signature)
            : "AI";
        stats.aiByAuthor[label] = (stats.aiByAuthor[label] ?? 0) + n;
      } else {
        stats.quote += n;
        const k = a.key ?? "";
        stats.quoteByKey[k] = (stats.quoteByKey[k] ?? 0) + n;
      }
    }

    diagnostics.sort((a, b) => a.from - b.from);
    return { text, lines, lineContexts, segments, spans, blocks, diagnostics, definitions, stats, bodyStart };
  }
}

/** Index of the item holding `pos` in sorted, non-overlapping ranges, or -1. */
export function indexAt(ranges: ReadonlyArray<{ from: number; to: number }>, pos: number, inclusiveEnd = false): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (pos < r.from) hi = mid - 1;
    else if (pos > r.to || (pos === r.to && !inclusiveEnd)) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function parse(text: string): ParseResult {
  return new Parser().parse(text);
}
