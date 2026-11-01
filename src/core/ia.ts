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

/**
 * Write `owners` (one `A` or `H` per UTF-16 unit of `plain`) into the text as
 * Rakkan markers. Lines that cannot carry markers (code, quotes) stay as they are.
 */
export function applyOwners(plain: string, owners: string): string {
  const r = parse(plain);
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  r.lines.forEach((line, i) => {
    const ctx = r.lineContexts[i];
    const text = plain.slice(line.from, line.to);
    const next = rewriteLine(text, ctx, (chars) => {
      for (const c of chars) c.owner = owners[line.from + ctx.prefix + c.at] === "A" ? "ai" : "human";
    });
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
  /** Reference ranges are left as plain text; how many characters that was. */
  referenceChars: number;
}

/** Turn a note with an iA annotation block into one with Rakkan markers, or null when it has no block. */
export function fromIA(text: string): FromIA | null {
  const split = splitIA(text);
  const parsed = split && parseIA(split);
  if (!split || !parsed) return null;
  const g = graphemes(split.body);
  // Owner per grapheme, then per UTF-16 unit.
  const per = new Array<string>(g.length).fill("H");
  let referenceChars = 0;
  for (const a of parsed.authors) {
    for (const [loc, len] of a.ranges) {
      for (let k = loc; k < Math.min(loc + len, g.length); k++) {
        if (a.kind === "ai") per[k] = "A";
        else if (a.kind === "reference") referenceChars++;
      }
    }
  }
  let owners = "";
  g.forEach((c, k) => (owners += per[k].repeat(c.length)));
  return { text: applyOwners(split.body, owners), hashOk: parsed.hash.ok, referenceChars };
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
  const labelOf = (attr: (typeof r.segments)[number]["attr"]): string => {
    if (attr.kind === "human") return human;
    if (attr.kind === "ai") {
      const sig = attr.block !== undefined ? r.blocks[attr.block]?.signature : undefined;
      if (sig) return "&" + esc(signatureLabel(sig)) + (sig.id ? ` <${sig.id}>` : "");
      const key = attr.key;
      return "&" + esc((key && opts.nameOf?.(key)) || key || "AI");
    }
    const key = attr.key;
    return "*" + esc((key && opts.nameOf?.(key)) || key || "Reference");
  };
  for (const s of r.segments) {
    if (s.role !== "text") continue;
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
