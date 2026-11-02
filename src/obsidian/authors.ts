// The author book (a note in the vault), the `[@` completion menu and the
// picker used by "paste as quote".

import {
  App,
  Editor,
  EditorSuggest,
  SuggestModal,
  TFile,
  type EditorPosition,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
} from "obsidian";
import { BOOK_TEMPLATE, BOOK_TEMPLATE_EN, parseBook, type Author, type ExtraPrefix } from "../core";
import { language, t } from "../i18n";

export const kindLabel = (kind: "human" | "ai" | "source"): string => (kind === "ai" ? "AI" : kind === "human" ? t("人") : t("来源"));

export async function loadBook(app: App, path: string, extra: ExtraPrefix[]): Promise<Record<string, Author>> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return {};
  return parseBook(await app.vault.cachedRead(file), extra);
}

/** Create the book from the template (never overwrites). Returns the file. */
export async function createBook(app: App, path: string): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return existing;
  const slash = path.lastIndexOf("/");
  if (slash > 0 && !app.vault.getAbstractFileByPath(path.slice(0, slash))) {
    await app.vault.createFolder(path.slice(0, slash));
  }
  return app.vault.create(path, language() === "en" ? BOOK_TEMPLATE_EN : BOOK_TEMPLATE);
}

export interface AuthorSource {
  /** The book plus the current note's own definitions. */
  authors(): Author[];
}

const matches = (a: Author, q: string) =>
  !q || [a.key, a.name, a.id].some((x) => x?.toLowerCase().includes(q));

/** Typing `[@` (or `【@` from a Chinese IME) opens the author list. */
export class AuthorSuggest extends EditorSuggest<Author> {
  constructor(
    app: App,
    private source: AuthorSource,
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const m = /[[【]@([^\]】\s]*)$/.exec(before);
    if (!m) return null;
    return { start: { line: cursor.line, ch: m.index }, end: cursor, query: m[1] };
  }

  getSuggestions(ctx: EditorSuggestContext): Author[] {
    const q = ctx.query.toLowerCase();
    return this.source.authors().filter((a) => matches(a, q));
  }

  renderSuggestion(a: Author, el: HTMLElement): void {
    el.createDiv({ text: a.name ?? `@${a.key}` });
    el.createEl("small", { text: `@${a.key} · ${kindLabel(a.kind)}${a.id ? ` · ${a.id}` : ""}` });
  }

  selectSuggestion(a: Author): void {
    const ctx = this.context;
    if (!ctx) return;
    ctx.editor.replaceRange(`[@${a.key}]`, ctx.start, ctx.end);
  }
}

/** Pick an author for a quote; typing a key that is not in the list uses it as a new key. */
export class AuthorPickerModal extends SuggestModal<Author> {
  constructor(
    app: App,
    private source: AuthorSource,
    private onPick: (key: string) => void,
    /** When set, the first choice is "no author" (an empty key) with this label. */
    private noneLabel?: string,
  ) {
    super(app);
    this.setPlaceholder(t("选择作者，或输入新的 key"));
  }

  getSuggestions(query: string): Author[] {
    const q = query.trim().toLowerCase().replace(/^@/, "");
    const found = this.source.authors().filter((a) => matches(a, q));
    if (!q && this.noneLabel) found.unshift({ key: "", name: this.noneLabel, kind: "ai" });
    if (q && !found.some((a) => a.key.toLowerCase() === q)) {
      found.push({ key: query.trim().replace(/^@/, ""), kind: "human" });
    }
    return found;
  }

  renderSuggestion(a: Author, el: HTMLElement): void {
    el.createDiv({ text: a.name ?? `@${a.key}` });
    if (!a.key) return;
    el.createEl("small", { text: `@${a.key}${a.name ? ` · ${kindLabel(a.kind)}` : t(" · 新 key")}` });
  }

  onChooseSuggestion(a: Author): void {
    this.onPick(a.key);
  }
}
