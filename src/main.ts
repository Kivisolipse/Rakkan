import { editorLivePreviewField, getLanguage, MarkdownView, MenuItem, normalizePath, Notice, Plugin, TFile, type Component, type Editor, type Menu } from "obsidian";
import { ChangeSet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { diffChanges, insertQuote, Parser, parseAuthor, quoteText, setBookColor, signRevision, trimPaste, type Author, type ParseResult } from "./core";
import { parseField, rakkanEditor, refreshEffect } from "./cm6/editor";
import { STYLES, type StyleSettings } from "./cm6/resolve";
import { processSection } from "./obsidian/reading";
import { processWithoutLines } from "./obsidian/embeds";
import { DEFAULT_SETTINGS, RakkanSettingTab, type RakkanSettings } from "./obsidian/settings";
import { colorVars } from "./cm6/colors";
import { DiagnosticsModal, statusText } from "./obsidian/statusbar";
import { NativeSearch } from "./obsidian/search";
import { NoteSearchModal, PlainNotes, VaultSearchModal } from "./obsidian/searchwindow";
import { OmnisearchCompat } from "./obsidian/omnisearch";
import { liveMath } from "./obsidian/mathview";
import { liveCodeCopy } from "./obsidian/codecopy";
import { AuthorsModal } from "./obsidian/authorsmodal";
import { AuthorPickerModal, AuthorSuggest, createBook, loadBook } from "./obsidian/authors";
import { exportPdf, PdfModal, previewPdf, type PdfOptions } from "./obsidian/pdf";
import { exportNote, importIA, type ExportKind } from "./obsidian/export";
import { publishCss, writePublishCss } from "./obsidian/publish";
import { fixBlankLines, insertBlock, markSelection, pasteAsAI, stripSelection } from "./obsidian/commands";
import { clarifyAtCursor, gotoNextMixedQuote } from "./obsidian/clarify";
import { setLanguage, t } from "./i18n";

const cmOf = (editor: Editor) => (editor as unknown as { cm?: EditorView }).cm ?? null;

export default class RakkanPlugin extends Plugin {
  override settings: RakkanSettings = { ...DEFAULT_SETTINGS };
  /** Immutable snapshot handed to renderers; replaced on every settings change. */
  private styleSnapshot: StyleSettings = { ...DEFAULT_SETTINGS, authors: {} };
  /** The author book. */
  authors: Record<string, Author> = {};
  /** The colour variables set on the body, to clear what is no longer set. */
  private colorKeys: string[] = [];
  private statusEl: HTMLElement | null = null;
  private lastResult: ParseResult | null = null;
  private fallbackParser = new Parser();
  /** The search parts that follow the settings: native toggles or none, Omnisearch compatibility or none. */
  private nativeSearch: NativeSearch | null = null;
  private omnisearchCompat: OmnisearchCompat | null = null;
  private plainNotes = new PlainNotes(this.app);

  override async onload() {
    await this.loadSettings();
    await this.reloadBook();

    this.applyAppearance();
    // The colours differ between the light and the dark theme.
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyColors()));
    this.register(() => document.body.setCssProps(Object.fromEntries(this.colorKeys.map((k) => [k, ""]))));

    this.registerEditorExtension(
      rakkanEditor({
        styles: () => this.styleSnapshot,
        hideMarkers: (state) => this.settings.hideMarkers && (state.field(editorLivePreviewField, false) ?? false),
        stripOnCopy: () => this.settings.stripOnCopy,
        autoAnnotate: () => this.settings.autoAnnotate,
      }),
    );
    this.registerEditorExtension([liveMath(() => this.styleSnapshot), liveCodeCopy()]);
    this.applySearch();

    // Colours that follow the horizontal position need to know where the reading column is.
    let anchorFrame = 0;
    const anchorSoon = () => {
      window.cancelAnimationFrame(anchorFrame);
      anchorFrame = window.requestAnimationFrame(() => this.anchorReading());
    };
    this.registerMarkdownPostProcessor((el, ctx) => {
      // PDF export renders the pieces itself and colours them with their real lines.
      if (el.closest(".rk-export")) return;
      const deps = { styles: () => this.styleSnapshot };
      if (ctx.getSectionInfo(el)) {
        processSection(el, ctx, deps);
        anchorSoon();
        return;
      }
      // Embeds and previews come without lines: find the pieces in the note.
      return Promise.resolve(processWithoutLines(this.app, el, ctx, deps)).then(anchorSoon);
    }, 100);
    this.registerDomEvent(window, "resize", anchorSoon);
    this.registerEvent(this.app.workspace.on("layout-change", anchorSoon));
    this.registerEvent(this.app.workspace.on("resize", anchorSoon));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("rk-status", "mod-clickable");
    this.statusEl.addEventListener("click", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      new DiagnosticsModal(this.app, this.lastResult?.diagnostics ?? [], view).open();
    });
    const refreshStatus = () => this.updateStatus();
    this.registerEvent(this.app.workspace.on("active-leaf-change", refreshStatus));
    this.registerEvent(this.app.workspace.on("layout-change", refreshStatus));
    let timer: number | undefined;
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(refreshStatus, 250);
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      refreshStatus();
      // Reading views restored before the plugin loaded were rendered without it.
      this.refresh();
    });

    // Re-read the author book when its note changes.
    const bookEvent = (file: { path: string }) => {
      if (file.path === this.settings.bookPath) void this.reloadBook().then(() => this.refresh());
    };
    this.registerEvent(this.app.vault.on("modify", bookEvent));
    this.registerEvent(this.app.vault.on("create", bookEvent));
    this.registerEvent(this.app.vault.on("delete", bookEvent));
    this.registerEvent(this.app.vault.on("rename", (file, old) => {
      bookEvent(file);
      bookEvent({ path: old });
    }));

    this.registerEditorSuggest(new AuthorSuggest(this.app, { authors: () => Object.values(this.allAuthors()) }));

    this.addSettingTab(new RakkanSettingTab(this.app, this));
    this.addCommands();
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => this.buildMenu(menu, editor)));
    // The three-dot menu of a note (reading view included) and the file explorer's right-click menu.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) => item.setTitle(t("导出为 PDF（Rakkan）…")).setIcon("file-output").setSection("action").onClick(() => this.openPdfExport(file)));
      }),
    );
  }

  private addCommands() {
    const withView = (fn: (view: EditorView) => void) => (editor: Editor) => {
      const view = cmOf(editor);
      if (view) fn(view);
    };

    this.addCommand({
      id: "mark-ai",
      name: t("标记为 AI 生成"),
      editorCallback: withView((view) => this.markAs(view, "ai")),
    });
    this.addCommand({
      id: "mark-human",
      name: t("标记为原创"),
      editorCallback: withView((view) => this.markAs(view, "human")),
    });
    this.addCommand({
      id: "strip-markers",
      name: t("移除标记（选区或整篇）"),
      editorCallback: withView((view) => stripSelection(view)),
    });
    this.addCommand({
      id: "insert-block",
      name: t("插入 AI 块"),
      editorCallback: withView((view) => insertBlock(view, this.settings.defaultSignature)),
    });
    this.addCommand({
      id: "fix-blank-lines",
      name: t("补全块开合行的空行"),
      editorCallback: withView((view) => {
        const n = fixBlankLines(view);
        new Notice(n ? t("已补全 {n} 个空行", { n }) : t("开合行前后均已有空行"));
      }),
    });
    this.addCommand({
      id: "paste-as-quote",
      name: t("粘贴为引用"),
      editorCallback: (editor) => this.pasteAsQuote(editor),
    });
    this.addCommand({
      id: "clarify-quote",
      name: t("澄清引文"),
      editorCallback: withView((view) => this.clarifyQuote(view)),
    });
    this.addCommand({
      id: "next-unclarified-quote",
      name: t("跳到下一处待澄清的引文"),
      editorCallback: withView((view) => gotoNextMixedQuote(view)),
    });
    this.addCommand({
      id: "paste-edits",
      name: t("粘贴修改（仅将改动处标记为模型所写）"),
      editorCallback: (editor) => {
        const view = cmOf(editor);
        if (view) this.pasteEdits(view);
      },
    });
    this.addCommand({
      id: "manage-authors",
      name: t("管理作者"),
      callback: () => this.openAuthors(),
    });
    this.addCommand({
      id: "create-book",
      name: t("新建署名簿"),
      callback: () => void this.createBookNote(),
    });
    this.addCommand({
      id: "paste-as-ai",
      name: t("粘贴为 AI 生成"),
      editorCallback: withView((view) => void this.pasteAsAIFromClipboard(view)),
    });
    const exports: Array<[ExportKind, string]> = [
      ["plain", t("导出为新笔记：移除标记")],
      ["pandoc", t("导出为新笔记：Pandoc 格式")],
      ["ia", t("导出为新笔记：iA 标注格式")],
      ["publish", t("导出为新笔记：Obsidian Publish 用（带样式类）")],
    ];
    for (const [kind, name] of exports) {
      this.addCommand({
        id: "export-" + kind,
        name,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) void this.readNote(file).then((text) => exportNote(this.app, file, text, kind, this.allAuthors(), this.settings.extraPrefixes, this.styleSnapshot));
          return true;
        },
      });
    }
    // Works in reading view too, which the editor commands do not.
    this.addCommand({
      id: "export-pdf",
      name: t("导出为 PDF…"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.openPdfExport(file);
        return true;
      },
    });
    this.addCommand({
      id: "write-publish-css",
      name: t("生成 Obsidian Publish 样式（publish.css）"),
      callback: () => void this.writePublishStyles(),
    });
    this.addCommand({
      id: "import-ia",
      name: t("从 iA 标注转换（当前笔记）"),
      editorCallback: (editor) => importIA(this.app, editor, this.authors),
    });
    this.addCommand({
      id: "toggle-mode",
      name: t("切换写作 / 审阅显示"),
      callback: async () => {
        this.settings.mode = this.settings.mode === "review" ? "writing" : "review";
        await this.saveSettings();
        new Notice(this.settings.mode === "review" ? t("审阅显示") : t("写作显示"));
      },
    });
    this.addCommand({
      id: "search-ignore-format",
      name: t("搜索（忽略格式）"),
      callback: () => {
        const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
        const selected = editor?.getSelection().split("\n")[0] ?? "";
        // Rakkan's window also stands in when Obsidian's search is turned off.
        if (!this.nativeSearch?.open(selected)) new VaultSearchModal(this.app, this.plainNotes, selected).open();
      },
    });
    this.addCommand({
      id: "find-in-note-ignore-format",
      name: t("在当前笔记中查找（忽略格式）"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (checking) return true;
        if (this.nativeSearch) void this.nativeSearch.find(view);
        else new NoteSearchModal(this.app, view).open();
        return true;
      },
    });
    this.addCommand({
      id: "show-diagnostics",
      name: t("查看提醒"),
      callback: () => {
        this.updateStatus();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        new DiagnosticsModal(this.app, this.lastResult?.diagnostics ?? [], view).open();
      },
    });
  }

  private markAs(view: EditorView, owner: "ai" | "human") {
    const skipped = markSelection(view, owner, this.settings.defaultSignature);
    if (skipped) new Notice(t("{n} 行含引用或代码，未作改动", { n: skipped }));
  }

  private clarifyQuote(view: EditorView) {
    clarifyAtCursor(this.app, view, {
      nameOf: (key) => this.allAuthors()[key]?.name,
      blockOpener: () => this.settings.defaultSignature,
    });
  }

  private async pasteAsAIFromClipboard(view: EditorView) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) pasteAsAI(view, text);
    } catch {
      new Notice(t("无法读取剪贴板"));
    }
  }

  private pasteAsQuote(editor: Editor) {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (!text.trim()) return;
        new AuthorPickerModal(this.app, { authors: () => Object.values(this.allAuthors()) }, (key) => {
          const quoted = quoteText(text, key);
          if (!quoted) return;
          // One line stays in the line; a cited blockquote is a paragraph of its own.
          const lead = quoted.startsWith(">") && editor.getCursor("from").ch !== 0 ? "\n\n" : "";
          const ins = quoted.startsWith(">") ? `${lead}${quoted}\n` : quoted;
          // The person gives the quote: in AI text it is written as confirmed, not as the model's citation.
          const doc = editor.getValue();
          const from = editor.posToOffset(editor.getCursor("from"));
          const to = editor.posToOffset(editor.getCursor("to"));
          const c = insertQuote(doc, from, to, ins, { blockOpener: this.settings.defaultSignature });
          editor.transaction({ changes: [{ from: editor.offsetToPos(c.from), to: editor.offsetToPos(c.to), text: c.insert }] });
          // `cursor` is an offset in the note as it is now.
          editor.setCursor(editor.offsetToPos(c.cursor));
        }).open();
      })
      .catch(() => new Notice(t("无法读取剪贴板")));
  }

  /** The note's text, with unsaved edits: they are in the editor, not on disk yet. */
  private async readNote(file: TFile): Promise<string> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path === file.path && view.getMode() === "source" ? view.editor.getValue() : await this.app.vault.read(file);
  }

  /** The PDF export dialog for `file`, from whatever view shows it. */
  openPdfExport(file: TFile) {
    const pdfDeps = () => ({ styles: () => this.styleSnapshot, colors: () => this.settings, nameOf: (key: string) => this.allAuthors()[key]?.name });
    const read = () => this.readNote(file);
    const run = async (o: PdfOptions) => {
      const css = await this.app.vault.adapter.read(normalizePath(`${this.manifest.dir}/styles.css`)).catch(() => "");
      await exportPdf(this.app, file, await read(), o, pdfDeps(), css);
    };
    new PdfModal(
      this.app,
      file,
      this.settings.pdf,
      (o) => {
        this.settings.pdf = o;
        void this.saveSettings();
      },
      run,
      async (o) => previewPdf(this.app, file, await read(), o, pdfDeps(), () => void run(o)),
    ).open();
  }

  /** Right-click menu: Rakkan ▸ the editing actions (a flat list where submenus are not available). */
  private buildMenu(menu: Menu, editor: Editor) {
    const view = cmOf(editor);
    if (!view) return;
    const entries: Array<{ title: string; icon: string; run: () => void }> = [];
    if (!view.state.selection.main.empty) {
      entries.push(
        { title: t("标记为 AI 生成"), icon: "bot", run: () => this.markAs(view, "ai") },
        { title: t("标记为原创"), icon: "user", run: () => this.markAs(view, "human") },
        { title: t("粘贴修改"), icon: "diff", run: () => this.pasteEdits(view) },
        { title: t("移除选区的标记"), icon: "eraser", run: () => stripSelection(view) },
      );
    }
    entries.push(
      { title: t("粘贴为 AI 生成"), icon: "clipboard-paste", run: () => void this.pasteAsAIFromClipboard(view) },
      { title: t("粘贴为引用"), icon: "quote", run: () => this.pasteAsQuote(editor) },
      { title: t("澄清引文"), icon: "message-square-quote", run: () => this.clarifyQuote(view) },
      { title: t("插入 AI 块"), icon: "square-plus", run: () => insertBlock(view, this.settings.defaultSignature) },
      { title: t("导出为 PDF…"), icon: "file-output", run: () => { const f = this.app.workspace.getActiveFile(); if (f) this.openPdfExport(f); } },
    );

    // setSubmenu exists in the app but not in the published typings.
    const hasSubmenu = typeof (MenuItem.prototype as unknown as { setSubmenu?: unknown }).setSubmenu === "function";
    if (!hasSubmenu) {
      menu.addSeparator();
      for (const e of entries) menu.addItem((i) => i.setTitle(`Rakkan · ${e.title}`).setIcon(e.icon).onClick(e.run));
      return;
    }
    menu.addItem((item) => {
      item.setTitle("Rakkan").setIcon("stamp").setSection("rakkan");
      const sub = (item as unknown as { setSubmenu(): Menu }).setSubmenu();
      for (const e of entries) sub.addItem((i) => i.setTitle(e.title).setIcon(e.icon).onClick(e.run));
    });
  }

  /**
   * The selection is the original text, the clipboard its edited version: only
   * the words that changed are attributed to the AI (and the model, if chosen).
   * The note is signed as `rakkan sign` signs an agent's revision.
   */
  private pasteEdits(view: EditorView) {
    const sel = view.state.selection.main;
    if (sel.empty) {
      new Notice(t("请先选中被修改的原文，再运行此命令"));
      return;
    }
    const { from, to } = sel;
    const r = view.state.field(parseField);
    const lineHit = (l: number | null) => l !== null && r.lines[l].from < to && r.lines[l].to > from;
    if (r.blocks.some((b) => lineHit(b.openLine) || lineHit(b.closeLine))) {
      new Notice(t("选区包含 AI 块的开合行，请仅选择正文"));
      return;
    }
    if (r.segments.some((s) => s.attr.kind === "quote" && s.from < to && s.to > from)) {
      new Notice(t("选区包含引用，粘贴修改会丢失出处，请避开引用"));
      return;
    }
    const original = view.state.sliceDoc(from, to);
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (!text.trim()) {
          new Notice(t("剪贴板为空"));
          return;
        }
        new AuthorPickerModal(
          this.app,
          { authors: () => Object.values(this.allAuthors()).filter((a) => a.kind === "ai") },
          (key) => {
            if (view.state.sliceDoc(from, to) !== original) {
              new Notice(t("选择作者期间原文已改动，请重试"));
              return;
            }
            const doc = view.state.doc.toString();
            const res = signRevision(doc, doc.slice(0, from) + trimPaste(original, text) + doc.slice(to), key || undefined);
            if (!res.changed) {
              new Notice(t("未发现改动"));
              return;
            }
            if (res.text !== doc) {
              const changes = ChangeSet.of(diffChanges(doc, res.text), doc.length);
              view.dispatch({ changes, selection: { anchor: changes.mapPos(to, 1) }, userEvent: "input.paste", scrollIntoView: true });
              new Notice(t("已标记 {n} 处改动", { n: res.changed }));
            }
            // What sign can't mark it doesn't take: those lines keep the original.
            if (res.rejected.length) new Notice(t("{n} 处改动含引用或代码，无法标记，已保留原文", { n: res.rejected.length }));
            if (res.foreign.length) new Notice(t("{n} 行的改动在其他模型署名的 AI 块里，算作该模型所写", { n: res.foreign.length }));
            if (res.tasks.length) new Notice(t("{n} 个任务的勾选状态被改动，勾选者不会记录", { n: res.tasks.length }));
          },
          t("不标注模型"),
        ).open();
      })
      .catch(() => new Notice(t("无法读取剪贴板")));
  }

  private currentResult(): ParseResult | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;
    const cm = cmOf(view.editor);
    const fromEditor = cm?.state.field(parseField, false);
    return fromEditor ?? this.fallbackParser.parse(view.getViewData());
  }

  updateStatus() {
    if (!this.statusEl) return;
    const r = this.settings.showStatusBar ? this.currentResult() : null;
    this.lastResult = r;
    const { text, title } = r ? statusText(r, this.allAuthors(r)) : { text: "", title: "" };
    this.statusEl.setText(text);
    this.statusEl.setAttribute("aria-label", title);
    this.statusEl.toggleClass("rk-status-warn", !!r?.diagnostics.length);
    this.statusEl.toggle(!!text);
  }

  /** The book, overlaid with the current note's own definitions. */
  private authorMap(r: ParseResult | null): Record<string, Author> {
    const out = { ...this.authors };
    for (const [key, raw] of Object.entries(r?.definitions ?? {})) out[key] = parseAuthor(key, raw, this.settings.extraPrefixes);
    return out;
  }

  allAuthors(r: ParseResult | null = this.currentResult()): Record<string, Author> {
    return this.authorMap(r);
  }

  async reloadBook() {
    this.authors = await loadBook(this.app, this.settings.bookPath, this.settings.extraPrefixes);
    this.applyAppearance();
  }

  /** Write an author's colour into its line of the book (the note stays the source of truth). */
  /** Rewrite the author book note and read it back; false when there is no book yet. */
  async editBook(change: (text: string) => string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(this.settings.bookPath);
    if (!(file instanceof TFile)) {
      new Notice(t("请先新建署名簿"));
      return false;
    }
    await this.app.vault.process(file, change);
    await this.reloadBook();
    this.refresh();
    return true;
  }

  async setAuthorColor(key: string, color: string | null) {
    await this.editBook((text) => setBookColor(text, key, color));
  }

  openAuthors() {
    new AuthorsModal(this.app, {
      authors: () => Object.values(this.authors),
      extraPrefixes: () => this.settings.extraPrefixes,
      editBook: (change) => this.editBook(change),
      setColor: (key, color) => this.setAuthorColor(key, color),
    }).open();
  }

  /** Open the book note, creating it first when it does not exist. */
  async openBookNote() {
    const file = this.app.vault.getAbstractFileByPath(this.settings.bookPath);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else await this.createBookNote();
  }

  /** Colours for a published site, written into publish.css at the vault root. */
  async writePublishStyles() {
    const css = await this.app.vault.adapter.read(normalizePath(`${this.manifest.dir}/styles.css`)).catch(() => "");
    await writePublishCss(this.app, publishCss(this.settings, this.allAuthors(), css));
  }

  async createBookNote() {
    const file = await createBook(this.app, this.settings.bookPath);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private anchorReading() {
    document.querySelectorAll<HTMLElement>(".markdown-preview-sizer").forEach((el) => {
      const r = el.getBoundingClientRect();
      el.setCssProps({ "--rk-x": `${r.left}px`, "--rk-w": `${r.width}px` });
    });
  }

  private applyAppearance() {
    this.styleSnapshot = { ...(JSON.parse(JSON.stringify(this.settings)) as Omit<StyleSettings, "authors">), authors: this.authors };
    this.applyColors();
    document.body.toggleClass("rk-mode-writing", this.settings.mode === "writing");
    document.body.toggleClass("rk-mode-review", this.settings.mode === "review");
  }

  /** Set the colour variables for the current theme on the body; Obsidian copies them into popout windows. */
  private applyColors() {
    const vars = colorVars(this.settings, document.body.hasClass("theme-dark"));
    const stale = this.colorKeys.filter((k) => !(k in vars));
    document.body.setCssProps({ ...vars, ...Object.fromEntries(stale.map((k) => [k, ""])) });
    this.colorKeys = Object.keys(vars);
  }

  /** Redraw editors and reading views after a settings change. */
  refresh() {
    this.applyAppearance();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      cmOf(leaf.view.editor)?.dispatch({ effects: refreshEffect.of(null) });
      leaf.view.previewMode?.rerender(true);
    });
    this.updateStatus();
  }

  override onunload() {
    document.body.removeClass("rk-mode-writing", "rk-mode-review");
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<RakkanSettings> | null) };
    setLanguage(this.settings.language, getLanguage());
    // Drop style names that no longer exist (the old background styles).
    const s = this.settings;
    const ok = (v: string) => (STYLES as readonly string[]).includes(v);
    if (!ok(s.aiStyle)) s.aiStyle = DEFAULT_SETTINGS.aiStyle;
    if (!ok(s.quoteStyle)) s.quoteStyle = DEFAULT_SETTINGS.quoteStyle;
    if (s.forceStyle && !ok(s.forceStyle)) s.forceStyle = "";
    for (const m of [s.familyStyle, s.modelStyle]) for (const k of Object.keys(m)) if (!ok(m[k])) delete m[k];
  }

  /** Load the search parts the settings ask for, unloading the others. */
  applySearch() {
    this.nativeSearch = this.keep(
      this.nativeSearch,
      this.settings.searchMode === "native",
      () =>
        new NativeSearch(
          this.app,
          () => this.settings.searchIgnoreFormat,
          async (on) => {
            this.settings.searchIgnoreFormat = on;
            await this.saveData(this.settings);
          },
        ),
    );
    this.omnisearchCompat = this.keep(this.omnisearchCompat, this.settings.omnisearchCompat, () => new OmnisearchCompat(this.app));
  }

  /** `child`, loaded when `want` (made by `make` if there is none yet); otherwise unloaded, and null. */
  private keep<T extends Component>(child: T | null, want: boolean, make: () => T): T | null {
    if (want) return child ?? this.addChild(make());
    if (child) this.removeChild(child);
    return null;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refresh();
  }
}
