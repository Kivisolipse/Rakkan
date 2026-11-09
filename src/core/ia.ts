// iA Writer's Markdown Annotations (https://github.com/iainc/Markdown-Annotations):
// authorship kept in a block after the text instead of inline markers.
//
//   ---
//   Annotations: 0,95 SHA-256 1132bf5e376a605f5beed4b204456114
//   @Human: 0,20 33,4
//   &Claude <claude-opus-5-5>: 20,13
//   ...
//
// Ranges are `location,length` in grapheme clusters, counted from 0.

import type { Author } from "./authors";
import { parse } from "./parse";
import { rewriteLine } from "./rewrite";
import { signatureLabel } from "./signature";
import { stripMarkers } from "./strip";

// ── SHA-256 ─────────────────────────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of `data` as lowercase hex (pure, so it works wherever the plugin does). */
export function sha256Hex(data: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// ── Graphemes ───────────────────────────────────────────────────────────

type Segmenter = new (locale?: string, options?: object) => { segment(s: string): Iterable<{ segment: string }> };

/** Grapheme clusters of `s`, falling back to code points where Intl.Segmenter is missing. */
function graphemes(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: Segmenter }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
  return Array.from(s);
}

// ── Splitting a note into text and annotation block ─────────────────────

export interface IASplit {
  /** The text before the block. */
  body: string;
  /** The block's lines, between `---` and `...`. */
  lines: string[];
}

/** Find the annotation block at the end of `text`, or null when there is none. */
export function splitIA(text: string): IASplit | null {
  const end = /\r?\n\.\.\.[ \t]*(?:\r?\n)?$/.exec(text);
  if (!end) return null;
  const head = text.slice(0, end.index) + "\n";
  // The opener is the last `---` line before the end.
  const re = /(^|\n)---[ \t]*\r?\n/g;
  let start = -1;
  let startLen = 0;
  for (let m = re.exec(head); m; m = re.exec(head)) {
    start = m.index;
    startLen = m[0].length;
  }
  if (start < 0) return null;
  const lines = head
    .slice(start + startLen)
    .replace(/\r?\n$/, "")
    .split(/\r?\n/);
  if (!/SHA-256/i.test(lines[0] ?? "")) return null;
  // The line break before the opener belongs to the block; the one before that ends the text.
  return { body: text.slice(0, start), lines };
}

// ── Reading a block ─────────────────────────────────────────────────────

export interface IAAuthor {
  kind: "human" | "ai" | "reference";
  name: string;
  id?: string;
  /** [location, length] in grapheme clusters. */
  ranges: Array<[number, number]>;
}

export interface IAParsed {
  /** The grapheme range the hash covers, and whether it matched. */
  hash: { from: number; length: number; ok: boolean };
  authors: IAAuthor[];
}

const KIND: Record<string, IAAuthor["kind"]> = { "@": "human", "&": "ai", "*": "reference" };

/** Join continuation lines (indented) onto the entry above. */
function entries(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s+\S/.test(l) && out.length) out[out.length - 1] += " " + l.trim();
    else if (l.trim()) out.push(l);
  }
  return out;
}

function parseRanges(value: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const tok of value.trim().split(/\s+/)) {
    const m = /^(\d+)(?:,(\d+))?$/.exec(tok);
    if (m) out.push([Number(m[1]), m[2] === undefined ? 1 : Number(m[2])]);
  }
  return out;
}

/** The annotations of a note that ends with an iA block, plus whether its hash matches the text. */
export function parseIA(split: IASplit): IAParsed | null {
  const [first, ...rest] = entries(split.lines);
  const h = /:\s*(\d+)(?:,(\d+))?\s+SHA-256\s+([0-9a-fA-F]{20,64})\s*$/.exec(first ?? "");
  if (!h) return null;
  const from = Number(h[1]);
  const length = h[2] === undefined ? 1 : Number(h[2]);
  const covered = graphemes(split.body)
    .slice(from, from + length)
    .join("");
  const want = h[3].toLowerCase();
  const ok = sha256Hex(utf8(covered)).startsWith(want) || sha256Hex(utf8(covered.replace(/\r?\n$/, ""))).startsWith(want);

  const authors: IAAuthor[] = [];
  for (const entry of rest) {
    const kind = KIND[entry[0]];
    if (!kind) continue;
    // Keys may contain `\:`; the value starts after the first bare colon.
    let colon = -1;
    for (let i = 1; i < entry.length; i++) {
      if (entry[i] === "\\") i++;
      else if (entry[i] === ":") {
        colon = i;
        break;
      }
    }
    if (colon < 0) continue;
    const key = entry.slice(1, colon).replace(/\\:/g, ":").trim();
    const id = /<([^<>]*)>/.exec(key);
    const name = key.replace(/<[^<>]*>.*$/, "").replace(/,.*$/, "").trim();
    authors.push({ kind, name, ...(id ? { id: id[1] } : {}), ranges: parseRanges(entry.slice(colon + 1)) });
  }
  return { hash: { from, length, ok }, authors };
}

// ── Applying ownership to plain text ────────────────────────────────────

const HOLE = String.fromCharCode(0xe000);

/**
 * Write `owners` (one `A` or `H` per UTF-16 unit of `plain`) into the text as
 * Rakkan markers. Lines that cannot carry markers (code, quotes) stay as they are.
 */
export function applyOwners(plain: string, owners: string, keys: Array<string | undefined> = []): string {
  const r = parse(plain);
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  r.lines.forEach((line, i) => {
    const ctx = r.lineContexts[i];
    const text = plain.slice(line.from, line.to);
    // A line with a quote cannot be rewritten as it is: stand a single character in for each quote.
    const quotes = r.spans.filter((s) => s.type === "quote" && s.from >= line.from && s.to <= line.to);
    const mask = quotes.length > 0 && !text.includes(HOLE);
    let masked = text;
    const at: number[] = []; // masked offset → plain offset
    if (mask) {
      masked = "";
      let pos = line.from;
      for (const q of quotes) {
        for (; pos < q.from; pos++) {
          at.push(pos);
          masked += plain[pos];
        }
        at.push(q.from);
        masked += HOLE;
        pos = q.to;
      }
      for (; pos < line.to; pos++) {
        at.push(pos);
        masked += plain[pos];
      }
    }
    let next = rewriteLine(masked, ctx, (chars) => {
      for (const c of chars) {
        const o = mask ? at[ctx.prefix + c.at] : line.from + ctx.prefix + c.at;
        // A quote stands apart from the AI text around it.
        c.owner = owners[o] === "A" && c.ch !== HOLE ? "ai" : "human";
        if (c.owner === "ai" && keys[o]) c.key = keys[o];
        else delete c.key;
      }
    });
    if (next !== null && mask) {
      let n = 0;
      next = next.replace(new RegExp(HOLE, "g"), () => plain.slice(quotes[n].from, quotes[n++].to));
    }
    if (next !== null && next !== text) edits.push({ from: line.from, to: line.to, insert: next });
  });
  let out = plain;
  for (const e of edits.reverse()) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

export interface FromIA {
  text: string;
  /** False when the hash does not match the text: the ranges may be misplaced. */
  hashOk: boolean;
  /** Characters of reference ranges that could not become a quote and stay plain text. */
  referenceChars: number;
  /** Reference ranges written as `「…」[@key]`. */
  quotes: number;
  /** Other people (not the owner of the vault) whose text became quotes. */
  others: string[];
}

export interface FromIAOptions {
  /** The author book: a name it knows is written as that author. */
  authors?: Record<string, Author>;
  /** Of the humans the book does not know, the one who owns the vault, or null for none. The others become quotes. */
  owner?: string | null;
}

export interface HumanChoice {
  name: string;
  chars: number;
}

/** The key of the book author an iA entry stands for, by Rakkan key or by name. */
function inBook(book: Record<string, Author> | undefined, a: IAAuthor): string | undefined {
  if (!book) return undefined;
  const id = a.id?.startsWith("@") ? a.id.slice(1) : undefined;
  if (id && id in book) return id;
  const n = a.name.trim().toLowerCase();
  for (const au of Object.values(book)) if (au.key.toLowerCase() === n || au.name?.trim().toLowerCase() === n) return au.key;
  return undefined;
}

function unknownHumansOf(parsed: IAParsed, length: number, book?: Record<string, Author>): HumanChoice[] {
  const out = new Map<string, HumanChoice>();
  for (const a of parsed.authors) {
    if (a.kind !== "human" || inBook(book, a)) continue;
    const id = a.name.trim().toLowerCase();
    const entry = out.get(id) ?? { name: a.name, chars: 0 };
    for (const [loc, len] of a.ranges) entry.chars += Math.max(0, Math.min(loc + len, length) - loc);
    out.set(id, entry);
  }
  return [...out.values()].sort((x, y) => y.chars - x.chars);
}

/**
 * The humans of an iA block that the author book does not know, most text first.
 * Someone has to say which one, if any, owns the vault: they may all be quotes.
 */
export function unknownHumans(text: string, book?: Record<string, Author>): HumanChoice[] {
  const split = splitIA(text);
  const parsed = split && parseIA(split);
  return split && parsed ? unknownHumansOf(parsed, graphemes(split.body).length, book) : [];
}

const GENERIC = /^(?:ai|unknown|assistant|human)$/i;

/** The `[@key]` for an author of the block: the key Rakkan wrote, or one made from the name. */
function keyOf(a: IAAuthor): string | undefined {
  if (a.id?.startsWith("@")) return a.id.slice(1) || undefined;
  if (GENERIC.test(a.name)) return undefined;
  return a.name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[[\]@「」]/g, "") || undefined;
}

/** A definition line for the end of the note, when the key says more than the key itself. */
function definitionOf(a: IAAuthor, key: string): string | null {
  const id = a.id && !a.id.startsWith("@") ? a.id : undefined;
  if (a.name === key && !id) return null;
  return `- @${key}: ${a.name}${id ? ` (${id})` : ""} · ${a.kind === "ai" ? "AI" : a.kind === "human" ? "人" : "来源"}`;
}

const isBreak = (c: string) => c === "\n" || c === "\r\n" || c === "\r";

/** Turn a note with an iA annotation block into one with Rakkan markers, or null when it has no block. */
export function fromIA(text: string, opts: FromIAOptions = {}): FromIA | null {
  const split = splitIA(text);
  const parsed = split && parseIA(split);
  if (!split || !parsed) return null;
  const g = graphemes(split.body);
  const book = opts.authors;

  // The humans the book does not know: one of them is the owner, whose text stays unmarked.
  const unknown = unknownHumansOf(parsed, g.length, book);
  // `owner: null` says there is none: all of them are other people.
  const ownerName = (opts.owner === undefined ? unknown[0]?.name : opts.owner)?.trim().toLowerCase();
  const others: string[] = [];

  // Who wrote each grapheme: later entries win where ranges overlap.
  const owner = new Array<"H" | "A" | "Q">(g.length).fill("H");
  const who = new Array<string | undefined>(g.length).fill(undefined);
  const defs = new Map<string, string>();
  for (const a of parsed.authors) {
    const known = inBook(book, a);
    if (a.kind === "human" && !known && a.name.trim().toLowerCase() === ownerName) continue;
    const key = known ?? keyOf(a) ?? (a.kind === "reference" ? "reference" : undefined);
    if (a.kind === "human" && !key) continue;
    if (a.kind === "human" && !others.includes(a.name)) others.push(a.name);
    if (key && !known && !defs.has(key)) {
      const def = definitionOf(a, key);
      if (def) defs.set(key, def);
    }
    for (const [loc, len] of a.ranges) {
      for (let k = loc; k < Math.min(loc + len, g.length); k++) {
        owner[k] = a.kind === "ai" ? "A" : "Q";
        who[k] = key;
      }
    }
  }

  // Quotes become `「…」[@key]`; the rest keeps its owner.
  let plain = "";
  let owners = "";
  const keys: Array<string | undefined> = [];
  const emit = (s: string, o: "A" | "H", key?: string) => {
    plain += s;
    owners += o.repeat(s.length);
    for (let i = 0; i < s.length; i++) keys.push(o === "A" ? key : undefined);
  };
  let quotes = 0;
  let referenceChars = 0;
  for (let k = 0; k < g.length; ) {
    if (owner[k] !== "Q") {
      emit(g[k], owner[k] as "A" | "H", who[k]);
      k++;
      continue;
    }
    let end = k;
    while (end < g.length && owner[end] === "Q" && who[end] === who[k] && !isBreak(g[end])) end++;
    if (end === k) end = k + 1; // a line break inside a reference range
    let from = k;
    let to = end;
    while (from < to && g[from].trim() === "") from++;
    while (to > from && g[to - 1].trim() === "") to--;
    for (let i = k; i < from; i++) emit(g[i], "H");
    const core = g.slice(from, to).join("");
    const quoted = core.startsWith("「") && core.endsWith("」");
    // Rakkan's own export leaves the quote marks outside the reference range: only the cite is missing.
    const around = from === k && to === end && g[k - 1] === "「" && g[end] === "」";
    if (core && around && who[k] && !/[「」]/.test(core)) {
      emit(core, "H");
      emit(g[end], "H");
      emit(`[@${who[k]}]`, "H");
      quotes++;
      k = end + 1;
      continue;
    }
    if (core && (quoted || !/[「」]/.test(core)) && who[k]) {
      emit(quoted ? core : "「" + core + "」", "H");
      emit(`[@${who[k]}]`, "H");
      quotes++;
    } else {
      emit(core, "H");
      referenceChars += to - from;
    }
    for (let i = to; i < end; i++) emit(g[i], "H");
    k = end;
  }

  let out = applyOwners(plain, owners, keys);
  const known = parse(out).definitions;
  const lines = [...defs].filter(([key]) => !(key in known)).map(([, line]) => line);
  if (lines.length) out = out.replace(/\n*$/, "\n") + "\n" + lines.join("\n") + "\n";
  return { text: out, hashOk: parsed.hash.ok, referenceChars, quotes, others };
}

// ── Writing a block ─────────────────────────────────────────────────────

export interface ToIAOptions {
  /** Display name for a `[@key]` author, when the author book knows it. */
  nameOf?(key: string): string | undefined;
  /** The human's name in the block. Default `Human`. */
  human?: string;
}

const esc = (s: string) => s.replace(/:/g, "\\:").replace(/\r?\n/g, " ");

/** Turn a note with Rakkan markers into plain text followed by an iA annotation block. */
export function toIA(text: string, opts: ToIAOptions = {}): string {
  // A block already there would be annotating text that is about to change.
  const body = splitIA(text)?.body ?? text;
  const r = parse(body);
  const stripped = stripMarkers(r);

  // Who wrote each source character.
  const label = new Array<string | null>(r.text.length).fill(null);
  const human = "@" + esc(opts.human ?? "Human");
  // `Name <@key>`: the `@` tells a Rakkan key from a model ID.
  const named = (key: string | undefined, fallback: string) => (key ? `${esc(opts.nameOf?.(key) || key)} <@${esc(key)}>` : fallback);
  const labelOf = (attr: (typeof r.segments)[number]["attr"]): string => {
    if (attr.kind === "human") return human;
    if (attr.kind === "ai") {
      const sig = attr.block !== undefined ? r.blocks[attr.block]?.signature : undefined;
      if (sig) return "&" + esc(signatureLabel(sig)) + (sig.id ? ` <${sig.id}>` : "");
      return "&" + named(attr.key, "AI");
    }
    return "*" + named(attr.key, "Reference");
  };
  for (const s of r.segments) {
    // Syntax (a list's `- `, a quote's `>`) keeps the label of where it stands: unlabelled would read as the person's.
    if (s.role !== "text" && s.role !== "syntax") continue;
    const l = labelOf(s.attr);
    for (let k = s.from; k < s.to; k++) label[k] = l;
  }

  const plain = stripped.text;
  const runs = new Map<string, Array<[number, number]>>();
  let at = 0; // UTF-16 offset into plain
  let pos = 0; // grapheme index
  for (const cluster of graphemes(plain)) {
    const src = stripped.map[at];
    const who = (src === undefined ? null : label[src]) ?? human;
    let list = runs.get(who);
    if (!list) runs.set(who, (list = []));
    const last = list[list.length - 1];
    if (last && last[0] + last[1] === pos) last[1]++;
    else list.push([pos, 1]);
    at += cluster.length;
    pos++;
  }

  // The hash covers everything but a final line break.
  const covered = plain.replace(/\r?\n$/, "");
  const coveredLen = graphemes(covered).length;
  const range = (x: [number, number]) => (x[1] === 1 ? String(x[0]) : `${x[0]},${x[1]}`);
  const lines = [
    "---",
    `Annotations: 0,${coveredLen} SHA-256 ${sha256Hex(utf8(covered))}`,
    ...[...runs]
      .map(([who, list]) => {
        const clipped = list
          .map((x): [number, number] => [x[0], Math.max(0, Math.min(x[0] + x[1], coveredLen) - x[0])])
          .filter((x) => x[1] > 0);
        return clipped.length ? `${who}: ${clipped.map(range).join(" ")}` : null;
      })
      .filter((l): l is string => l !== null),
    "...",
  ];
  const head = plain.endsWith("\n") ? plain : plain + "\n";
  return head + "\n" + lines.join("\n") + "\n";
}
