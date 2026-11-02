// Rakkan's own search window, for when Obsidian's search boxes are left alone:
// one for the vault, one for the current note. Notes are searched with their
// markers removed, so a word split by markers is one word; a hit opens the note
// with the hit selected in the source.

import { Keymap, MarkdownView, Platform, SuggestModal, type App, type TFile } from "obsidian";
import { excerpt, findLoose, findPlain, looseRegex, mayHaveMarkers, parse, stripMarkers, type PlainHit, type Stripped } from "../core";
import { t } from "../i18n";

/** The note without markers; most notes have none and are kept as read. */
const plainText = (source: string) => (mayHaveMarkers(source) ? stripMarkers(parse(source)).text : source);

/** The notes without markers, kept until a note changes. Only the text is kept: hits are mapped to the source when one is opened. */
export class PlainNotes {
  private cache = new Map<string, { mtime: number; text: Promise<string> }>();

  constructor(private app: App) {}

  /** Every note, read once and shared by the searches waiting on it. */
  async all(): Promise<Array<{ file: TFile; text: string }>> {
    const files = this.app.vault.getMarkdownFiles();
    // Rebuilt from the vault each time, so deleted and renamed notes drop out.
    const cache = new Map<string, { mtime: number; text: Promise<string> }>();
    for (const file of files) {
      const old = this.cache.get(file.path);
      cache.set(file.path, old && old.mtime === file.stat.mtime ? old : { mtime: file.stat.mtime, text: this.app.vault.cachedRead(file).then(plainText, () => "") });
    }
    this.cache = cache;
    const texts = await Promise.all(files.map((file) => cache.get(file.path)!.text));
    return files.map((file, i) => ({ file, text: texts[i] }));
  }
}

/** Select [from, to) of the note's source in editing view; reading view scrolls to its line. */
function selectRange(view: MarkdownView, from: number, to: number) {
  const { editor } = view;
  const a = editor.offsetToPos(from);
  if (view.getMode() !== "source") {
    view.setEphemeralState({ line: a.line });
    return;
  }
  const b = editor.offsetToPos(to);
  editor.setSelection(a, b);
  editor.scrollIntoView({ from: a, to: b }, true);
  editor.focus();
}

function renderExcerpt(el: HTMLElement, text: string, from: number, to: number) {
  const ex = excerpt(text, from, to);
  el.appendText(ex.before);
  el.createSpan({ cls: "suggestion-highlight", text: ex.hit });
  el.appendText(ex.after);
}

// As Obsidian writes it (on iOS too, which it counts as macOS).
const MOD_ENTER = Platform.isMacOS ? "⌘ ↵" : "ctrl ↵";

interface NoteResult {
  file: TFile;
  /** The note without markers. */
  text: string;
  /** The first hit of the whole query, or of its first word, in `text`; null when only the title matches. */
  hit: { term: string; from: number; to: number } | null;
  count: number;
  score: number;
}

export class VaultSearchModal extends SuggestModal<NoteResult> {
  constructor(
    app: App,
    private notes: PlainNotes,
    private initial = "",
  ) {
    super(app);
    this.limit = 50;
    this.emptyStateText = t("没有找到匹配的笔记");
    this.setPlaceholder(t("搜索（忽略格式）"));
    this.setInstructions([
      { command: "↑↓", purpose: t("选择") },
      { command: "↵", purpose: t("打开") },
      { command: MOD_ENTER, purpose: t("在新标签页打开") },
      { command: "esc", purpose: t("关闭窗口") },
    ]);
    this.scope.register(["Mod"], "Enter", (e) => {
      this.selectActiveSuggestion(e);
      return false;
    });
  }

  override onOpen() {
    super.onOpen();
    if (this.initial) {
      this.inputEl.value = this.initial;
      this.inputEl.dispatchEvent(new Event("input"));
    }
  }

  /** Every word must appear in the title or the note; the whole query, as a phrase, ranks higher. */
  async getSuggestions(query: string): Promise<NoteResult[]> {
    const phrase = query.trim();
    const words = phrase.split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    // Wait for the notes once, then match without awaiting: Obsidian shows
    // whichever search finishes last, so they must finish in the order typed.
    const notes = await this.notes.all();
    const wordRes = words.map((w) => looseRegex(w, "i"));
    const phraseRe = looseRegex(phrase, "i");
    const out: NoteResult[] = [];
    for (const { file, text } of notes) {
      const title = file.basename;
      if (!wordRes.every((re) => re.test(title) || re.test(text))) continue;
      const hits = findLoose(text, phrase);
      const term = hits.length ? phrase : words[0];
      const at = hits[0] ?? findLoose(text, term, 1)[0];
      out.push({ file, text, hit: at ? { term, ...at } : null, count: hits.length, score: (phraseRe.test(title) ? 1000 : 0) + hits.length });
    }
    return out.sort((a, b) => b.score - a.score || b.file.stat.mtime - a.file.stat.mtime);
  }

  renderSuggestion(r: NoteResult, el: HTMLElement) {
    el.addClass("mod-complex");
    const content = el.createDiv("suggestion-content");
    content.createDiv({ cls: "suggestion-title", text: r.file.basename });
    if (r.hit) renderExcerpt(content.createDiv("suggestion-note"), r.text, r.hit.from, r.hit.to);
    else if (r.file.parent && !r.file.parent.isRoot()) content.createDiv({ cls: "suggestion-note", text: r.file.parent.path });
    if (r.count > 1) el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair", text: String(r.count) });
  }

  async onChooseSuggestion(r: NoteResult, evt: MouseEvent | KeyboardEvent) {
    const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(evt));
    await leaf.openFile(r.file, { active: true });
    // Find the hit again in the note as opened, and select it there.
    const { view } = leaf;
    if (!r.hit || !(view instanceof MarkdownView)) return;
    const hit = findPlain(stripMarkers(parse(view.editor.getValue())), r.hit.term, 1)[0];
    if (hit) selectRange(view, hit.from, hit.to);
  }
}

export class NoteSearchModal extends SuggestModal<PlainHit> {
  private plain: Stripped;

  constructor(
    app: App,
    private view: MarkdownView,
  ) {
    super(app);
    this.plain = stripMarkers(parse(view.editor.getValue()));
    this.limit = 200;
    this.emptyStateText = t("没有找到");
    this.setPlaceholder(t("在当前笔记中查找（忽略格式）"));
    this.setInstructions([
      { command: "↑↓", purpose: t("选择") },
      { command: "↵", purpose: t("跳转") },
      { command: "esc", purpose: t("关闭窗口") },
    ]);
  }

  getSuggestions(query: string): PlainHit[] {
    return findPlain(this.plain, query, this.limit);
  }

  renderSuggestion(hit: PlainHit, el: HTMLElement) {
    el.addClass("mod-complex");
    renderExcerpt(el.createDiv("suggestion-content").createDiv("suggestion-title"), this.plain.text, hit.plainFrom, hit.plainTo);
    const line = this.view.editor.offsetToPos(hit.from).line + 1;
    el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair", text: t("第 {n} 行", { n: line }) });
  }

  onChooseSuggestion(hit: PlainHit) {
    selectRange(this.view, hit.from, hit.to);
  }
}
