// Export: the same note without Rakkan syntax, or with it turned into Pandoc
// spans and divs that pandoc/rakkan.lua can colour (or drop) per output format,
// or into HTML spans and divs that a stylesheet (Obsidian Publish) can colour.
//
//   &&text&&[@gpt]                →  [text]{.rk-ai author="gpt" family="gpt"}
//   @@text@@ (inside an AI block) →  [text]{.rk-human}
//   「text」[@key]                 →  [「text」]{.rk-quote author="key"}[@key]
//   && Claude (claude-opus-5-5)   →  ::: {.rk-ai author="Claude" model="claude-opus-5-5" family="claude"}
//   &&                            →  :::

import { signatureFamily, signatureLabel } from "./signature";
import { stripMarkers, type Stripped } from "./strip";
import type { Attr, Block, InlineSpan, ParseResult } from "./types";
import { parse } from "./parse";

export interface PlainOptions {
  /** Display name for a `[@key]` author, when known. */
  nameOf?(key: string): string | undefined;
}

const CITE_LINE = /^[ \t]*(?:>[ \t]?)+\[@([^\]\s]+)\][ \t]*$/;

/**
 * The note without any Rakkan syntax. The `[@key]` line that ends a cited
 * blockquote is the source of the quote, so it stays as `— name`.
 */
export function exportPlain(text: string, opts: PlainOptions = {}): string {
  return plainWithMap(text, opts).text;
}

/**
 * `exportPlain`, and for each output character its offset in `text`, or -1
 * for a character of a `— name` that replaced a `[@key]`.
 */
export function plainWithMap(text: string, opts: PlainOptions = {}): Stripped {
  const r = parse(text);
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  for (const seg of r.segments) {
    if (seg.role !== "mark" || seg.mark !== "cite") continue;
    let line = 0;
    while (line + 1 < r.lines.length && r.lines[line + 1].from <= seg.from) line++;
    const m = CITE_LINE.exec(text.slice(r.lines[line].from, r.lines[line].to));
    // A model's cited blockquote (a claim, SPEC §4.4) keeps its source the same way.
    if (!m || (r.lineContexts[line].pair !== "quote" && !r.claims.some((c) => c.cite.from === seg.from))) continue;
    edits.push({ from: seg.from, to: seg.to, insert: `— ${opts.nameOf?.(m[1]) ?? m[1]}` });
  }
  if (!edits.length) return stripMarkers(r);
  edits.sort((a, b) => a.from - b.from);
  let source = "";
  const origin: number[] = [];
  let at = 0;
  for (const e of edits) {
    source += text.slice(at, e.from) + e.insert;
    for (let k = at; k < e.from; k++) origin.push(k);
    for (let k = 0; k < e.insert.length; k++) origin.push(-1);
    at = e.to;
  }
  source += text.slice(at);
  for (let k = at; k < text.length; k++) origin.push(k);
  const s = stripMarkers(parse(source));
  return { text: s.text, map: s.map.map((k) => origin[k]) };
}

export interface PandocOptions {
  /** Display name and family for a `[@key]` author, when known. */
  authorOf?(key: string): { name?: string; family?: string } | undefined;
}

const attr = (name: string, value: string | undefined) => (value ? ` ${name}="${value.replace(/["\r\n]/g, "'")}"` : "");

interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** How one output format writes the pieces of a note. */
interface Format {
  /** Before and after an inline span or a quote's content. */
  open(s: InlineSpan, r: ParseResult): string;
  close(s: InlineSpan, r: ParseResult): string;
  /** What replaces the `[@key]` that follows a quote, or null to keep it. */
  quoteCite(s: InlineSpan, key: string, r: ParseResult): string | null;
  /** The same for a model's claim (SPEC §4.4), whose words stay the AI's. */
  claimCite(key: string): string | null;
  blockOpen(b: Block | undefined, r: ParseResult): string;
  blockClose: string;
  /** Closes a block that the next one ended, put after its last line. */
  blockEnd: string;
}

/** Walk the note and let `fmt` write its spans, quotes and blocks. */
function convert(text: string, fmt: Format): string {
  const r = parse(text);
  const edits: Edit[] = [];

  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = r.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (r.lines[mid].from <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const inCode = (offset: number) => r.lineContexts[lineOf(offset)]?.codeFence !== undefined;

  const spanFor = new Map<number, InlineSpan>();
  const closeFor = new Map<number, InlineSpan>();
  for (const s of r.spans) {
    if (inCode(s.from)) continue;
    spanFor.set(s.from, s);
    closeFor.set(s.contentTo, s);
  }

  for (const seg of r.segments) {
    if (seg.role !== "mark") continue;
    switch (seg.mark) {
      case "open": {
        const s = spanFor.get(seg.from);
        edits.push({ from: seg.from, to: seg.to, insert: s && !inCode(seg.from) ? fmt.open(s, r) : "" });
        break;
      }
      case "close": {
        const s = closeFor.get(seg.from);
        edits.push({ from: seg.from, to: seg.to, insert: s && !inCode(seg.from) ? fmt.close(s, r) : "" });
        break;
      }
      case "cite": {
        // `&&x&&[@key]` carries the key in the span now; a quote keeps its citation unless the format rewrites it.
        const quote = r.spans.find((s) => s.type === "quote" && seg.from > s.contentTo && seg.to <= s.to);
        const claim = quote ? undefined : r.claims.find((c) => c.cite.from === seg.from);
        if (claim) {
          const made = fmt.claimCite(claim.key);
          if (made !== null) edits.push({ from: seg.from, to: seg.to, insert: made });
        } else if (!quote) edits.push({ from: seg.from, to: seg.to, insert: "" });
        else {
          const key = /\[@([^\]\s]+)\]/.exec(text.slice(seg.from, seg.to))?.[1];
          const made = key ? fmt.quoteCite(quote, key, r) : null;
          if (made !== null) edits.push({ from: seg.from, to: seg.to, insert: made });
        }
        break;
      }
      case "decl": {
        // The space that separated it from the language goes too.
        const from = text[seg.from - 1] === " " ? seg.from - 1 : seg.from;
        edits.push({ from, to: seg.to, insert: "" });
        break;
      }
      case "block-open": {
        const b = r.blocks.find((x) => r.lines[x.openLine].from === seg.from);
        edits.push({ from: seg.from, to: seg.to, insert: fmt.blockOpen(b, r) });
        break;
      }
      case "block-close":
        edits.push({ from: seg.from, to: seg.to, insert: fmt.blockClose });
        break;
    }
  }

  // Quotes are ordinary text between their quote marks: wrap them whole.
  for (const s of r.spans) {
    if (s.type !== "quote" || inCode(s.from)) continue;
    edits.push({ from: s.from, to: s.from, insert: fmt.open(s, r) });
    edits.push({ from: s.contentTo + 1, to: s.contentTo + 1, insert: fmt.close(s, r) });
  }

  // A block that ends where the next one begins, or at the end of the note, never got its `&&`.
  for (const b of r.blocks) {
    if (b.closeLine !== null) continue;
    let last = b.lastLine;
    while (last > b.openLine && /^\s*$/.test(text.slice(r.lines[last].from, r.lines[last].to))) last--;
    const at = r.lines[last].to;
    edits.push({ from: at, to: at, insert: fmt.blockEnd });
  }

  // Apply back to front; at the same offset a replacement goes first, so an insert lands before it.
  const isInsert = (e: Edit) => (e.to === e.from ? 1 : 0);
  edits.sort((a, b) => b.from - a.from || isInsert(a) - isInsert(b));
  let out = text;
  for (const e of edits) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/** The note with its markers turned into Pandoc bracketed spans and fenced divs. */
export function exportPandoc(text: string, opts: PandocOptions = {}): string {
  const who = (key: string | undefined) => {
    const a = key ? opts.authorOf?.(key) : undefined;
    return { author: a?.name ?? key, family: a?.family };
  };
  const classOf = (s: InlineSpan): string => {
    const a = s.attr;
    if (a.kind === "human") return `.rk-human`;
    if (a.kind === "quote") return `.rk-quote` + attr("author", who(a.key).author);
    const w = who(a.key);
    return `.rk-ai` + attr("author", w.author) + attr("family", w.family);
  };
  return convert(text, {
    open: () => "[",
    close: (s) => `]{${classOf(s)}}`,
    quoteCite: () => null,
    claimCite: () => null,
    blockOpen: (b) => {
      const sig = b?.signature;
      const family = sig ? signatureFamily(sig)?.id : undefined;
      return `::: {.rk-ai${attr("author", sig ? signatureLabel(sig) : undefined)}${attr("model", sig?.id)}${attr("family", family)}}`;
    },
    blockClose: ":::",
    blockEnd: "\n\n:::",
  });
}

export interface PublishOptions {
  /** Classes and a name for who wrote this, or null for plain human text. */
  describe(attr: Attr, r: ParseResult): { cls: string; label: string } | null;
}

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * The note with its markers turned into HTML spans and divs, for a site that
 * cannot run the plugin (Obsidian Publish). A stylesheet gives the classes
 * their colours. A blank line after each block opener lets the Markdown inside
 * a block still be Markdown.
 */
export function exportPublish(text: string, opts: PublishOptions): string {
  const describe = (a: Attr, r: ParseResult) => opts.describe(a, r);
  const island = 'class="rk rk-island"';
  return convert(text, {
    open: (s, r) => {
      const d = describe(s.attr, r);
      if (s.attr.kind === "human") return `<span ${island}>`;
      return d ? `<span class="${html(d.cls)}" title="${html(d.label)}">` : "<span>";
    },
    close: () => "</span>",
    quoteCite: (s, key, r) => {
      const d = describe(s.attr, r);
      return `<sup class="rk-cite">${html(d ? d.label.replace(/^@/, "") : key)}</sup>`;
    },
    claimCite: (key) => `<sup class="rk-cite rk-claim">${html(key)}</sup>`,
    blockOpen: (b, r) => {
      const d = b ? describe({ kind: "ai", block: b.index, explicit: false }, r) : null;
      const sig = b?.signature ? signatureLabel(b.signature) : "";
      return `<div class="rk-block ${html(d?.cls ?? "rk rk-ai")}">\n\n<p class="rk-sig">${html(sig)}</p>`;
    },
    blockClose: "</div>",
    blockEnd: "\n\n</div>",
  });
}
