// Sign a revision: compare a note with its revised version and mark only what
// changed as the model's, while every character that was kept keeps its
// author, `@@` islands and other models' keys included. This is paste
// revision's diff over a whole note, for the rakkan command's `sign`. The
// revision may be plain text; markers it kept, dropped or got wrong are put
// right from the original.

import { keyFromName } from "./authors";
import { indexAt, parse } from "./parse";
import { carry } from "./pasteedits";
import { atomicRanges, rewriteCodeLine, rewriteLineDetailed, type Char, type Owner } from "./rewrite";
import { stripMarkers, type Stripped } from "./strip";
import { TASK_RE } from "./syntax";
import type { Attr, ParseResult } from "./types";

export interface Signed {
  text: string;
  /** How many separate places changed. */
  changed: number;
  /**
   * Lines (from 0) of the result where a change could not be marked: a quote, code without a declaration,
   * or a change inside a link or the like that holds kept text of two authors. What can't be marked is not taken: these lines
   * keep what the original had, and `rejected` says what the revision had instead.
   */
  unmarked: number[];
  /** The changes put back, one per stretch of lines. */
  rejected: Rejected[];
  /** Lines (from 0) whose changes sit in an AI block signed by another model, so they count as that block's. */
  foreign: number[];
  /** Lines (from 0) where the model ticked or unticked a task. A task's box is syntax: who ticked it isn't recorded. */
  tasks: number[];
}

export interface Rejected {
  /** Where in the result (a line from 0) the original lines put back start. */
  line: number;
  /** How many there are: 0 when the revision only added lines, which are left out. */
  count: number;
  /** The line of the original they start at. */
  original: number;
  /** What the revision had there instead. */
  revised: string;
}

interface Who {
  owner: Owner;
  key?: string;
  /** Quoted text: a line rewrite can't write a quote, so a line that needs one is reported. */
  quote?: true;
  /** Text of a block whose signature gives no key (a name made only of characters a key can't hold): reported. */
  nokey?: true;
}

/**
 * Who owns text of this attribution, as a line rewrite sees it. Text of an AI
 * block takes the block's model ID, or the key made from its name when it has
 * none, so that it keeps it should the revision move it out of the block.
 */
function whoOf(a: Attr, r: ParseResult): Who {
  const w: Who = { owner: a.kind === "ai" ? "ai" : "human" };
  if (a.kind === "quote") w.quote = true;
  if (a.key && a.explicit) w.key = a.key;
  else if (a.kind === "ai" && a.block !== undefined) {
    const sig = r.blocks[a.block]?.signature;
    const k = sig?.id ?? (sig?.name ? keyFromName(sig.name) : "");
    if (k) w.key = k;
    else if (sig) w.nokey = true;
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
    const id = `${w.owner}|${w.key ?? ""}|${w.quote ? "q" : ""}${w.nokey ? "n" : ""}`;
    let code = codes.get(id);
    if (!code) {
      code = String.fromCharCode(0xe000 + codes.size);
      codes.set(id, code);
      whos.set(code, w);
    }
    owners += code;
  }
  const carried = carry(a.text, owners, b.text);
  const want = new Map<number, Who>();
  b.map.forEach((pos, i) => want.set(pos, whos.get(carried.owners[i])!));
  // The backslash before a literal `&&` or `@@` is no one's words, and sign adds it itself: as a change it
  // would take a link around it to the model when the result is signed again.
  for (const pos of b.map) if (revised[pos] === "\\" && /^(?:&&|@@)/.test(revised.slice(pos + 1, pos + 3))) want.delete(pos);

  // A task's box is syntax, so who ticked it can't be recorded (SPEC §7): a box the model ticked or
  // unticked, in a line it otherwise kept, is reported.
  const boxes = (r: ParseResult, map: number[]) => {
    const at = new Map(map.map((pos, i) => [pos, i] as const));
    const out = new Map<number, number>(); // visible index of the state character → line
    r.lines.forEach((l, n) => {
      const ctx = r.lineContexts[n];
      if (ctx.mode !== "prose") return;
      const from = l.from + ctx.prefix;
      const m = TASK_RE.exec(r.text.slice(from, l.to));
      const i = m ? at.get(from + m[0].length - 1) : undefined;
      if (i !== undefined) out.set(i, n);
    });
    return out;
  };
  const tasks: number[] = [];
  const oldBoxes = boxes(before, a.map);
  if (oldBoxes.size) {
    let tagged = "";
    for (let i = 0; i < a.text.length; i++) tagged += oldBoxes.has(i) ? "T" : "H";
    // T where a box state was kept, A where the revision changed text: a box whose state is not a kept one
    // but whose `[` and `]` were kept was ticked or unticked.
    const own = carry(a.text, tagged, b.text).owners;
    for (const [i, n] of boxes(after, b.map)) if (own[i] !== "T" && own[i - 1] !== "A" && own[i + 1] !== "A") tasks.push(n);
  }

  // A line rewrite never splits a link, cite or the like: when part of one changed, all of it is
  // the model's. Say so here as well, or signing the result again would hand the change back to its
  // neighbours' owner.
  // An atom can also hold kept text of two authors, when the revision dropped the markers between them
  // (`&&!&&[t](u)` read as the image `![t](u)`). Such an atom is split as the original's markers split it
  // (Q8), unless the model changed something in it too: then the line is reported, and keeps the original.
  const changedText = whos.get("A")!;
  const mixed = new Set<number>();
  const split = new Map<number, Set<number>>(); // line → atoms (by start in the line's content) to split
  for (let n = 0; n < after.lines.length; n++) {
    const ctx = after.lineContexts[n];
    if (ctx.mode !== "prose") continue;
    const from = after.lines[n].from + ctx.prefix;
    for (const atom of atomicRanges(revised.slice(from, after.lines[n].to))) {
      let changed = false;
      let two = false;
      let first: Who | undefined;
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
        if (!split.has(n)) split.set(n, new Set());
        split.get(n)!.add(atom.from);
      } else if (changed) for (let k = from + atom.from; k < from + atom.to; k++) if (want.has(k)) want.set(k, changedText);
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
      } else if (w.owner === cur.owner && w.key === cur.key && w.quote === cur.quote && !w.nokey) continue;
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
    // Kept quoted text whose quote the revision dropped: sign can't write the quote back. Nor can it
    // name text from a block whose signature makes no key.
    let quoted = false;
    for (let pos = from; pos < to && !quoted; pos++) quoted = want.get(pos)?.quote === true || want.get(pos)?.nokey === true;
    const done =
      quoted || mixed.has(n)
      ? null
      : ctx.mode === "prose"
        ? rewriteLineDetailed(line, ctx, edit(ctx.prefix), split.get(n))
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
  const signed: Signed = { text, changed: carried.changed, unmarked, rejected: [], foreign: [...foreign].sort((x, y) => x - y), tasks };
  return unmarked.length ? putBack(before, after, a, b, carried.from, signed) : signed;
}

/**
 * What can't be marked must not become the person's (SPEC, the rule above all), so a change sign could
 * not mark is not taken: its lines get back what the original had there. Two lines pair up when the
 * diff kept text of the one only in the other; between such pairs, lines that read the same (blank ones)
 * pair up from either end, and the rest one to one when there are as many on each side. Otherwise the
 * whole stretch between two pairs goes back. When the stretch's text came from elsewhere, or putting
 * it back changes how any line reads, the whole original is kept.
 */
function putBack(before: ParseResult, after: ParseResult, a: Stripped, b: Stripped, from: number[], signed: Signed): Signed {
  const original = before.text;
  const revised = after.text;
  const O = before.lines.length;
  const R = after.lines.length;
  const whole = (): Signed => ({
    text: original,
    changed: signed.changed,
    unmarked: before.lines.map((_, n) => n),
    rejected: [{ line: 0, count: O, original: 0, revised }],
    foreign: [],
    tasks: [],
  });

  // Each line's visible text; a line with none (blank, a block line) is told apart by its source.
  const keys = (r: ParseResult, st: Stripped) => {
    const vis = r.lines.map(() => "");
    st.map.forEach((pos, i) => {
      const n = indexAt(r.lines, pos);
      if (n >= 0) vis[n] += st.text[i];
    });
    return r.lines.map((l, n) => vis[n] || `\u0000${r.text.slice(l.from, l.to).trim()}`);
  };
  const ka = keys(before, a);
  const kb = keys(after, b);

  // Which lines of the other side each line's kept characters came from (or went to).
  const span = (n: number) => ({ lo: Array<number>(n).fill(Infinity), hi: Array<number>(n).fill(-1) });
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
  const within = (x: { lo: number[]; hi: number[] }, n: number, lo: number, hi: number) => x.hi[n] < 0 || (x.lo[n] >= lo && x.hi[n] < hi);

  // The revised lines [r1, r2) in place of the original lines [o1, o2).
  interface Stretch {
    r1: number;
    r2: number;
    o1: number;
    o2: number;
  }
  const stretchOf: Stretch[] = [];
  const pair = (r: number, o: number) => ka[o] === kb[r] && within(toO, r, o, o + 1) && within(toR, o, r, r + 1);
  const one = (r: number, o: number) => (stretchOf[r] = { r1: r, r2: r + 1, o1: o, o2: o + 1 });
  // Anchors: lines whose kept text came only from each other.
  const anchors: Array<[number, number]> = [];
  for (let r = 0; r < R; r++) {
    const o = toO.lo[r];
    if (toO.hi[r] === o && toR.lo[o] === r && toR.hi[o] === r) anchors.push([r, o]);
  }
  let r0 = 0;
  let o0 = 0;
  for (const [ar, ao] of [...anchors, [R, O] as [number, number]]) {
    // Between two anchors: lines that pair up from either end, then the rest one to one or as a whole.
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

  const plain = parse(signed.text); // line for line the revision's
  const eol = (r: ParseResult, n: number) => r.text.slice(r.lines[n].to, n + 1 < r.lines.length ? r.lines[n + 1].from : r.text.length);
  const pieces: Array<{ text: string; eol: string; r: ParseResult; n: number }> = [];
  const lineOut: number[] = [];
  const rejected: Rejected[] = [];
  const unmarked: number[] = [];
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
    // Lines left out at the very end: the line before them ends the text as the revision did.
    if (s.o1 === s.o2 && s.r2 === R && pieces.length) pieces[pieces.length - 1].eol = eol(plain, R - 1);
    rejected.push({ line, count: s.o2 - s.o1, original: s.o1, revised: revised.slice(after.lines[s.r1].from, after.lines[s.r2 - 1].to) });
    for (let k = 0; k < Math.max(1, s.o2 - s.o1); k++) unmarked.push(line + k);
    n = s.r2;
    g++;
  }
  const text = pieces.map((p) => p.text + p.eol).join("");

  // Every line must read as it did where it came from: the original's lines as in the original, the rest
  // as in the revision once signed.
  const out = parse(text);
  if (out.lines.length !== Math.max(1, pieces.length)) return whole();
  const reading = (r: ParseResult, n: number) => {
    let sig = "";
    for (let pos = r.lines[n].from; pos < r.lines[n].to; pos++) {
      const seg = r.segments[indexAt(r.segments, pos)];
      const blk = seg?.attr.block !== undefined ? r.blocks[seg.attr.block].signature.raw : "";
      sig += seg ? `${seg.role}|${seg.attr.kind}|${seg.attr.key ?? ""}|${blk}\u0000` : "\u0000";
    }
    return sig;
  };
  for (let k = 0; k < pieces.length; k++) if (reading(out, k) !== reading(pieces[k].r, pieces[k].n)) return whole();

  const moved = (lines: number[]) => lines.flatMap((n) => (lineOut[n] === undefined ? [] : [lineOut[n]]));
  return { text, changed: signed.changed, unmarked, rejected, foreign: moved(signed.foreign), tasks: moved(signed.tasks) };
}
