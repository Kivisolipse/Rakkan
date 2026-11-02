// Embeds (`![[note]]`) and previews are rendered with getSectionInfo() = null,
// so the reading view's post-processor cannot tell which lines of the note a
// piece came from, and AI blocks and code islands inside them lose their
// colour. Read the note, find each rendered piece by its words, and process it
// with the lines it really has.

import { TFile, type App, type MarkdownPostProcessorContext } from "obsidian";
import { alignSections, splitSections } from "../core";
import { parseCached, processSection, type ReadingDeps } from "./reading";

export function processWithoutLines(app: App, el: HTMLElement, ctx: MarkdownPostProcessorContext, deps: ReadingDeps): Promise<void> | void {
  const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile) || file.extension !== "md") return processSection(el, ctx, deps);
  return app.vault.cachedRead(file).then(
    (text) => place(el, ctx, deps, text),
    () => processSection(el, ctx, deps),
  );
}

function place(el: HTMLElement, ctx: MarkdownPostProcessorContext, deps: ReadingDeps, text: string) {
  const r = parseCached(text);
  // Without AI blocks or declared code there is nothing the lines would add.
  if (!r.blocks.length && !r.lineContexts.some((c) => c.mode === "code")) return processSection(el, ctx, deps);

  const lines = text.split("\n");
  const pieces = splitSections(r);
  const source = pieces.map((p) => lines.slice(p.lineStart, p.lineEnd + 1).join("\n"));
  const textOf = (e: Element) => e.textContent ?? "";

  // The pieces may sit one or two wrappers deep.
  let kids = Array.from(el.children) as HTMLElement[];
  for (let depth = 0; depth < 3 && kids.length === 1; depth++) {
    if (alignSections([textOf(kids[0])], source)[0] !== null || !kids[0].children.length) break;
    kids = Array.from(kids[0].children) as HTMLElement[];
  }
  if (!kids.length) return processSection(el, ctx, deps);

  const found = alignSections(kids.map(textOf), source);
  kids.forEach((kid, i) => {
    const at = found[i];
    const sub =
      at === null
        ? ctx
        : ({
            ...ctx,
            getSectionInfo: () => ({ text, lineStart: pieces[at].lineStart, lineEnd: pieces[at].lineEnd }),
          } as MarkdownPostProcessorContext);
    processSection(kid, sub, deps);
  });
}
