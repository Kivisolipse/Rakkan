/**
 * `text` as a quote of `key`: 「…」[@key] when it fits on a line, a cited
 * blockquote when it does not (or when every kind of quote mark is taken).
 */
export function quoteText(text: string, key: string): string {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  if (!t.includes("\n")) {
    if (!/[「」]/.test(t)) return `「${t}」[@${key}]`;
    if (!t.includes('"')) return `"${t}"[@${key}]`;
  }
  const lines = t.split("\n").map((l) => (l.trim() ? `> ${l}` : ">"));
  return `${lines.join("\n")}\n> [@${key}]`;
}
