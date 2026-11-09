import { scanInline } from "./inline";

export interface QuoteOptions {
  /**
   * The text comes from somewhere that cannot be trusted (a device, a web
   * page, text an agent fetched). It is quoted as written, character for
   * character, and nothing in it can act as Markdown or Rakkan syntax: every
   * ASCII punctuation mark gets a backslash (a CommonMark escape, so readers
   * still see the text as it was), every line break (`\r\n`, `\r` or `\n`)
   * starts a new `> ` line, and the last line is `> [@key]`. Nothing is
   * trimmed. Agent entries (MCP, the command line) are to quote this way.
   */
  untrusted?: boolean;
}

/** Every character CommonMark lets a backslash escape. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
/** A key as SPEC §4.1 has it: no whitespace and no square brackets. */
const KEY_RE = /^[^\s[\]]+$/u;
/** The fence rule of the parser (parse.ts), after the container prefix. */
const FENCE_RE = /^(`{3,}|~{3,})([^]*)$/; // U+2028 ends no line, so `.` would miss it
const BLANK_RE = /^[ \t]*$/;
/** An `&` CommonMark reads as an entity: escaping it would show the entity's name. */
const ENTITY_RE = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;

const containerPrefix = (line: string) => /^[ \t>]*/.exec(line)![0].length;
/** Blockquote markers as CommonMark reads them. */
const QUOTE_MARKS = /^(?: {0,3}>[ \t]?)+/;
const quoteDepth = (line: string) => (QUOTE_MARKS.exec(line)?.[0].match(/>/g) ?? []).length;
/** The line less its first `n` blockquote markers. */
const stripQuotes = (line: string, n: number) => line.replace(new RegExp(`^(?: {0,3}>[ \\t]?){0,${n}}`), "");
const THEMATIC_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** A list item's marker and the whitespace after it. */
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;

/** The columns of leading whitespace, tabs to the next stop of 4, as CommonMark counts them. */
function columns(line: string): number {
  let col = 0;
  for (const c of line) {
    if (c === " ") col++;
    else if (c === "\t") col += 4 - (col % 4);
    else return col;
  }
  return col;
}

/** The line less `n` columns of indentation, a tab split where it must: the content of an indented code line. */
function dedent(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (col < n && i < line.length && (line[i] === " " || line[i] === "\t")) {
    const w = line[i] === " " ? 1 : 4 - (col % 4);
    if (col + w > n) return " ".repeat(col + w - n) + line.slice(i + 1);
    col += w;
    i++;
  }
  return line.slice(i);
}

/**
 * A prose line with the tabs in its indentation, blockquote markers and list markers written as the spaces
 * they stand for. Behind `> `, a tab reaches the next stop from two columns further on, and would stand for
 * other spaces: `- \tx` is a list item, `> - \tx` one that starts with indented code.
 */
function expandLead(line: string): string {
  const lead = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*/.exec(line)![0];
  if (!lead.includes("\t")) return line;
  let out = "";
  for (const c of lead) out += c === "\t" ? " ".repeat(4 - (width(out) % 4)) : c;
  return out + line.slice(lead.length);
}

/**
 * The line less `n` blockquote markers, as CommonMark reads what follows them: a tab after a `>` gives one
 * column to the marker and the rest as spaces, and a tab in the next `keep` columns (the indentation that
 * indented code takes off) is the spaces it reached from where it was. A tab past them is the code's own.
 */
function unquote(line: string, n: number, keep: number): string {
  let i = 0;
  let col = 0;
  let out = "";
  for (let level = 0; level < n; level++) {
    let j = i;
    let c = col;
    while (j - i < 3 && line[j] === " ") (j++, c++);
    if (line[j] !== ">") break;
    i = j + 1;
    col = c + 1;
    out = "";
    if (line[i] === " ") (i++, col++);
    else if (line[i] === "\t") {
      const w = 4 - (col % 4);
      out = " ".repeat(w - 1);
      col += w;
      i++;
    }
  }
  const start = col - out.length;
  while (i < line.length && (line[i] === " " || line[i] === "\t") && col - start < keep) {
    const w = line[i] === " " ? 1 : 4 - (col % 4);
    out += " ".repeat(w);
    col += w;
    i++;
  }
  return out + line.slice(i);
}

/** How many columns `s` takes, tabs to the next stop of 4. */
function width(s: string): number {
  let col = 0;
  for (const c of s) col += c === "\t" ? 4 - (col % 4) : 1;
  return col;
}

/** Whether `s[i]` follows an odd number of backslashes. */
function escapedAt(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

type Range = { from: number; to: number };
const within = (rs: Range[], i: number) => rs.some((r) => r.from <= i && i < r.to);

/** `@`, `&` and `%` as raw HTML writes them: a backslash there would show. */
const ENTITY: Record<string, string> = { "@": "&#64;", "&": "&amp;", "%": "&#37;" };

/**
 * Every `@`, `&` and `%` of `s` escaped where CommonMark would show it as
 * itself: with a backslash, or with an entity inside raw HTML (`html`). Code
 * and math (`keep`) show their text as written and are left alone.
 */
function escapeSyntax(s: string, keep: Range[] = [], html: Range[] = []): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!(c === "@" || c === "%" || c === "&") || within(keep, i) || (c === "&" && ENTITY_RE.test(s.slice(i)))) out += c;
    else if (within(html, i)) out += ENTITY[c];
    else out += escapedAt(s, i) ? c : "\\" + c;
  }
  return out;
}

// CommonMark's raw HTML (markdown-it's html_re and html_block).
const ATTR = String.raw`(?:\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\s*=\s*(?:[^"'=<>${"`"}\x00-\x20]+|'[^']*'|"[^"]*"))?)`;
const OPEN_CLOSE = String.raw`<[A-Za-z][A-Za-z0-9\-]*${ATTR}*\s*\/?>|<\/[A-Za-z][A-Za-z0-9\-]*\s*>`;
const INLINE_HTML = new RegExp(
  String.raw`^(?:${OPEN_CLOSE}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\s\S]*?[?]>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)`,
);
const BLOCK_NAMES =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
/** Start, end (null: a blank line) and whether it can interrupt a paragraph. */
const HTML_BLOCKS: Array<[RegExp, RegExp | null, boolean]> = [
  [/^<(script|pre|style|textarea)(?=(\s|>|$))/i, /<\/(script|pre|style|textarea)>/i, true],
  [/^<!--/, /-->/, true],
  [/^<\?/, /\?>/, true],
  [/^<![A-Za-z]/, />/, true],
  [/^<!\[CDATA\[/, /\]\]>/, true],
  [new RegExp(String.raw`^</?(${BLOCK_NAMES})(?=(\s|/?>|$))`, "i"), null, true],
  [new RegExp(String.raw`^(?:${OPEN_CLOSE})\s*$`), null, false],
];

/**
 * The raw HTML block a line opens, if any: its end, or null when a blank line ends it. `line` is
 * what follows its list item's marker or indentation; blockquote marks may lead it.
 */
function htmlBlock(line: string, inParagraph: boolean): { end: RegExp | null } | null {
  const inner = line.replace(QUOTE_MARKS, "");
  if (!/^ {0,3}</.test(inner)) return null;
  const t = inner.replace(/^ +/, "");
  for (const [start, end, interrupts] of HTML_BLOCKS) {
    if (!start.test(t)) continue;
    if (inParagraph && !interrupts) return null;
    return { end };
  }
  return null;
}

/** A URI or email autolink (CommonMark), at the start. */
const AUTOLINK =
  /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\x00-\x1f]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

/** A paragraph line as its inline text starts: without its blockquote marks or indentation. */
const paraText = (line: string) => line.replace(QUOTE_MARKS, "").replace(/^[ \t]+/, "");

/** Code spans and math as the parser reads the line: their text is shown as written, so nothing in them is escaped. */
function verbatim(line: string) {
  // `@`, `&` and `%` are escaped outside them, so the parser will find no marker, citation or comment:
  // scan as if there were none.
  const scan = scanInline(line.replace(/[@&%]/g, "x"), { ampLen: 0, atLen: 0, prose: true });
  return scan.skips.filter((s) => s.type === "code" || s.type === "math");
}

/** A table's delimiter row (GFM), as the line under its header. */
const DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** A table row's cells: an empty one at either end is only the pipe there (markdown-it). */
function cells(row: string): number {
  const cs = row
    .replace(QUOTE_MARKS, "")
    .replace(/^[ \t]+|[ \t]+$/g, "")
    .split(/(?<!\\)\|/);
  if (cs[0] === "") cs.shift();
  if (cs.length && cs[cs.length - 1] === "") cs.pop();
  return cs.length;
}
/** A table's header: a line with a pipe over a delimiter row (`next`, the line below) of as many cells. */
function tableAt(line: string, next: string | undefined): boolean {
  if (next === undefined) return false;
  const row = next.replace(QUOTE_MARKS, "");
  return (
    columns(row) < 4 &&
    !/^ *-(?:[ \t]|$)/.test(row) && // a list item, or a setext underline
    DELIMITER_ROW.test(row.replace(/^ +/, "")) &&
    /^ {0,3}[^ \t#>]/.test(line.replace(QUOTE_MARKS, "")) &&
    line.includes("|") && // an escaped one too
    cells(line) > 0 &&
    cells(line) === cells(next)
  );
}

/**
 * Lines CommonMark would not read as more of the paragraph above: a code span can't run on into them.
 * `next` is the line below, for a table's header. A `lazy` line, further out than the paragraph, can't
 * underline it or start a table.
 */
function startsBlock(line: string, next?: string, lazy = false): boolean {
  if (BLANK_RE.test(line)) return true;
  if (columns(line) >= 4) return false; // indented code can't break into a paragraph
  const t = line.replace(/^ {0,3}/, "");
  return (
    /^(?:>|#{1,6}(?:[ \t]|$)|`{3,}[^`]*$|~{3,}|\$\$|[-*+][ \t]+[^ \t]|1[.)][ \t]+[^ \t])/.test(t) ||
    (!lazy && /^(?:=+|-+)[ \t]*$/.test(t)) ||
    /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(t) ||
    htmlBlock(t, true) !== null ||
    (!lazy && tableAt(line, next))
  );
}

/** Where a backtick run of exactly `len` starts in `line`, or -1. */
function tickRun(line: string, len: number): number {
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (line[j] === "`") j++;
    if (j - i === len) return i;
    i = j;
  }
  return -1;
}

/**
 * Markdown pasted or clipped into a note, as a cited blockquote that shows as
 * the text alone would and that nothing in it can leave (SPEC §4.2). `@`, `&`
 * and `%` get a backslash where they would show as themselves; backslashes are
 * left alone, so the text's own escapes still work. Code and math are kept:
 * a code span over several lines is put on one (CommonMark shows its line
 * breaks as spaces), and a code fence or `$$` block left open is closed before
 * the `[@key]` line. Declarations (`` ```js @@ ``, `$$ %@@`) are taken apart,
 * so that no marker works inside the quote's code. `mathClosers` are the lines
 * where it closed math: CommonMark knows no math and shows them. `unfolded`
 * counts code spans left over several lines, because on one they would make
 * a table: the parser reads those as text. `loosened` counts list items
 * starting with indented code that had to be set off from the paragraph
 * above by a blank line, inside an outer list item, whose list it loosens.
 */
export function quoteMarkdown(text: string): { lines: string[]; mathClosers: number[]; unfolded: number; loosened: number } {
  const src = text.split(/\r\n|\r|\n/);
  // A line break at the end ends the last line; it starts no new one.
  if (src.length > 1 && src[src.length - 1] === "") src.pop();
  while (src.length && BLANK_RE.test(src[0])) src.shift();
  const out: string[] = [];
  const mathClosers: number[] = [];
  let unfolded = 0;
  let loosened = 0;
  // How the parser reads it: code and math blocks. `depth` and `item` are the blockquote and list item
  // CommonMark has them in, which end them; the parser knows neither.
  type Within = { depth: number; item: number };
  let fence: ({ char: string; len: number; prefix: string } & Within) | null = null;
  let math: ({ prefix: string } & Within) | null = null;
  // How CommonMark reads it: a raw HTML block, the list items open (their content columns), a paragraph.
  let html: ({ end: RegExp | null } & Within) | null = null;
  const items: number[] = [];
  let para = false;
  // The blockquote depth the open paragraph is at; a lazy line carries it on from further out.
  let paraDepth = 0;
  // Characters of the paragraph's next lines that inline HTML begun above takes in, line breaks counted.
  let carry = 0;
  // The last item opened with nothing after its marker, on the line above; a table's rows go on.
  let fresh = false;
  let table = false;
  let header = -1; // the line of the table's header
  const closeFence = () => {
    if (fence) out.push(fence.prefix + fence.char.repeat(fence.len));
    fence = null;
  };
  const closeMath = () => {
    if (!math) return;
    mathClosers.push(out.length);
    out.push(`${math.prefix}$$`);
    math = null;
  };
  for (let i = 0; i < src.length; i++) {
    let line = src[i];
    const cp = containerPrefix(line);
    const rest = line.slice(cp);
    const depth = quoteDepth(line);
    const blank = BLANK_RE.test(line.replace(QUOTE_MARKS, ""));
    const col = columns(line);
    // A blockquote that opens here starts a paragraph of its own.
    let wasPara: boolean = para && depth <= paraDepth;
    const shallower: boolean = wasPara && depth < paraDepth;
    para = false; // only a prose line, at the end, leaves a paragraph open

    // A blockquote or list item that ends takes its code and HTML with it; the parser needs to be told.
    const end = (gone: (w: Within) => boolean) => {
      if (fence && gone(fence)) closeFence();
      if (math && gone(math)) closeMath();
      if (html && gone(html)) html = null;
    };
    end((w) => depth < w.depth);

    // List items end at a line indented less than their content (a blockquote marker included, even on
    // an empty blockquote line), unless it carries on their paragraph. Code, math and HTML hold no list
    // items, and neither do blockquotes here.
    let itemHere = false;
    let lazyHere = false;
    // Whether the line above was in a list item.
    const inItem = items.length > 0;
    const wasFresh = fresh;
    fresh = false;
    if (BLANK_RE.test(line)) {
      // An item that starts with nothing after its marker holds nothing past a blank line.
      if (wasFresh) items.pop();
    } else {
      // `- ---` is a thematic break, not an item.
      const marker = depth === 0 && !THEMATIC_RE.test(line) ? LIST_MARKER.exec(line) : null;
      const top = items.length ? items[items.length - 1] : 0;
      // An empty item, or a numbered one that starts past 1, can't break into a paragraph that is as far in
      // as the line: it is the paragraph's. An item's paragraph it can, from further out (markdown-it).
      const interrupts: boolean =
        marker !== null &&
        (!wasPara || col < top || shallower || (marker[0].length < line.length && !/^[ \t]*(?:\d*[02-9]|\d{2,})[.)]/.test(marker[0])));
      const lazy: boolean = wasPara && !interrupts && !startsBlock(line, src[i + 1], col < top || shallower);
      lazyHere = lazy && col < top;
      while (items.length && col < items[items.length - 1] && !lazy) items.pop();
      const left = items.length ? items[items.length - 1] : 0;
      end((w) => w.item > left);
      if (marker && interrupts && !fence && !math && !html && col < left + 4) {
        fresh = marker[0].length === line.length;
        // The content starts after the marker and 1 to 4 spaces; with more, or none, one space after the marker.
        const at = width(marker[0].replace(/[ \t]+$/, ""));
        const spaces = width(marker[0]) - at;
        items.push(spaces >= 1 && spaces <= 4 && marker[0].length < line.length ? at + spaces : at + 1);
        itemHere = true;
      }
    }
    if (shallower) lazyHere = true;
    // A list item's first line starts its own paragraph.
    const interrupted = itemHere && wasPara;
    if (itemHere) wasPara = false;
    const pd: number = wasPara ? paraDepth : depth;
    const item = items.length ? items[items.length - 1] : 0;
    const within: Within = { depth, item };
    const carried = carry;
    carry = 0;
    // A table goes on to a blank line, indented code or another block (a list item of any kind).
    if (table && i > header + 1 && (blank || itemHere || col >= item + 4 || startsBlock(line, undefined, true))) table = false;

    if (fence) {
      const m = FENCE_RE.exec(rest);
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && /^\s*$/.test(m[2])) fence = null; // the parser's rule
      out.push(line);
      continue;
    }
    if (math) {
      if (line.includes("$$")) math = null;
      out.push(line);
      continue;
    }

    let inHtml = false;
    let htmlStarts = false;
    if (html) {
      // Blank within the HTML's own blockquote: a `>` deeper in is raw text.
      if (html.end === null && BLANK_RE.test(stripQuotes(line, html.depth))) html = null;
      else {
        inHtml = true;
        if (html.end?.test(line)) html = null;
      }
    } else {
      // A tag alone on a line can't break into a paragraph, or into a table's rows.
      const hb = htmlBlock(itemHere ? line.replace(LIST_MARKER, "") : dedent(line, item), wasPara || table);
      if (hb) {
        inHtml = htmlStarts = true;
        html = hb.end?.test(line) ? null : { end: hb.end, ...within };
      }
    }
    if (inHtml) {
      // Raw HTML shows no backslash escape, but it shows entities: `@ & %` become entities, and so does
      // the first character of a fence or `$$`, which would open code or math for the parser alone.
      let l = escapeSyntax(line, verbatim(line), [{ from: 0, to: line.length }]);
      const r = containerPrefix(l);
      if (FENCE_RE.test(l.slice(r)) || l.startsWith("$$", r)) l = l.slice(0, r) + `&#${l.charCodeAt(r)};` + l.slice(r + 1);
      // On its first line, a tab after the list marker stands for the spaces it reached.
      out.push(htmlStarts ? expandLead(l) : l);
      continue;
    }

    // Indented code (in a list item, or in a blockquote), which the parser reads as prose: the same code in
    // a fence, which it reads as code.
    const held = (l: string) => quoteDepth(l) >= depth;
    // Behind its blockquote markers, a tab in the indentation stands for the spaces it reached from where it was.
    const content = (l: string) => (depth ? unquote(l, depth, indent + 4) : l);
    const indent = depth ? 0 : item;
    const codeLine = (l: string) => held(l) && !BLANK_RE.test(content(l)) && columns(content(l)) >= indent + 4;
    const blankLine = (l: string) => held(l) && BLANK_RE.test(content(l));
    // A list item whose marker has more than 4 spaces after it starts with indented code: the marker goes
    // on a line of its own, and the fence under it.
    let mark: string | null = null;
    let first = line;
    if (itemHere) {
      const m = LIST_MARKER.exec(line)![0];
      const bare = m.replace(/[ \t]+$/, "");
      if (width(m) - width(bare) > 4 && m.length < line.length) {
        mark = bare;
        first = " ".repeat(width(bare)) + line.slice(bare.length);
      }
    }
    if (!wasPara && (mark !== null || (!itemHere && codeLine(line)))) {
      let j = i;
      while (j + 1 < src.length && (codeLine(src[j + 1]) || blankLine(src[j + 1]))) j++;
      while (j > i && blankLine(src[j])) j--;
      const code = [first, ...src.slice(i + 1, j + 1)].map((l) => dedent(content(l), indent + 4));
      const len = Math.max(3, ...code.map((l) => (/^`+/.exec(l.slice(containerPrefix(l)))?.[0].length ?? 0) + 1));
      const pad = depth ? "> ".repeat(depth) : " ".repeat(item);
      if (mark !== null) {
        // A marker with nothing after it can't break into a paragraph (`-` would underline it): a blank
        // line ends the paragraph first. After a paragraph in a list item, that blank line loosens the list:
        // the outer one, or the one the item above and this one are in.
        if (interrupted) {
          out.push("");
          if (items.length > 1 || inItem) loosened++;
        }
        out.push(mark);
      }
      out.push(pad + "`".repeat(len), ...code.map((l) => (l ? pad + l : pad.trimEnd())), pad + "`".repeat(len));
      i = j;
      continue;
    }

    const fm = FENCE_RE.exec(rest);
    const opens = fm && !(fm[1][0] === "`" && fm[2].includes("`"));
    const mathOpens = rest.startsWith("$$") && rest.indexOf("$$", 2) < 0;
    if (wasPara && (opens || mathOpens) && columns(line.replace(QUOTE_MARKS, "")) - (depth ? 0 : item) >= 4) {
      // Indented past the paragraph it carries on: text to CommonMark, but code or math to the parser.
      line = `${line.slice(0, cp)}\\${rest}`;
    } else if (opens) {
      // Its indentation as the spaces a tab in it stood for, as on a prose line.
      const prefix = expandLead(line.slice(0, cp));
      fence = { char: fm![1][0], len: fm![1].length, prefix, ...within };
      // CommonMark reads escapes in an info string, so `\@\@` is still `@@` to a reader but declares nothing.
      out.push(prefix + fm![1] + escapeSyntax(fm![2]));
      continue;
    } else if (mathOpens) {
      const prefix = expandLead(line.slice(0, cp));
      math = { prefix, ...within };
      // `$$ %@@` declares islands; `$$ % @@` is the same LaTeX comment and declares nothing.
      out.push((prefix + rest).replace(/^([ \t>]*\$\$[ \t]*%)(@)/, "$1 $2"));
      continue;
    }

    // A table's delimiter row is as far in as its header: further out, it is a lazy line.
    const inside = (j: number) => j < src.length && columns(src[j]) >= item && quoteDepth(src[j]) === pd;
    if (!table && !lazyHere && inside(i + 1) && tableAt(line, src[i + 1])) {
      table = true;
      header = i;
    }
    // A line of the paragraph without the marks of its blockquote or the indentation of its list item.
    const own = (l: string) => (pd ? stripQuotes(l, pd) : dedent(l, item));
    // Whether line `j` starts a block, by what follows those; further out than the paragraph, any list
    // marker starts one.
    const starts = (j: number) => {
      const outer = columns(src[j]) < item || quoteDepth(src[j]) < pd;
      return (
        startsBlock(own(src[j]), inside(j + 1) ? own(src[j + 1]) : undefined, outer) ||
        (outer && LIST_MARKER.test(src[j].replace(QUOTE_MARKS, "")))
      );
    };
    // A heading, a thematic break or a setext underline leaves no paragraph open; `===` with none above is
    // text, and so is `===` that carries on a paragraph from further out (a lazy line).
    const inner = (itemHere ? line.replace(LIST_MARKER, "") : line).replace(QUOTE_MARKS, "");
    para =
      !table &&
      !blank &&
      !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(inner) &&
      !THEMATIC_RE.test(inner) &&
      !(wasPara && !lazyHere && /^ {0,3}(?:=+|-+)[ \t]*$/.test(inner)) &&
      !BLANK_RE.test(inner);

    // Code spans and inline HTML, left to right as CommonMark reads them. A code span that runs on to a
    // later line of the paragraph goes on one line (the line break shows as a space; markdown-it keeps the
    // next line's indentation past the list item's). Inline HTML can run on over the paragraph's lines, and
    // what it takes in there is HTML.
    const spans: Range[] = [];
    const links: Range[] = [];
    let p = 0;
    if (wasPara && carried > 0) {
      const lead = line.length - paraText(line).length;
      const to = lead + carried - 1;
      spans.push({ from: lead, to: Math.min(line.length, to) });
      if (to > line.length) carry = to - line.length;
      p = to;
    }
    const after = (j: number) => {
      let s = "";
      for (; para && j < src.length && !starts(j); j++) s += "\n" + paraText(src[j]);
      return s;
    };
    while (carry === 0 && p < line.length) {
      const c = line[p];
      if (c === "\\") {
        p += 2;
        continue;
      }
      if (c === "`") {
        let q = p;
        while (line[q] === "`") q++;
        const n = q - p;
        const close = tickRun(line.slice(q), n);
        if (close >= 0) {
          p = q + close + n;
          continue;
        }
        let j = i + 1;
        while (para && j < src.length && !starts(j) && tickRun(src[j], n) < 0) j++;
        if (para && j < src.length && !starts(j)) {
          const joined = [line, ...src.slice(i + 1, j + 1).map(own)].join(" ");
          // On one line over a delimiter row, the paragraph would be a table: the span stays apart, and the
          // parser reads it as text (isolation wins).
          if (!tableAt(joined, src[j + 1])) {
            line = joined;
            i = j;
            continue; // its closer is on the line now
          }
          unfolded++;
        }
        p = q; // no closer: the run is text
        continue;
      }
      if (c === "<") {
        // An autolink takes no escape: one `@`, `&` or `%` in it is left as it is, more is taken apart.
        const link = AUTOLINK.exec(line.slice(p));
        if (link) {
          for (let k = p; k < p + link[0].length; k++)
            if ("@&%".includes(line[k]) && line[k - 1] !== line[k] && line[k + 1] !== line[k] && line[k - 1] !== "[")
              links.push({ from: k, to: k + 1 });
          p += link[0].length;
          continue;
        }
        const m = INLINE_HTML.exec(line.slice(p) + after(i + 1));
        if (m && p + m[0].length > line.length) {
          spans.push({ from: p, to: line.length });
          carry = p + m[0].length - line.length;
        } else if (m) {
          spans.push({ from: p, to: p + m[0].length });
          p += m[0].length;
          continue;
        }
      }
      p++;
    }
    const keep = [...verbatim(line), ...links];
    out.push(expandLead(escapeSyntax(line, keep, spans)));
    paraDepth = pd;
  }
  // Blank lines at the end are nothing, unless code or raw HTML left open holds them.
  if (!fence && !math && !html) while (out.length && BLANK_RE.test(out[out.length - 1])) out.pop();
  closeFence();
  closeMath();
  return { lines: out, mathClosers, unfolded, loosened };
}

/** What starts a block, or means something only at the start of a line: a heading or `#tag`, a blockquote,
 * a list item, raw HTML, a `~~~` fence, a link or footnote definition, a thematic break. */
const LINE_START = /^(?:#|>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|<|~~~|\[[^\]]*\]:|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/;

/**
 * Whether one line of Markdown shows the same inside `「…」[@key]` as on its own: nothing in it that could
 * be a marker, code, math, a comment or a quotation mark, nothing that means something only at the start
 * or end of a line (a trailing backslash would escape the `」`; `^id` is an Obsidian block ID), and no
 * space at either end, which a paragraph drops.
 */
const inlineQuotable = (t: string) =>
  /^[^`$%&@「」"\r\n\u2028\u2029]+$/.test(t) && t === t.trim() && !LINE_START.test(t) && !/\\$/.test(t) && !/\s\^[A-Za-z0-9-]+$/.test(t);

/**
 * `text` as a quote of `key`. By default the text is Markdown (pasted or clipped into a note) and shows as
 * it would on its own: one line that shows the same inside them stays in the line as `「…」[@key]`,
 * anything else is a cited blockquote whose last line is `> [@key]`. With `untrusted`, it is plain text,
 * every ASCII punctuation mark is escaped, and it is always a blockquote.
 */
export function quoteText(text: string, key: string, opts: QuoteOptions = {}): string {
  if (!KEY_RE.test(key)) throw new RangeError(`Not a Rakkan key: ${JSON.stringify(key)}`);
  if (opts.untrusted) {
    if (!text) return "";
    const lines = text.split(/\r\n|\r|\n/).map((l) => l.replace(ASCII_PUNCTUATION, "\\$&"));
    return [...lines.map((l) => (l ? `> ${l}` : ">")), `> [@${key}]`].join("\n");
  }
  if (inlineQuotable(text)) return `「${text}」[@${key}]`;
  const { lines } = quoteMarkdown(text);
  if (!lines.length) return "";
  return [...lines.map((l) => (l ? `> ${l}` : ">")), `> [@${key}]`].join("\n");
}
