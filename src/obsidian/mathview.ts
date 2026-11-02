// Reading view: a formula that declares islands (`$$ %@@`) shows them in their
// own colour. Obsidian renders the formula with the markers still in it, so
// render it again from the TeX without markers, wrapping each island in
// MathJax's `\class` (the html package is loaded by Obsidian).

import { finishRenderMath, loadMathJax, renderMath } from "obsidian";
import type { ParseResult } from "../core";
import { resolve, type StyleSettings } from "../cm6/resolve";

const ERROR = "mjx-merror, merror, [data-mml-node='merror'], [data-mjx-error]";

/** The TeX of the formula whose `$$` line is `openLine`: markers dropped, islands wrapped when `island` is given. */
export function mathSource(doc: ParseResult, openLine: number, island?: string): string {
  const lines: number[] = [];
  for (let i = openLine + 1; i < doc.lineContexts.length && doc.lineContexts[i].codeFence === openLine; i++) lines.push(i);
  if (!lines.length) return "";
  const start = doc.lines[lines[0]].from;
  const end = doc.lines[lines[lines.length - 1]].to;
  let tex = "";
  let pos = start;
  for (const s of doc.segments) {
    if (s.to <= start || s.from >= end) continue;
    if (s.from > pos) tex += doc.text.slice(pos, s.from);
    pos = s.to;
    if (s.role === "mark") continue;
    const part = doc.text.slice(s.from, s.to);
    if (island && s.attr.kind === "human" && s.attr.explicit && part.trim()) tex += `\\class{${island}}{${part}}`;
    else tex += part;
  }
  return tex + doc.text.slice(pos, end);
}

/**
 * Re-render the formula of a math block that declares islands. Obsidian
 * renders in its own time and may replace what is here, so the new rendering
 * is put back if it does.
 */
export function colourMathIslands(mathEl: HTMLElement, doc: ParseResult, openLine: number, styles: StyleSettings) {
  const cls = resolve({ kind: "human", explicit: true }, doc, styles)?.cls ?? "rk rk-island";
  const island = mathSource(doc, openLine, cls);
  const plain = mathSource(doc, openLine);
  if (!plain.trim()) return;

  let observer: MutationObserver | null = null;
  const apply = () => {
    observer?.disconnect();
    try {
      let out = renderMath(island, true);
      if (out.querySelector(ERROR)) out = renderMath(plain, true);
      finishRenderMath();
      if (!out.querySelector(ERROR)) {
        out.dataset.rk = "1";
        mathEl.empty();
        mathEl.appendChild(out);
      }
    } catch (e) {
      console.error("Rakkan: could not render the formula", e);
    }
    observer?.observe(mathEl, { childList: true });
  };
  observer = new MutationObserver(() => {
    if (!mathEl.querySelector("[data-rk]") && mathEl.isConnected) apply();
  });
  void loadMathJax().then(apply, () => undefined);
}
