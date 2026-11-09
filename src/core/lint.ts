// Checks for a note written outside Obsidian, where nothing shows a mistake as
// it is made: what the parser warns about, markers that found no partner and
// show as text, and `[@key]` that nothing defines. In the editor these show at
// once, so the plugin keeps to the parser's own warnings.

import type { Author } from "./authors";
import { scanInline } from "./inline";
import { indexAt } from "./parse";
import { familyOf, type ExtraPrefix } from "./signature";
import type { Attr, DiagnosticCode, ParseResult } from "./types";

export type LintCode = DiagnosticCode | "unpaired-marker" | "inert-marker" | "unknown-key" | "split-code-span";

export interface LintIssue {
  from: number;
  to: number;
  line: number;
  code: LintCode;
  /** Chinese, translated where it is shown; `{mark}` and `{key}` come from `vars`. */
  message: string;
  vars?: Record<string, string>;
}

/** Whether markers of this type pair up in text of this attribution (SPEC §3.2). */
function active(a: Attr, type: "amp" | "at"): boolean {
  if (a.kind === "quote") return true;
  if (a.kind === "ai") return type === "at";
  return !a.explicit && type === "amp";
}

/**
 * Problems in a parsed note. `authors` is the author book; a key is also known
 * from the note's own definitions, and an AI's key from a model ID alone.
 */
export function lint(r: ParseResult, authors: Record<string, Author> = {}, extra: ExtraPrefix[] = []): LintIssue[] {
  const issues: LintIssue[] = r.diagnostics.map((d) => ({ ...d }));
  const reported = (from: number) => r.diagnostics.some((d) => from >= d.from && from < d.to);

  // Marker runs the scanner found that no pair took.
  for (let i = 0; i < r.lines.length; i++) {
    const c = r.lineContexts[i];
    if (c.mode === "other") continue;
    const from = r.lines[i].from + c.prefix;
    const scan = scanInline(r.text.slice(from, r.lines[i].to), {
      ampLen: c.ampLen,
      atLen: c.atLen,
      prose: c.mode === "prose",
      inComment: c.inComment,
    });
    for (const t of scan.tokens) {
      const pos = from + t.from;
      const seg = r.segments[indexAt(r.segments, pos)];
      if (!seg || seg.role === "mark" || reported(pos)) continue;
      const at = { from: pos, to: from + t.to, line: i, vars: { mark: r.text.slice(pos, from + t.to) } };
      if (active(seg.attr, t.type)) issues.push({ ...at, code: "unpaired-marker", message: "{mark} 在这一行没有配对，按原样显示" });
      else if (seg.attr.kind === "ai") issues.push({ ...at, code: "inert-marker", message: "AI 文字里的 {mark} 不是标记，按原样显示" });
      else if (seg.attr.explicit) issues.push({ ...at, code: "inert-marker", message: "原创岛里的 {mark} 不是标记，按原样显示" });
      else issues.push({ ...at, code: "inert-marker", message: "{mark} 只在 AI 文字和引用里标出人写的字，这里按原样显示" });
    }
  }

  // Code spans over several lines of a paragraph. CommonMark shows them as code; the parser reads a line at
  // a time and sees none, so markers in them work and their text counts.
  const content = (i: number) => r.text.slice(r.lines[i].from + r.lineContexts[i].prefix, r.lines[i].to);
  const ends = (i: number) =>
    r.lineContexts[i].mode === "other" || /^[ \t]*$|^ {0,3}(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t]|>)/.test(content(i));
  for (let i = 0; i < r.lines.length; i++) {
    const c = r.lineContexts[i];
    if (c.mode === "other") continue;
    const text = content(i);
    const scan = scanInline(text, { ampLen: c.ampLen, atLen: c.atLen, prose: c.mode === "prose", inComment: c.inComment });
    const run = /`+/g;
    for (let m = run.exec(text); m; m = run.exec(text)) {
      const at = m.index;
      if (scan.skips.some((k) => at >= k.from && at < k.to) || text[at - 1] === "\\") continue;
      // No closer on this line, or the scanner would have skipped it: look for one further on.
      let close = -1;
      for (let j = i + 1; j < r.lines.length && !ends(j); j++) {
        if (new RegExp(`(?<!\`)\`{${m[0].length}}(?!\`)`).test(content(j))) {
          close = j;
          break;
        }
      }
      if (close < 0) continue;
      const from = r.lines[i].from + c.prefix + at;
      issues.push({
        from,
        to: from + m[0].length,
        line: i,
        code: "split-code-span",
        message: "这段代码跨了行：Rakkan 一行一行读，看不到它，里面的标记照样生效。把它写在一行里",
      });
      i = close - 1;
      break;
    }
  }

  // Keys, each reported once, where it first names an author.
  const seen = new Set<string>();
  for (const s of r.segments) {
    const key = s.attr.key;
    if (s.mark !== "cite" || !key || seen.has(key)) continue;
    seen.add(key);
    if (key in authors || key in r.definitions) continue;
    const at = { from: s.from, to: s.to, line: indexAt(r.lines, s.from, true), code: "unknown-key" as const, vars: { key } };
    if (s.attr.kind !== "ai") issues.push({ ...at, message: "[@{key}] 没有定义：在笔记末尾加一行 @{key}: 名字 · 来源，或写进署名簿" });
    else if (!familyOf(key, extra)) issues.push({ ...at, message: "[@{key}] 没有定义，也不是认得出的模型 ID" });
  }

  return issues.sort((a, b) => a.from - b.from);
}
