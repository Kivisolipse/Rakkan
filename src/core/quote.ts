export interface QuoteOptions {
  /**
   * The text comes from somewhere that cannot be trusted (a device, a web
   * page). It is quoted as written, character for character, and nothing in
   * it can act as Markdown or Rakkan syntax: every ASCII punctuation mark gets
   * a backslash (a CommonMark escape, so readers still see the text as it
   * was), every line break (`\r\n`, `\r` or `\n`) starts a new `> ` line, and
   * the last line is `> [@key]`. Nothing is trimmed.
   */
  untrusted?: boolean;
}

/** Every character CommonMark lets a backslash escape. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
/** A key as SPEC §4.1 has it: no whitespace and no square brackets. */
const KEY_RE = /^[^\s[\]]+$/u;

/**
 * `text` as a quote of `key`: 「…」[@key] when it fits on a line, a cited
 * blockquote when it does not (or when every kind of quote mark is taken).
 * With `untrusted`, always a cited blockquote with all syntax escaped.
 */
export function quoteText(text: string, key: string, opts: QuoteOptions = {}): string {
  if (opts.untrusted) {
    if (!KEY_RE.test(key)) throw new RangeError(`Not a Rakkan key: ${JSON.stringify(key)}`);
    if (!text) return "";
    const lines = text.split(/\r\n|\r|\n/).map((l) => l.replace(ASCII_PUNCTUATION, "\\$&"));
    return [...lines.map((l) => (l ? `> ${l}` : ">")), `> [@${key}]`].join("\n");
  }
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  if (!t.includes("\n")) {
    if (!/[「」]/.test(t)) return `「${t}」[@${key}]`;
    if (!t.includes('"')) return `"${t}"[@${key}]`;
  }
  const lines = t.split("\n").map((l) => (l.trim() ? `> ${l}` : ">"));
  return `${lines.join("\n")}\n> [@${key}]`;
}
