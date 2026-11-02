// Split a note into the top-level pieces Obsidian renders one by one, so each
// can be rendered on its own and still be coloured knowing which line it came from.

import type { ParseResult } from "./types";

export interface Section {
  /** First and last line, inclusive. */
  lineStart: number;
  lineEnd: number;
}

const BLANK = /^\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Index of the first line after the frontmatter, or 0 when the note has none. */
function afterFrontmatter(r: ParseResult): number {
  if (r.lines.length < 2 || r.text.slice(r.lines[0].from, r.lines[0].to).trimEnd() !== "---") return 0;
  for (let i = 1; i < r.lines.length; i++) {
    const t = r.text.slice(r.lines[i].from, r.lines[i].to).trimEnd();
    if (t === "---" || t === "...") return i + 1;
  }
  return 0;
}

/**
 * Pieces separated by blank lines, except that a blank line inside a code
 * block, before an indented line, or between two list items does not end one.
 */
export function splitSections(r: ParseResult): Section[] {
  const line = (i: number) => r.text.slice(r.lines[i].from, r.lines[i].to);
  const blank = (i: number) => r.lineContexts[i]?.codeFence === undefined && BLANK.test(line(i));
  const out: Section[] = [];
  let i = afterFrontmatter(r);
  while (i < r.lines.length) {
    if (blank(i)) {
      i++;
      continue;
    }
    const lineStart = i;
    let lineEnd = i;
    const startsList = LIST_ITEM.test(line(lineStart));
    for (let k = i + 1; k < r.lines.length; k++) {
      if (!blank(k)) {
        lineEnd = k;
        continue;
      }
      let next = k;
      while (next < r.lines.length && blank(next)) next++;
      if (next >= r.lines.length) break;
      const t = line(next);
      const continues = /^(?: {2,}|\t)\S/.test(t) || (startsList && LIST_ITEM.test(t));
      if (!continues) break;
      lineEnd = next;
      k = next;
    }
    out.push({ lineStart, lineEnd });
    i = lineEnd + 1;
  }
  return out;
}

/**
 * What a piece of source and its rendering have in common: the letters and
 * digits left once the Markdown around them (list bullets, link targets,
 * heading hashes, markers) is gone.
 */
export function matchKey(text: string): string {
  return text
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?)?/gm, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Pair rendered pieces (in document order) with the source pieces they came
 * from. An embed or a preview is rendered without telling the post-processor
 * where its pieces sit in the note, so find them by content. Pieces are
 * matched in order, each source piece at most once; a rendered piece nothing
 * matches gets null.
 */
export function alignSections(rendered: string[], source: string[]): Array<number | null> {
  const out: Array<number | null> = [];
  let cursor = 0;
  for (const text of rendered) {
    const key = matchKey(text);
    let found: number | null = null;
    if (key) {
      for (let j = cursor; j < source.length; j++) {
        if (matchKey(source[j]) === key) {
          found = j;
          break;
        }
      }
    }
    if (found !== null) cursor = found + 1;
    out.push(found);
  }
  return out;
}
