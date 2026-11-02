// Reading view: colour rendered sections. Block membership comes from the
// source (getSectionInfo); inline markers are found in the rendered text, with
// code and math elements standing in as single placeholder characters.

import { Notice, type MarkdownPostProcessorContext } from "obsidian";
import { Parser, codeBlockText, fenceLines, parseLine, scanInline, type Attr, type LineContext, type ParseResult } from "../core";
import { resolve, type StyleSettings } from "../cm6/resolve";
import { opensFormula, styleMath } from "./mathview";
import { t } from "../i18n";

const HUMAN: Attr = { kind: "human", explicit: false };
const PLACEHOLDER = "￼";
const LEAF = "p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, .callout-title-inner, figcaption";
const SKIP = "pre, .math, mjx-container, .frontmatter, .internal-embed, .markdown-embed, .rk-done";
const ATOMIC = "code, .math, mjx-container, img, .internal-embed";

const parser = new Parser();
let lastText = "";
let lastResult: ParseResult | null = null;

export function parseCached(text: string): ParseResult {
  if (text !== lastText || !lastResult) {
    lastText = text;
    lastResult = parser.parse(text);
  }
  return lastResult;
}

interface Item {
  node: Node;
  start: number;
  len: number;
}

interface Group {
  root: Element;
  items: Item[];
  text: string;
}

function collectGroups(el: HTMLElement): Group[] {
  const groups = new Map<Element, Group>();
  const order: Group[] = [];
  const groupFor = (n: Node): Group => {
    const parent = n.parentElement!;
    const root = (parent.closest(LEAF) && el.contains(parent.closest(LEAF)) ? parent.closest(LEAF) : el) as Element;
    let g = groups.get(root);
    if (!g) {
      g = { root, items: [], text: "" };
      groups.set(root, g);
      order.push(g);
    }
    return g;
  };
  const walk = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent ?? "";
        if (!t) continue;
        const g = groupFor(child);
        g.items.push({ node: child, start: g.text.length, len: t.length });
        g.text += t;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const e = child as Element;
        if (e.matches(SKIP)) continue;
        if (e.matches(ATOMIC)) {
          const g = groupFor(e);
          g.items.push({ node: e, start: g.text.length, len: 1 });
          g.text += PLACEHOLDER;
          continue;
        }
        walk(e);
      }
    }
  };
  walk(el);
  return order;
}

const MARK = "rk-mark";

type Piece = { a: number; b: number; cls: string; title?: string; style?: string };

/**
 * Wrap `[a, b)` of a text node in a span, or cut it out when it is a marker:
 * the page then holds only what it shows, so finding in it (Ctrl+F) and
 * copying from it never meet markers. Pieces must be sorted and disjoint.
 */
function wrapText(node: Text, pieces: Piece[]) {
  for (let k = pieces.length - 1; k >= 0; k--) {
    const { a, b, cls, title, style } = pieces[k];
    if (b < node.length) node.splitText(b);
    const mid = a > 0 ? node.splitText(a) : node;
    if (cls === MARK) {
      mid.remove();
      continue;
    }
    const span = document.createElement("span");
    span.className = cls;
    if (style) span.setAttribute("style", style);
    if (title) span.setAttribute("aria-label", title);
    mid.parentNode!.insertBefore(span, mid);
    span.appendChild(mid);
  }
}

/**
 * Runs of `&` / `@` in the section source that were escaped with a backslash;
 * rendering consumes the backslash, so the DOM alone cannot tell.
 */
function escapedRunFlags(source: string[]): boolean[] | null {
  if (!source.some((l) => /\\[&@]/.test(l))) return null;
  const flags: boolean[] = [];
  for (const line of source) {
    const scan = scanInline(line, { ampLen: 2, atLen: 2, prose: true });
    const runs = [...scan.tokens, ...scan.literals].sort((x, y) => x.from - y.from);
    for (const r of runs) flags.push(line[r.from - 1] === "\\");
  }
  return flags;
}

function domRuns(text: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "&" || c === "@") {
      out.push(i);
      while (i < text.length && text[i] === c) i++;
    } else i++;
  }
  return out;
}

export interface ReadingDeps {
  styles(): StyleSettings;
}

/**
 * A code block that declares markers has them in its source, and Obsidian's
 * copy button would copy them too. Copy the code without them instead.
 */
function takeOverCopyButton(pre: HTMLElement, doc: ParseResult, fenceLine: number) {
  const code = codeBlockText(doc, fenceLine);
  if (!code || code.plain === code.raw) return;
  pre.addEventListener(
    "click",
    (e) => {
      if (!(e.target as HTMLElement).closest(".copy-code-button")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void navigator.clipboard.writeText(code.plain).then(() => new Notice(t("已复制（已移除标记）")));
    },
    true,
  );
}

interface Cut {
  from: number;
  to: number;
  drop: boolean;
}

/** Cut the dropped ranges out of the text nodes and wrap the others (coordinates of the joined text). */
function wrapCuts(codeEl: Element, nodes: Text[], cuts: Cut[]) {
  let start = 0;
  for (const node of nodes) {
    const len = node.data.length;
    const stop = start + len;
    const mine = cuts.filter((c) => c.to > start && c.from < stop).sort((a, b) => a.from - b.from);
    if (mine.length) {
      const frag = document.createDocumentFragment();
      let cur = start;
      for (const c of mine) {
        const a = Math.max(c.from, start);
        const b = Math.min(c.to, stop);
        if (a > cur) frag.append(node.data.slice(cur - start, a - start));
        if (!c.drop && b > a) {
          const span = document.createElement("span");
          span.className = "rk rk-island rk-code-island";
          span.title = t("原创");
          span.textContent = node.data.slice(a - start, b - start);
          frag.append(span);
        }
        cur = Math.max(cur, b);
      }
      if (cur < stop) frag.append(node.data.slice(cur - start));
      node.replaceWith(frag);
    }
    start = stop;
  }
}

/**
 * Rendered code shows its source, markers included. Take the declared markers
 * out of the text and colour what they enclose. Obsidian highlights code after
 * this runs (and at start-up, only once the language has loaded), replacing the
 * element's classes and children, so watch the element and redo it when that happens.
 */
function renderCodeIslands(pre: HTMLElement, doc: ParseResult, fenceLine: number, blockCls: string, blockStyle?: string) {
  const codeEl = pre.querySelector("code");
  if (!codeEl) return;
  const lines = fenceLines(doc, fenceLine);
  if (!lines.length) return;

  // The code as rendered (its lines joined, without a blockquote's markers),
  // and where the markers and islands are in it.
  const segs = doc.segments.filter((s) => s.to > lines[0].from && s.from < lines[lines.length - 1].to);
  let raw = "";
  const rawCuts: Cut[] = [];
  lines.forEach(({ from, to }, k) => {
    if (k) raw += "\n";
    const at = raw.length - from;
    for (const seg of segs) {
      if (seg.to <= from || seg.from >= to) continue;
      const cut = { from: Math.max(seg.from, from) + at, to: Math.min(seg.to, to) + at };
      if (seg.role === "mark" && (seg.mark === "open" || seg.mark === "close")) rawCuts.push({ ...cut, drop: true });
      else if (seg.role === "text" && seg.attr.kind === "human") rawCuts.push({ ...cut, drop: false });
    }
    raw += doc.text.slice(from, to);
  });
  if (!rawCuts.some((c) => c.drop)) return;

  // The same islands in the text once the markers are gone.
  const dropped = rawCuts.filter((c) => c.drop);
  const shift = (x: number) => dropped.reduce((n, c) => (c.to <= x ? n + (c.to - c.from) : n), 0);
  const plainCuts: Cut[] = rawCuts.filter((c) => !c.drop).map((c) => ({ from: c.from - shift(c.from), to: c.to - shift(c.from), drop: false }));
  let plain = "";
  for (let k = 0; k < raw.length; k++) if (!dropped.some((c) => k >= c.from && k < c.to)) plain += raw[k];

  const apply = () => {
    // The block's AI colour covers the code, and the user's islands stand out in the normal text colour.
    codeEl.addClasses([...blockCls.split(" "), "rk-code-text"]);
    if (blockStyle) codeEl.setAttribute("style", blockStyle);
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
    let joined = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      joined += (n as Text).data;
    }
    if (joined.startsWith(raw)) wrapCuts(codeEl, nodes, rawCuts);
    else if (joined.startsWith(plain) && !codeEl.querySelector(".rk-code-island")) wrapCuts(codeEl, nodes, plainCuts);
  };

  const observer = new MutationObserver(() => {
    observer.disconnect();
    apply();
    watch();
  });
  const watch = () => observer.observe(codeEl, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  apply();
  watch();
}

export function processSection(el: HTMLElement, ctx: MarkdownPostProcessorContext, deps: ReadingDeps) {
  const styles = deps.styles();
  const info = ctx.getSectionInfo(el);
  let doc: ParseResult | null = null;
  let lc: LineContext | null = null;
  let sectionSource: string[] = [];
  let codePre: HTMLElement | null = null;
  let fenceLine = -1;

  if (info) {
    doc = parseCached(info.text);
    const { lineStart, lineEnd } = info;
    sectionSource = info.text.split("\n").slice(lineStart, lineEnd + 1);
    const pre = el.querySelector("pre");
    if (pre) {
      takeOverCopyButton(pre, doc, lineStart);
      codePre = pre;
      fenceLine = lineStart;
    }

    // Block lines are syntax only: take them out.
    const first = doc.segments.find((s) => s.from >= doc!.lines[lineStart].from && s.to <= doc!.lines[lineStart].to + 1);
    if (first?.role === "mark" && (first.mark === "block-open" || first.mark === "block-close") && lineStart === lineEnd) {
      el.addClass("rk-block-line", "rk-done");
      el.empty();
      return;
    }

    for (let l = lineStart; l <= lineEnd; l++) {
      const c = doc.lineContexts[l];
      if (c && c.mode === "prose") {
        lc = c;
        break;
      }
    }
    lc ??= doc.lineContexts[lineStart] ?? null;
  }

  const base = lc?.base ?? HUMAN;
  const pair = lc?.pair ?? "human";
  const blockRes =
    doc && base.block !== undefined && doc.blocks[base.block] ? resolve({ kind: "ai", block: base.block, explicit: false }, doc, styles) : null;

  if (blockRes) {
    el.addClass("rk-in-block");
    el.querySelectorAll("pre").forEach((pre) => pre.addClass(...blockRes.cls.split(" "), "rk-code"));
    if (codePre && doc) renderCodeIslands(codePre, doc, fenceLine, blockRes.cls, blockRes.style);
  }

  // A formula inside an AI block is the AI's, apart from the islands it declares.
  // The section (a callout, say) may start before its first formula.
  const mathEl = el.querySelector<HTMLElement>(".math.math-block");
  if (mathEl && doc && info) {
    let line = info.lineStart;
    while (line < info.lineEnd && !opensFormula(doc, line)) line++;
    styleMath(mathEl, doc, line, styles);
  }

  const docLike = doc ?? { blocks: [], definitions: {} };
  const groups = collectGroups(el);

  // Escapes: map source runs onto rendered runs when the counts agree.
  const flags = escapedRunFlags(sectionSource);
  const literalByGroup = new Map<Group, Set<number>>();
  if (flags) {
    const all: Array<[Group, number]> = [];
    for (const g of groups) for (const p of domRuns(g.text)) all.push([g, p]);
    if (all.length === flags.length) {
      all.forEach(([g, p], k) => {
        if (!flags[k]) return;
        let set = literalByGroup.get(g);
        if (!set) literalByGroup.set(g, (set = new Set()));
        set.add(p);
      });
    }
  }

  for (const g of groups) {
    if (!g.text) continue;
    const r = parseLine(g.text, {
      base,
      pair,
      mode: "prose",
      ampLen: 2,
      atLen: 2,
      inComment: false,
      rendered: true,
      literalRuns: literalByGroup.get(g),
    });

    // A cited blockquote ends with a bare `[@key]` line.
    const ranges: Array<{ from: number; to: number; cls: string; title?: string; style?: string }> = [];
    if (base.kind === "quote" && base.key) {
      const m = new RegExp(`\\[@${base.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`).exec(g.text);
      if (m) ranges.push({ from: m.index, to: m.index + m[0].length, cls: MARK });
    }
    for (const s of r.segments) {
      if (ranges.some((x) => s.from >= x.from && s.to <= x.to)) continue;
      if (s.role === "mark") {
        ranges.push({ from: s.from, to: s.to, cls: MARK });
      } else if (s.role === "text") {
        const res = resolve(s.attr, docLike, styles);
        if (res) {
          let cls = res.cls;
          if (s.attr.kind === "human" && s.to - s.from === 1) cls += " rk-island-dot";
          ranges.push({ from: s.from, to: s.to, cls, title: res.label, style: res.style });
        }
      }
    }
    if (!ranges.length) continue;
    ranges.sort((a, b) => a.from - b.from);

    // Distribute ranges over the group's nodes.
    const perNode = new Map<Text, Piece[]>();
    for (const it of g.items) {
      const itEnd = it.start + it.len;
      for (const rg of ranges) {
        if (rg.to <= it.start || rg.from >= itEnd) continue;
        if (it.node.nodeType !== Node.TEXT_NODE) {
          (it.node as Element).addClasses(rg.cls.split(" "));
          continue;
        }
        let list = perNode.get(it.node as Text);
        if (!list) perNode.set(it.node as Text, (list = []));
        list.push({
          a: Math.max(rg.from, it.start) - it.start,
          b: Math.min(rg.to, itEnd) - it.start,
          cls: rg.cls,
          style: rg.style,
          title: rg.title,
        });
      }
    }
    for (const [node, pieces] of perNode) wrapText(node, pieces);
  }
}
