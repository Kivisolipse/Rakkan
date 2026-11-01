import { editorLivePreviewField, MarkdownView, Notice, Plugin, type Editor } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { Parser, parseAuthor, quoteText, type Author, type ParseResult } from "./core";
import { parseField, rakkanEditor, refreshEffect } from "./cm6/editor";
import { STYLES, type StyleSettings } from "./cm6/resolve";
import { processSection } from "./obsidian/reading";
import { DEFAULT_SETTINGS, RakkanSettingTab, type RakkanSettings } from "./obsidian/settings";
import { colorCss } from "./cm6/colors";
import { DiagnosticsModal, statusText } from "./obsidian/statusbar";
import { LooseSearchModal } from "./obsidian/search";
import { AuthorPickerModal, AuthorSuggest, createBook, loadBook } from "./obsidian/authors";
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

    this.registerMarkdownPostProcessor((el, ctx) => processSection(el, ctx, { styles: () => this.styleSnapshot }), 100);

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
    this.app.workspace.onLayoutReady(refreshStatus);

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
  }

  private addCommands() {
    const withView = (fn: (view: EditorView) => void) => (editor: Editor) => {
      const view = cmOf(editor);
      if (view) fn(view);
    };

    this.addCommand({
      id: "mark-ai",
      name: "标为代笔",
      editorCallback: withView((view) => {
        const skipped = markSelection(view, "ai", this.settings.defaultSignature);
        if (skipped) new Notice(`有 ${skipped} 行含引文或代码，没有改动`);
      }),
    });
    this.addCommand({
      id: "mark-human",
      name: "标为亲笔",
      editorCallback: withView((view) => {
        const skipped = markSelection(view, "human", this.settings.defaultSignature);
        if (skipped) new Notice(`有 ${skipped} 行含引文或代码，没有改动`);
      }),
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
      editorCallback: (editor) => {
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
      editorCallback: withView(async (view) => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) pasteAsAI(view, text);
        } catch {
          new Notice("读不到剪贴板");
        }
      }),
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

  async createBookNote() {
    const file = await createBook(this.app, this.settings.bookPath);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private applyAppearance() {
    this.styleSnapshot = { ...(JSON.parse(JSON.stringify(this.settings)) as Omit<StyleSettings, "authors">), authors: this.authors };
    if (this.styleEl) this.styleEl.textContent = colorCss(this.settings);
    document.body.toggleClass("rk-mode-writing", this.settings.mode === "writing");
    document.body.toggleClass("rk-mode-review", this.settings.mode === "review");
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
