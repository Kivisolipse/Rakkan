// Markdown syntax at the start of a line and in table rows. It doesn't show as
// text once rendered, so it isn't counted and belongs to no one (SPEC §7).

/**
 * What makes a line a heading, list item, task or footnote: `## `, `- `,
 * `1. `, `- [ ] `, `[^1]: `. A marker in front of it would turn the line into
 * a paragraph, so a line rewrite keeps markers after it.
 */
export const LEADER_RE = /^[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\[\^[^\]\s]+\]:[ \t]*)/;

/** A task's box: the state character is at the end of the match, before `]`. */
export const TASK_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX](?=\])/;

/** A table's delimiter row, `| --- | :-: |`. */
const DELIMITER_RE = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?$/;

/** A table row, as far as markers go: a line that starts with `|`. */
export const isTableRow = (content: string) => /^[ \t]*\|/.test(content);

/** Ranges of a prose line's content (after any `>` prefix) that are syntax, in order. */
export function lineSyntax(content: string): Array<[number, number]> {
  if (isTableRow(content) && DELIMITER_RE.test(content)) return [[0, content.length]];
  const out: Array<[number, number]> = [];
  const lead = LEADER_RE.exec(content)?.[0].length ?? 0;
  if (lead) out.push([0, lead]);
  if (isTableRow(content)) {
    let slashes = 0;
    for (let k = lead; k < content.length; k++) {
      const c = content[k];
      if (c === "|" && slashes % 2 === 0) out.push([k, k + 1]);
      slashes = c === "\\" ? slashes + 1 : 0;
    }
  }
  return out;
}
