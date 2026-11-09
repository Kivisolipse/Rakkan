// Sign a revision: compare a note with its revised version and mark only what
// changed as the model's, while every character that was kept keeps its
// author, `@@` islands and other models' keys included. This is paste
// revision's diff over a whole note, for the rakkan command's `sign`. The
// revision may be plain text; markers it kept, dropped or got wrong are put
// right from the original.

import { indexAt, parse } from "./parse";
import { carryOwners } from "./pasteedits";
import { atomicRanges, rewriteCodeLine, rewriteLineDetailed, type Char, type Owner } from "./rewrite";
import { stripMarkers } from "./strip";
import type { Attr, ParseResult } from "./types";

export interface Signed {
  text: string;
  /** How many separate places changed. */
  changed: number;
  /** Lines (from 0) whose changes could not be marked: quotes, code without a declaration, or a link or the like holding kept text of two authors. They are left as revised. */
  unmarked: number[];
  /** Lines (from 0) whose changes sit in an AI block signed by another model, so they count as that block's. */
  foreign: number[];
}

interface Who {
  owner: Owner;
  key?: string;
  /** Quoted text: a line rewrite can't write a quote, so a line that needs one is reported. */
  quote?: true;
}

/**
 * Who owns text of this attribution, as a line rewrite sees it. Text of an AI
 * block takes the block's model ID, so that it keeps it should the revision
 * move it out of the block.
 */
function whoOf(a: Attr, r: ParseResult): Who {
  const w: Who = { owner: a.kind === "ai" ? "ai" : "human" };
  if (a.kind === "quote") w.quote = true;
  if (a.key && a.explicit) w.key = a.key;
  else if (a.kind === "ai" && a.block !== undefined) {
    const id = r.blocks[a.block]?.signature.id;
    if (id) w.key = id;
  }
  return w;
}

function attrAt(r: ParseResult, pos: number): Attr | undefined {
  return r.segments[indexAt(r.segments, pos)]?.attr;
}

/**
 * Mark what `revised` changed in `original` as written by the model `key`
 * (unnamed without one). Lines that need no new marks are left exactly as the
 * revision wrote them.
 */
export function signRevision(original: string, revised: string, key?: string): Signed {
  const before = parse(original);
  const after = parse(revised);
  const a = stripMarkers(before);
  const b = stripMarkers(after);

  // The diff carries one character per owner: H for plain human text, A for the change, the rest made up here.
  const whos = new Map<string, Who>([
    ["H", { owner: "human" }],
    ["A", key ? { owner: "ai", key } : { owner: "ai" }],
  ]);
  const codes = new Map<string, string>([["human||", "H"]]);
  let owners = "";
  for (const pos of a.map) {
    const attr = attrAt(before, pos);
    const w: Who = attr ? whoOf(attr, before) : { owner: "human" };
    const id = `${w.owner}|${w.key ?? ""}|${w.quote ? "q" : ""}`;
    let code = codes.get(id);
    if (!code) {
      code = String.fromCharCode(0xe000 + codes.size);
      codes.set(id, code);
      whos.set(code, w);
    }
    owners += code;
  }
  const carried = carryOwners(a.text, owners, b.text);
  const want = new Map<number, Who>();
  b.map.forEach((pos, i) => want.set(pos, whos.get(carried.owners[i])!));
  // The backslash before a literal `&&` or `@@` is no one's words, and sign adds it itself: as a change it
  // would take a link around it to the model when the result is signed again.
  for (const pos of b.map) if (revised[pos] === "\\" && /^(?:&&|@@)/.test(revised.slice(pos + 1, pos + 3))) want.delete(pos);

  // A line rewrite never splits a link, cite or the like: when part of one changed, all of it is
  // the model's. Say so here as well, or signing the result again would hand the change back to its
  // neighbours' owner.
  // An atom the model did not change can still hold kept text of two authors, when the revision dropped
  // the markers between them (`&&!&&[t](u)` read as the image `![t](u)`). It can't keep both without
  // being split, so the line is reported.
  const changedText = whos.get("A")!;
  const mixed = new Set<number>();
  for (let n = 0; n < after.lines.length; n++) {
    const ctx = after.lineContexts[n];
    if (ctx.mode !== "prose") continue;
    const from = after.lines[n].from + ctx.prefix;
    for (const atom of atomicRanges(revised.slice(from, after.lines[n].to))) {
      let changed = false;
      let first: Who | undefined;
      for (let k = from + atom.from; k < from + atom.to; k++) {
        const w = want.get(k);
        if (!w) continue;
        if (w === changedText) changed = true;
        else if (/\S/.test(revised[k])) {
          if (first && w !== first) mixed.add(n);
          first ??= w;
        }
      }
      if (changed) for (let k = from + atom.from; k < from + atom.to; k++) if (want.has(k)) want.set(k, changedText);
    }
  }

  // Lines where some text's owner is not the one it should have. In an AI block all AI text is the
  // block's model's, so a change in a block that another model signed is reported instead.
  const dirty = new Set<number>();
  const foreign = new Set<number>();
  for (const s of after.segments) {
    if (s.role !== "text") continue;
    const cur = whoOf(s.attr, after);
    const block = cur.owner === "ai" && s.attr.block !== undefined ? after.blocks[s.attr.block] : undefined;
    const line = indexAt(after.lines, s.from, true);
    for (let pos = s.from; pos < s.to; pos++) {
      const w = want.get(pos);
      if (!w) continue;
      if (block) {
        if (key && w === changedText && block.signature.id !== key && /\S/.test(revised[pos])) foreign.add(line);
        if (w.owner === "ai") continue;
      } else if (w.owner === cur.owner && w.key === cur.key && w.quote === cur.quote) continue;
      dirty.add(line);
    }
  }

  const unmarked: number[] = [];
  let text = "";
  let last = 0;
  for (const n of [...dirty].sort((x, y) => x - y)) {
    const { from, to } = after.lines[n];
    const ctx = after.lineContexts[n];
    const edit = (offset: number) => (chars: Char[]) => {
      for (const c of chars) {
        const w = want.get(from + offset + c.at);
        if (!w) continue;
        c.owner = w.owner;
        if (w.key) c.key = w.key;
        else delete c.key;
      }
    };
    const line = revised.slice(from, to);
    // Kept quoted text whose quote the revision dropped: sign can't write the quote back.
    let quoted = false;
    for (let pos = from; pos < to && !quoted; pos++) quoted = want.get(pos)?.quote === true;
    const done =
      quoted || mixed.has(n)
      ? null
      : ctx.mode === "prose"
        ? rewriteLineDetailed(line, ctx, edit(ctx.prefix))
        : ctx.mode === "code" && ctx.pair !== "quote" // sign leaves quotes to the person (reported as unmarked)
          ? rewriteCodeLine(line, ctx, edit(0))
          : null;
    if (!done) {
      unmarked.push(n);
      continue;
    }
    text += revised.slice(last, from) + done.text;
    last = to;
  }
  text += revised.slice(last);
  return { text, changed: carried.changed, unmarked, foreign: [...foreign].sort((x, y) => x - y) };
}
