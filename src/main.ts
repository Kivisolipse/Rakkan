import { editorLivePreviewField, MarkdownView, MenuItem, Notice, Plugin, TFile, type Editor, type Menu } from "obsidian";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Parser, parseAuthor, pasteEdits, quoteText, setBookColor, type Author, type ParseResult } from "./core";
import { parseField, pasteWithOwners, rakkanEditor, rangePayload, refreshEffect } from "./cm6/editor";
import { STYLES, type StyleSettings } from "./cm6/resolve";
import { processSection } from "./obsidian/reading";
import { DEFAULT_SETTINGS, RakkanSettingTab, type RakkanSettings } from "./obsidian/settings";
import { colorCss } from "./cm6/colors";
import { DiagnosticsModal, statusText } from "./obsidian/statusbar";
import { LooseSearchModal } from "./obsidian/search";
import { AuthorPickerModal, AuthorSuggest, createBook, loadBook } from "./obsidian/authors";
import { exportNote, importIA, type ExportKind } from "./obsidian/export";
import { fixBlankLines, insertBlock, markSelection, pasteAsAI, stripSelection } from "./obsidian/commands";

const cmOf = (editor: Editor) => (editor as unknown as { cm?: EditorView }).cm ?? null;

export default class RakkanPlugin extends Plugin {
  settings: RakkanSettings = { ...DEFAULT_SETTINGS };
  /** Immutable snapshot handed to renderers; replaced on every settings change. */
  private styleSnapshot: StyleSettings = { ...DEFAULT_SETTINGS, authors: {} };
  /** The author book. */
  authors: Record<string, Author> = {};
  private styleEl: HTMLStyleElement | null = null;
  private statusEl: HTMLElement | null = null;
  private lastResult: ParseResult | null = null;
  private fallbackParser = new Parser();

  override async onload() {
    await this.loadSettings();
    await this.reloadBook();

    this.styleEl = document.head.createEl("style", { attr: { id: "rakkan-colors" } });
    this.register(() => this.styleEl?.remove());
    this.applyAppearance();

    this.registerEditorExtension(
      rakkanEditor({
        styles: () => this.styleSnapshot,
        hideMarkers: (state) => this.settings.hideMarkers && (state.field(editorLivePreviewField, false) ?? false),
        stripOnCopy: () => this.settings.stripOnCopy,
        autoAnnotate: () => this.settings.autoAnnotate,
      }),
    );

    // Colours that follow the horizontal position need to know where the reading column is.
    let anchorFrame = 0;
    const anchorSoon = () => {
      window.cancelAnimationFrame(anchorFrame);
      anchorFrame = window.requestAnimationFrame(() => this.anchorReading());
    };
    this.registerMarkdownPostProcessor((el, ctx) => {
      processSection(el, ctx, { styles: () => this.styleSnapshot });
      anchorSoon();
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
  }

  private addCommands() {
    const withView = (fn: (view: EditorView) => void) => (editor: Editor) => {
      const view = cmOf(editor);
      if (view) fn(view);
    };

    this.addCommand({
      id: "mark-ai",
      name: "标为代笔",
      editorCallback: withView((view) => this.markAs(view, "ai")),
    });
    this.addCommand({
      id: "mark-human",
      name: "标为亲笔",
      editorCallback: withView((view) => this.markAs(view, "human")),
    });
    this.addCommand({
      id: "strip-markers",
      name: "去掉标记（选区或整篇）",
      editorCallback: withView((view) => stripSelection(view)),
    });
    this.addCommand({
      id: "insert-block",
      name: "插入 AI 块",
      editorCallback: withView((view) => insertBlock(view, this.settings.defaultSignature)),
    });
    this.addCommand({
      id: "fix-blank-lines",
      name: "给块的开合行补空行",
      editorCallback: withView((view) => {
        const n = fixBlankLines(view);
        new Notice(n ? `补了 ${n} 个空行` : "开合行前后都已经空行了");
      }),
    });
    this.addCommand({
      id: "paste-as-quote",
      name: "粘贴为引文",
      editorCallback: (editor) => this.pasteAsQuote(editor),
    });
    this.addCommand({
      id: "paste-edits",
      name: "粘贴修改（只把改动的地方标给模型）",
      editorCallback: (editor) => {
        const view = cmOf(editor);
        if (view) this.pasteEdits(view);
      },
    });
    this.addCommand({
      id: "create-book",
      name: "新建署名簿",
      callback: () => void this.createBookNote(),
    });
    this.addCommand({
      id: "paste-as-ai",
      name: "粘贴为代笔",
      editorCallback: withView((view) => void this.pasteAsAIFromClipboard(view)),
    });
    const exports: Array<[ExportKind, string]> = [
      ["plain", "导出为新笔记：去掉标记"],
      ["pandoc", "导出为新笔记：Pandoc 格式"],
      ["ia", "导出为新笔记：iA 标注格式"],
    ];
    for (const [kind, name] of exports) {
      this.addCommand({
        id: "export-" + kind,
        name,
        editorCallback: (editor, ctx) => {
          if (ctx.file) void exportNote(this.app, ctx.file, editor.getValue(), kind, this.allAuthors(), this.settings.extraPrefixes);
        },
      });
    }
    this.addCommand({
      id: "import-ia",
      name: "从 iA 标注转换（当前笔记）",
      editorCallback: (editor) => importIA(editor),
    });
    this.addCommand({
      id: "toggle-pdf-colors",
      name: "切换导出 PDF 的颜色（带颜色 / 纯文字）",
      callback: async () => {
        this.settings.pdfColors = this.settings.pdfColors === "plain" ? "color" : "plain";
        await this.saveSettings();
        new Notice(this.settings.pdfColors === "plain" ? "导出 PDF：纯文字" : "导出 PDF：带颜色");
      },
    });
    this.addCommand({
      id: "toggle-mode",
      name: "切换写作 / 审阅显示",
      callback: async () => {
        this.settings.mode = this.settings.mode === "review" ? "writing" : "review";
        await this.saveSettings();
        new Notice(this.settings.mode === "review" ? "审阅显示" : "写作显示");
      },
    });
    this.addCommand({
      id: "search-ignore-format",
      name: "搜索（忽略格式）",
      callback: () => {
        const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
        const selected = editor?.getSelection().split("\n")[0] ?? "";
        new LooseSearchModal(this.app, selected, this.settings.searchIgnoreFormat).open();
      },
    });
    this.addCommand({
      id: "show-diagnostics",
      name: "查看提醒",
      callback: () => {
        this.updateStatus();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        new DiagnosticsModal(this.app, this.lastResult?.diagnostics ?? [], view).open();
      },
    });
  }

  private markAs(view: EditorView, owner: "ai" | "human") {
    const skipped = markSelection(view, owner, this.settings.defaultSignature);
    if (skipped) new Notice(`有 ${skipped} 行含引文或代码，没有改动`);
  }

  private async pasteAsAIFromClipboard(view: EditorView) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) pasteAsAI(view, text);
    } catch {
      new Notice("读不到剪贴板");
    }
  }

  private pasteAsQuote(editor: Editor) {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (!text.trim()) return;
        new AuthorPickerModal(this.app, { authors: () => Object.values(this.allAuthors()) }, (key) => {
          const quoted = quoteText(text, key);
          const multi = quoted.startsWith("> ");
          const atStart = editor.getCursor().ch === 0;
          const lead = atStart ? "" : "\n\n";
          editor.replaceSelection(multi ? `${lead}${quoted}\n` : quoted);
        }).open();
      })
      .catch(() => new Notice("读不到剪贴板"));
  }

  /** Right-click menu: Rakkan ▸ the editing actions (a flat list where submenus are not available). */
  private buildMenu(menu: Menu, editor: Editor) {
    const view = cmOf(editor);
    if (!view) return;
    const entries: Array<{ title: string; icon: string; run: () => void }> = [];
    if (!view.state.selection.main.empty) {
      entries.push(
        { title: "标为代笔", icon: "bot", run: () => this.markAs(view, "ai") },
        { title: "标为亲笔", icon: "user", run: () => this.markAs(view, "human") },
        { title: "粘贴修改", icon: "diff", run: () => this.pasteEdits(view) },
        { title: "去掉选区的标记", icon: "eraser", run: () => stripSelection(view) },
      );
    }
    entries.push(
      { title: "粘贴为代笔", icon: "clipboard-paste", run: () => void this.pasteAsAIFromClipboard(view) },
      { title: "粘贴为引文", icon: "quote", run: () => this.pasteAsQuote(editor) },
      { title: "插入 AI 块", icon: "square-plus", run: () => insertBlock(view, this.settings.defaultSignature) },
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
   */
  private pasteEdits(view: EditorView) {
    const sel = view.state.selection.main;
    if (sel.empty) {
      new Notice("先选中被改的那段原文，再用这个命令");
      return;
    }
    const { from, to } = sel;
    const r = view.state.field(parseField);
    const lineHit = (l: number | null) => l !== null && r.lines[l].from < to && r.lines[l].to > from;
    if (r.blocks.some((b) => lineHit(b.openLine) || lineHit(b.closeLine))) {
      new Notice("选区里有 AI 块的开头或结尾行，请只选正文");
      return;
    }
    if (r.segments.some((s) => s.attr.kind === "quote" && s.from < to && s.to > from)) {
      new Notice("选区里有引文，粘贴修改会弄丢出处，请避开引文");
      return;
    }
    const original = view.state.sliceDoc(from, to);
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (!text.trim()) {
          new Notice("剪贴板是空的");
          return;
        }
        new AuthorPickerModal(
          this.app,
          { authors: () => Object.values(this.allAuthors()).filter((a) => a.kind === "ai") },
          (key) => {
            if (view.state.sliceDoc(from, to) !== original) {
              new Notice("原文在选作者的时候变了，请重新来一次");
              return;
            }
            const now = rangePayload(view.state.field(parseField), from, to);
            const res = pasteEdits(now.plain, now.owners, text);
            if (!res.changed) {
              new Notice("没有发现改动");
              return;
            }
            view.dispatch({ selection: EditorSelection.range(from, to) });
            pasteWithOwners(view, { plain: res.plain, owners: res.owners, ...(key ? { key } : {}) });
            new Notice(`标了 ${res.changed} 处改动`);
          },
          "不注明模型",
        ).open();
      })
      .catch(() => new Notice("读不到剪贴板"));
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
  async setAuthorColor(key: string, color: string | null) {
    const file = this.app.vault.getAbstractFileByPath(this.settings.bookPath);
    if (!(file instanceof TFile)) {
      new Notice("先新建署名簿");
      return;
    }
    await this.app.vault.process(file, (text) => setBookColor(text, key, color));
  }

  async createBookNote() {
    const file = await createBook(this.app, this.settings.bookPath);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private anchorReading() {
    document.querySelectorAll<HTMLElement>(".markdown-preview-sizer").forEach((el) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--rk-x", `${r.left}px`);
      el.style.setProperty("--rk-w", `${r.width}px`);
    });
  }

  private applyAppearance() {
    this.styleSnapshot = { ...(JSON.parse(JSON.stringify(this.settings)) as Omit<StyleSettings, "authors">), authors: this.authors };
    if (this.styleEl) this.styleEl.textContent = colorCss(this.settings);
    document.body.toggleClass("rk-mode-writing", this.settings.mode === "writing");
    document.body.toggleClass("rk-mode-review", this.settings.mode === "review");
    document.body.toggleClass("rk-pdf-plain", this.settings.pdfColors === "plain");
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
    document.body.removeClass("rk-mode-writing", "rk-mode-review", "rk-pdf-plain");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Drop style names that no longer exist (the old background styles).
    const s = this.settings;
    const ok = (v: string) => (STYLES as readonly string[]).includes(v);
    if (!ok(s.aiStyle)) s.aiStyle = DEFAULT_SETTINGS.aiStyle;
    if (!ok(s.quoteStyle)) s.quoteStyle = DEFAULT_SETTINGS.quoteStyle;
    if (s.forceStyle && !ok(s.forceStyle)) s.forceStyle = "";
    for (const m of [s.familyStyle, s.modelStyle]) for (const k of Object.keys(m)) if (!ok(m[k])) delete m[k];
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refresh();
  }
}
