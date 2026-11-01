// Export: the same note without Rakkan syntax, or with it turned into Pandoc
// spans and divs that pandoc/rakkan.lua can colour (or drop) per output format.
//
//   &&text&&[@gpt]                →  [text]{.rk-ai author="gpt" family="gpt"}
//   @@text@@ (inside an AI block) →  [text]{.rk-human}
//   「text」[@key]                 →  [「text」]{.rk-quote author="key"}[@key]
//   && Claude (claude-opus-5-5)   →  ::: {.rk-ai author="Claude" model="claude-opus-5-5" family="claude"}
//   &&                            →  :::

import { signatureFamily, signatureLabel } from "./signature";
import { stripMarkers } from "./strip";
import type { InlineSpan } from "./types";
import { parse } from "./parse";

/** The note without any Rakkan syntax. */
export function exportPlain(text: string): string {
  return stripMarkers(parse(text)).text;
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

/** The note with its markers turned into Pandoc bracketed spans and fenced divs. */
export function exportPandoc(text: string, opts: PandocOptions = {}): string {
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

  for (const seg of r.segments) {
    if (seg.role !== "mark") continue;
    switch (seg.mark) {
      case "open": {
        const s = spanFor.get(seg.from);
        edits.push({ from: seg.from, to: seg.to, insert: s && !inCode(seg.from) ? "[" : "" });
        break;
      }
      case "close": {
        const s = closeFor.get(seg.from);
        edits.push({ from: seg.from, to: seg.to, insert: s && !inCode(seg.from) ? `]{${classOf(s)}}` : "" });
        break;
      }
      case "cite": {
        // `&&x&&[@key]` carries the key in the span now; a quote keeps its citation.
        const keep = r.spans.some((s) => s.type === "quote" && seg.from > s.contentTo && seg.to <= s.to);
        if (!keep) edits.push({ from: seg.from, to: seg.to, insert: "" });
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
        const sig = b?.signature;
        const family = sig ? signatureFamily(sig)?.id : undefined;
        edits.push({
          from: seg.from,
          to: seg.to,
          insert: `::: {.rk-ai${attr("author", sig ? signatureLabel(sig) : undefined)}${attr("model", sig?.id)}${attr("family", family)}}`,
        });
        break;
      }
      case "block-close":
        edits.push({ from: seg.from, to: seg.to, insert: ":::" });
        break;
    }
  }

  // Quotes are ordinary text between their quote marks: wrap them whole.
  for (const s of r.spans) {
    if (s.type !== "quote" || inCode(s.from)) continue;
    edits.push({ from: s.from, to: s.from, insert: "[" });
    edits.push({ from: s.contentTo + 1, to: s.contentTo + 1, insert: `]{${classOf(s)}}` });
  }

  // A block that ends where the next one begins, or at the end of the note, never got its `&&`.
  for (const b of r.blocks) {
    if (b.closeLine !== null) continue;
    let last = b.lastLine;
    while (last > b.openLine && /^\s*$/.test(text.slice(r.lines[last].from, r.lines[last].to))) last--;
    const at = r.lines[last].to;
    edits.push({ from: at, to: at, insert: "\n\n:::" });
  }

  // Apply back to front; at the same offset a replacement goes first, so an insert lands before it.
  const isInsert = (e: Edit) => (e.to === e.from ? 1 : 0);
  edits.sort((a, b) => b.from - a.from || isInsert(a) - isInsert(b));
  let out = text;
  for (const e of edits) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}
