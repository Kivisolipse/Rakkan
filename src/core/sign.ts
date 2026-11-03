// Sign a revision: compare a note with its revised version and mark only what
// changed as the model's, while every character that was kept keeps its
// author, `@@` islands and other models' keys included. This is paste
// revision's diff over a whole note, for the rakkan command's `sign`. The
// revision may be plain text; markers it kept, dropped or got wrong are put
// right from the original.

import { indexAt, parse } from "./parse";
import { carryOwners } from "./pasteedits";
import { rewriteCodeLine, rewriteLineDetailed, type Char, type Owner } from "./rewrite";
import { stripMarkers } from "./strip";
import type { Attr, ParseResult } from "./types";

export interface Signed {
  text: string;
  /** How many separate places changed. */
  changed: number;
  /** Lines (from 0) whose changes could not be marked: quotes, or code without a declaration. */
  unmarked: number[];
  /** Lines (from 0) whose changes sit in an AI block signed by another model, so they count as that block's. */
  foreign: number[];
}

interface Who {
  owner: Owner;
  key?: string;
}

/** Who owns text of this attribution, as a line rewrite sees it. */
function whoOf(a: Attr): Who {
  const w: Who = { owner: a.kind === "ai" ? "ai" : "human" };
  if (a.key && a.explicit) w.key = a.key;
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
  const codes = new Map<string, string>([["human|", "H"]]);
  let owners = "";
  for (const pos of a.map) {
    const attr = attrAt(before, pos);
    const w: Who = attr ? whoOf(attr) : { owner: "human" };
    const id = `${w.owner}|${w.key ?? ""}`;
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

  // Lines where some text's owner is not the one it should have. In an AI block all AI text is the
  // block's model's, so a change in a block that another model signed is reported instead.
  const changedText = whos.get("A");
  const dirty = new Set<number>();
  const foreign = new Set<number>();
  for (const s of after.segments) {
    if (s.role !== "text") continue;
    const cur = whoOf(s.attr);
    const block = cur.owner === "ai" && s.attr.block !== undefined ? after.blocks[s.attr.block] : undefined;
    const line = indexAt(after.lines, s.from, true);
    for (let pos = s.from; pos < s.to; pos++) {
      const w = want.get(pos);
      if (!w) continue;
      if (block) {
        if (key && w === changedText && block.signature.id !== key && /\S/.test(revised[pos])) foreign.add(line);
        if (w.owner === "ai") continue;
      } else if (w.owner === cur.owner && w.key === cur.key) continue;
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
    const done =
      ctx.mode === "prose"
        ? rewriteLineDetailed(line, ctx, edit(ctx.prefix))
        : ctx.mode === "code"
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
