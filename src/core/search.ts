/** Characters that may sit between two letters in the source: markers and common formatting. */
export const GAP = "[@&*=~`\\[\\]]*";

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Build a regex source that matches `query` with formatting characters in
 * between any two characters. The gap is a single character class, so the
 * match stays linear (no nested quantifiers to backtrack on).
 */
export function looseRegexSource(query: string): string {
  const parts: string[] = [];
  for (const ch of Array.from(query.trim())) {
    if (/\s/.test(ch)) {
      parts.push("\\s+");
      continue;
    }
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    parts.push(lower !== upper ? `[${escapeRe(lower)}${escapeRe(upper)}]` : escapeRe(ch));
  }
  return parts.join(GAP);
}

export function looseRegex(query: string): RegExp {
  return new RegExp(looseRegexSource(query), "g");
}
