import type { ParseResult } from "./types";

export interface Stripped {
  text: string;
  /** map[i] = offset in the source of output character i. */
  map: number[];
}

const BLANK_RE = /^\s*$/;

/**
 * Remove Rakkan markers from `[from, to)` of the parsed text. Everything else
 * (other Markdown, code, math, comments) is kept byte for byte. Block lines are
 * removed together with their line break and one surrounding blank line.
 */
export function stripMarkers(r: ParseResult, from = 0, to = r.text.length): Stripped {
  const { text, lines } = r;
  const drop = new Uint8Array(text.length);
  for (const s of r.segments) {
    if (s.role !== "mark" || s.to <= from || s.from >= to) continue;
    for (let k = s.from; k < s.to; k++) drop[k] = 1;
  }
  for (const b of r.blocks) {
    for (const l of [b.openLine, b.closeLine]) {
      if (l === null) continue;
      const line = lines[l];
      const next = lines[l + 1];
      if (!next) continue;
      drop[line.to] = 1; // the line break
      if (text[line.to] === "\r") drop[line.to + 1] = 1;
      const prev = lines[l - 1];
      const prevBlank = !prev || BLANK_RE.test(text.slice(prev.from, prev.to));
      const nextBlank = BLANK_RE.test(text.slice(next.from, next.to));
      if (prevBlank && nextBlank && lines[l + 2]) {
        for (let k = next.from; k < lines[l + 2].from; k++) drop[k] = 1;
      }
    }
  }
  let out = "";
  const map: number[] = [];
  for (let k = from; k < to; k++) {
    if (drop[k]) continue;
    out += text[k];
    map.push(k);
  }
  return { text: out, map };
}
