// A code block that declares markers has them in its source, and Obsidian's
// copy controls copy the source: the copy button in reading view, the language
// label in live preview. Catch the click before their own handlers (in the
// capture phase, on an ancestor) and copy the code without the markers.

import { Notice } from "obsidian";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { codeBlockText, type ParseResult } from "../core";
import { parseField } from "../cm6/editor";
import { t } from "../i18n";

/** Copy the code of the block opened on `fenceLine` without its markers, in place of `e`; a block without markers is left to Obsidian. */
function copyPlain(e: Event, doc: ParseResult, fenceLine: number) {
  const code = codeBlockText(doc, fenceLine);
  if (!code || code.plain === code.raw) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  void navigator.clipboard.writeText(code.plain).then(() => new Notice(t("已复制（已移除标记）")));
}

/** Reading view: the copy button of the rendered block `pre`, opened on `fenceLine`. */
export function takeOverCopyButton(pre: HTMLElement, doc: ParseResult, fenceLine: number) {
  pre.addEventListener(
    "click",
    (e) => {
      if ((e.target as HTMLElement).closest(".copy-code-button")) copyPlain(e, doc, fenceLine);
    },
    true,
  );
}

/** Live preview: the language label (or copy icon) at the top of each code block. */
export function liveCodeCopy() {
  return ViewPlugin.fromClass(
    class {
      handler: (e: MouseEvent) => void;
      constructor(readonly view: EditorView) {
        this.handler = (e) => {
          const label = (e.target as HTMLElement | null)?.closest?.(".code-block-flair");
          if (!label || !view.dom.contains(label)) return;
          let line: number;
          try {
            line = view.state.doc.lineAt(view.posAtDOM(label)).number - 1;
          } catch {
            return;
          }
          const doc = view.state.field(parseField);
          // The label sits on the opening fence or on a line of the code.
          copyPlain(e, doc, doc.lineContexts[line]?.codeFence ?? line);
        };
        view.dom.addEventListener("click", this.handler, true);
      }
      destroy() {
        this.view.dom.removeEventListener("click", this.handler, true);
      }
    },
  );
}
