import { parse, type ParseResult } from "../src/core";

/**
 * Compact view of who owns which text: `H:` human, `h:` explicit human island,
 * `A:` AI, `Q:` quote, with `@key` when a key is attached. Marks, syntax and
 * meta are omitted; adjacent pieces with the same owner are merged (line
 * breaks are not part of any segment, so they disappear).
 */
export function owners(src: string | ParseResult): string[] {
  const r = typeof src === "string" ? parse(src) : src;
  const out: Array<[string, string]> = [];
  for (const s of r.segments) {
    if (s.role !== "text") continue;
    const a = s.attr;
    let tag = a.kind === "human" ? (a.explicit ? "h" : "H") : a.kind === "ai" ? "A" : "Q";
    if (a.key) tag += `@${a.key}`;
    const piece = r.text.slice(s.from, s.to);
    const last = out[out.length - 1];
    if (last && last[0] === tag) last[1] += piece;
    else out.push([tag, piece]);
  }
  return out.map(([t, p]) => `${t}:${p}`).filter((x) => !/^[^:]+:\s*$/.test(x));
}

export function marks(src: string): string[] {
  const r = parse(src);
  return r.segments.filter((s) => s.role === "mark").map((s) => `${s.mark}:${r.text.slice(s.from, s.to)}`);
}

export function codes(src: string): string[] {
  return parse(src).diagnostics.map((d) => d.code);
}
