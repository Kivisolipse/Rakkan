import type { TextChange } from "./rewrite";

/**
 * A `$…$` that swallowed markers is usually money, not a formula. Escaping its
 * two dollar signs (`\$`) makes it plain text again, and the markers inside work.
 * `range` is the diagnostic's range, from the opening `$` to just after the closing one.
 */
export function escapeMathDelimiters(text: string, range: { from: number; to: number }): TextChange[] {
  const close = range.to - 1;
  if (close <= range.from || text[range.from] !== "$" || text[close] !== "$") return [];
  return [
    { from: range.from, to: range.from, insert: "\\" },
    { from: close, to: close, insert: "\\" },
  ];
}
