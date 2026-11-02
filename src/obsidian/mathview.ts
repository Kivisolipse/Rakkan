// Display formulas, in reading view and live preview. A formula inside an AI
// block takes the block's colour; one that declares islands (`$$ %@@`) shows
// them in their own colour. Obsidian renders the formula with the markers
// still in it, so render it again from the TeX without markers, wrapping each
// island in MathJax's `\class` (the html package is loaded by Obsidian).

import { finishRenderMath, loadMathJax, renderMath } from "obsidian";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { fenceLines, type ParseResult } from "../core";
import { parseField, refreshEffect } from "../cm6/editor";
import { resolve, type StyleSettings } from "../cm6/resolve";

const ERROR = "mjx-merror, merror, [data-mml-node='merror'], [data-mjx-error]";

/** Whether `line` opens a display formula: `$$` after any blockquote markers, outside code. */
export function opensFormula(doc: ParseResult, line: number): boolean {
  const l = doc.lines[line];
  return !!l && doc.lineContexts[line]?.codeFence === undefined && /^[ \t>]*\$\$/.test(doc.text.slice(l.from, l.to));
}

/** The TeX of the formula whose `$$` line is `openLine`: markers dropped, islands wrapped when `island` is given. */
export function mathSource(doc: ParseResult, openLine: number, island?: string): string {
  return fenceLines(doc, openLine)
    .map(({ from, to }) => {
      let tex = "";
      let pos = from;
      for (const s of doc.segments) {
        if (s.to <= from || s.from >= to) continue;
        const a = Math.max(s.from, from);
        const b = Math.min(s.to, to);
        tex += doc.text.slice(pos, a);
        pos = b;
        if (s.role === "mark") continue;
        const part = doc.text.slice(a, b);
        tex += island && s.attr.kind === "human" && s.attr.explicit && part.trim() ? `\\class{${island}}{${part}}` : part;
      }
      return tex + doc.text.slice(pos, to);
    })
    .join("\n");
}

// Obsidian's MathJax drops any class that does not start with `mjx-`.
const ISLAND = "mjx-rk-island";

interface Styled {
  cls: string;
  style: string;
  /** The TeX rendered with its islands, or "" for none. */
  tex: string;
  stop: () => void;
}

const UNSTYLED: Styled = { cls: "", style: "", tex: "", stop: () => undefined };

/** What each formula was last styled with: only what changes is redone. */
const styled = new WeakMap<HTMLElement, Styled>();

const classes = (cls: string) => cls.split(" ").filter(Boolean);

/** Colour the rendered formula whose `$$` line is `openLine`. */
export function styleMath(mathEl: HTMLElement, doc: ParseResult, openLine: number, styles: StyleSettings) {
  const block = doc.lineContexts[openLine]?.base.block;
  const res = block !== undefined && doc.blocks[block] ? resolve({ kind: "ai", block, explicit: false }, doc, styles) : null;
  const cls = res?.cls ?? "";
  const style = res?.style ?? "";
  const tex = opensFormula(doc, openLine) && doc.lineContexts[openLine + 1]?.codeFence === openLine ? mathSource(doc, openLine, ISLAND) : "";
  const prev = styled.get(mathEl) ?? UNSTYLED;
  if (cls !== prev.cls) {
    mathEl.removeClasses(classes(prev.cls));
    mathEl.addClasses(classes(cls));
  }
  if (style !== prev.style) {
    if (style) mathEl.setAttribute("style", style);
    else mathEl.removeAttribute("style");
  }
  let { stop } = prev;
  if (tex !== prev.tex) {
    stop();
    stop = tex ? colourMathIslands(mathEl, tex, mathSource(doc, openLine)) : UNSTYLED.stop;
  }
  styled.set(mathEl, { cls, style, tex, stop });
}

/**
 * Render a formula that declares islands again, from `island` (or `plain`,
 * should that fail). Obsidian renders in its own time and may replace what is
 * here, so the new rendering is put back if it does. Anything else in the
 * element (live preview's edit button) stays. Returns a function that stops it.
 */
function colourMathIslands(mathEl: HTMLElement, island: string, plain: string): () => void {
  if (!plain.trim()) return () => undefined;
  let live = true;
  const observer = new MutationObserver(() => {
    if (!mathEl.querySelector(":scope > [data-rk]") && mathEl.isConnected) apply();
  });
  function apply() {
    observer.disconnect();
    try {
      let out = renderMath(island, true);
      if (out.querySelector(ERROR)) out = renderMath(plain, true);
      finishRenderMath();
      if (!out.querySelector(ERROR)) {
        out.dataset.rk = "1";
        const old = mathEl.querySelector(":scope > mjx-container");
        if (old) old.replaceWith(out);
        else mathEl.prepend(out);
      }
    } catch (e) {
      console.error("Rakkan: could not render the formula", e);
    }
    observer.observe(mathEl, { childList: true });
  }
  void loadMathJax().then(() => live && apply(), () => undefined);
  return () => {
    live = false;
    observer.disconnect();
  };
}

/** Live preview: style the display formula widgets the editor has drawn, again when the note or the settings change. */
export function liveMath(styles: () => StyleSettings) {
  return ViewPlugin.fromClass(
    class {
      frame = 0;
      constructor(readonly view: EditorView) {
        this.schedule();
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)))) this.schedule();
      }
      schedule() {
        window.cancelAnimationFrame(this.frame);
        this.frame = window.requestAnimationFrame(() => this.scan());
      }
      scan() {
        const { view } = this;
        const doc = view.state.field(parseField, false);
        if (!doc) return;
        for (const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>("div.math"))) {
          let line: number;
          try {
            line = view.state.doc.lineAt(view.posAtDOM(el)).number - 1;
          } catch {
            continue;
          }
          if (!opensFormula(doc, line)) continue;
          styleMath(el, doc, line, styles());
        }
      }
      destroy() {
        window.cancelAnimationFrame(this.frame);
      }
    },
  );
}
