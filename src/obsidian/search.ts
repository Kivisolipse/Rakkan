// Search that sees through markers, as a toggle in Obsidian's own search boxes:
// the search pane (left of "Match case") and a note's find bar in editing view
// (Ctrl+F). Reading view's find bar searches the rendered text, which the
// reading view keeps free of markers. The box keeps what the user typed; only
// the query Obsidian runs changes.
//
// Obsidian has no API for either box, so these are prototype patches through
// monkey-around (as other plugins that extend search do), kept to the fewest
// internals: the pane's startSearch and searchComponent, and the editor's
// searchCursor, whose only caller is the find bar. A patch whose target is
// missing is skipped, and its toggle is not shown.

import { around } from "monkey-around";
import { Component, MarkdownView, setIcon, setTooltip, type App, type Editor, type EditorPosition, type WorkspaceLeaf } from "obsidian";
import { looseQuery, looseRegex } from "../core";
import { t } from "../i18n";

interface SearchPane {
  containerEl: HTMLElement;
  searchComponent: { getValue(): string };
  startSearch(): void;
  onOpen(): Promise<void>;
}

const isSearchPane = (v: unknown): v is SearchPane =>
  typeof (v as Partial<SearchPane> | null)?.startSearch === "function" &&
  typeof (v as Partial<SearchPane>).searchComponent?.getValue === "function";

const FIND_INPUT = ".markdown-source-view .document-search-input input";
const FIND_BUTTONS = ".markdown-source-view .document-search-buttons";

interface Range {
  from: EditorPosition;
  to: EditorPosition;
}

/**
 * The find bar's cursor, matching across markers. Same shape and behaviour as
 * the editor's own (case-insensitive, from the selection on, wrapping round):
 * the find bar calls these methods and nothing else.
 */
function looseCursor(editor: Editor, query: string) {
  const re = looseRegex(query);
  const matches = () => Array.from(editor.getValue().matchAll(re), (m) => ({ from: m.index, to: m.index + m[0].length }));
  const pos = (m: { from: number; to: number }): Range => ({ from: editor.offsetToPos(m.from), to: editor.offsetToPos(m.to) });
  let from = editor.posToOffset(editor.getCursor("from"));
  let to = editor.posToOffset(editor.getCursor("to"));
  let current: Range | null = null;
  const pick = (m?: { from: number; to: number }) => {
    if (!m) return (current = null);
    ({ from, to } = m);
    return (current = pos(m));
  };
  return {
    getIndexAndCount(): [number, number] {
      if (!current) return [0, 0];
      const all = matches();
      const at = editor.posToOffset(current.from);
      return [all.filter((m) => m.from <= at).length, all.length];
    },
    current: () => current,
    findNext() {
      const all = matches();
      return pick(all.find((m) => m.from >= to) ?? all[0]);
    },
    findPrevious() {
      const all = matches();
      return pick(all.filter((m) => m.to <= from).pop() ?? all[all.length - 1]);
    },
    findAll: () => matches().map(pos),
    replace(text: string, origin?: string) {
      if (current) editor.replaceRange(text, current.from, current.to, origin);
    },
    replaceAll(text: string, origin?: string) {
      editor.transaction({ changes: matches().map((m) => ({ ...pos(m), text })) }, origin);
    },
  };
}

export class NativeSearch extends Component {
  private live = false;
  private paneHooked = false;
  private editorHooked: boolean | null = null;

  constructor(
    private app: App,
    private enabled: () => boolean,
    private setEnabled: (on: boolean) => Promise<void>,
  ) {
    super();
  }

  override onload() {
    this.live = true;
    const hookEditor = (editor: Editor) => this.hookEditor(editor);
    const addFindToggle = (view: MarkdownView) => this.addFindToggle(view);
    // Every way of opening the find bar (Ctrl+F, Ctrl+H, the "Find" menu) goes
    // through showSearch. The bar searches the selection as it opens, so the
    // editor is patched first.
    this.register(
      around(MarkdownView.prototype, {
        showSearch(next) {
          return function (this: MarkdownView, replace?: boolean) {
            const hooked = this.getMode() === "source" && hookEditor(this.editor);
            next.call(this, replace);
            if (hooked) addFindToggle(this);
          };
        },
      }),
    );
    this.register(() => this.forEachLeaf((leaf) => leaf.view.containerEl.querySelectorAll(".rk-loose-toggle").forEach((el) => el.remove())));
    this.app.workspace.onLayoutReady(() => void this.attach());
    this.registerEvent(this.app.workspace.on("layout-change", () => void this.attach()));
  }

  override onunload() {
    this.live = false;
  }

  /** Patch the search pane once there is one, and reopen the panes built before the patch. */
  private async attach() {
    if (this.paneHooked || !this.live) return;
    const leaves = this.app.workspace.getLeavesOfType("search");
    if (!leaves.length) return;
    this.paneHooked = true;
    // A sidebar tab not yet shown holds a placeholder; build one pane to reach the class.
    await leaves[0].loadIfDeferred();
    const pane = leaves[0].view;
    if (!this.live) return;
    if (!isSearchPane(pane)) return;
    const addPaneToggle = (p: SearchPane) => this.addPaneToggle(p);
    const enabled = () => this.enabled();
    this.register(
      around(Object.getPrototypeOf(pane) as SearchPane, {
        onOpen(next) {
          return async function (this: SearchPane) {
            await next.call(this);
            addPaneToggle(this);
          };
        },
        startSearch(next) {
          return function (this: SearchPane) {
            const typed = this.searchComponent.getValue();
            if (!enabled() || !typed.trim()) return next.call(this);
            // The pane reads its box here. Only this read sees the rewritten
            // query; saving the layout and recent searches still see what was
            // typed. "Match case" still applies: it sets the regexes' flags.
            const query = looseQuery(typed);
            const restore = around(this.searchComponent, { getValue: () => () => query });
            try {
              next.call(this);
            } finally {
              restore();
            }
          };
        },
      }),
    );
    // A pane binds startSearch for typing when it is built, so rebuild the ones
    // already built; placeholders are built later, with the patch.
    for (const leaf of leaves) if (!leaf.isDeferred) void this.reopen(leaf);
  }

  /** Open the search pane on `query`, with markers ignored. False when Obsidian's search is turned off. */
  open(query: string): boolean {
    const search = (this.app as unknown as {
      internalPlugins?: { getEnabledPluginById?(id: string): { openGlobalSearch?(q: string): void } | null };
    }).internalPlugins?.getEnabledPluginById?.("global-search");
    if (typeof search?.openGlobalSearch !== "function") return false;
    void this.enable().then(() => {
      search.openGlobalSearch!(query);
      return this.attach();
    });
    return true;
  }

  /** Open the note's find bar, with markers ignored. */
  async find(view: MarkdownView) {
    await this.enable();
    view.showSearch(false);
  }

  private async enable() {
    if (!this.enabled()) await this.toggle();
  }

  private async toggle() {
    await this.setEnabled(!this.enabled());
    this.sync();
  }

  private async reopen(leaf: WorkspaceLeaf) {
    const state = leaf.getViewState();
    await leaf.setViewState({ type: "empty" });
    await leaf.setViewState(state);
  }

  private forEachLeaf(cb: (leaf: WorkspaceLeaf) => void) {
    this.app.workspace.iterateAllLeaves(cb);
  }

  /** Show the toggle's state everywhere and run the open searches again. */
  private sync() {
    this.forEachLeaf((leaf) => {
      const el = leaf.view.containerEl;
      el.querySelectorAll(".rk-loose-toggle").forEach((b) => b.toggleClass("is-active", this.enabled()));
      if (isSearchPane(leaf.view)) {
        if (leaf.view.searchComponent.getValue().trim()) leaf.view.startSearch();
        return;
      }
      const input = el.querySelector<HTMLInputElement>(FIND_INPUT);
      if (input?.isConnected && input.value) input.dispatchEvent(new Event("input"));
    });
  }

  private addToggle(el: HTMLElement) {
    el.addClass("rk-loose-toggle");
    setIcon(el, "remove-formatting");
    setTooltip(el, t("忽略格式"));
    el.toggleClass("is-active", this.enabled());
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      void this.toggle();
    });
  }

  private addPaneToggle(pane: SearchPane) {
    const box = pane.containerEl.querySelector<HTMLElement>(".global-search-input-container");
    if (box && !box.querySelector(".rk-loose-toggle")) this.addToggle(box.createDiv("input-right-decorator clickable-icon"));
  }

  private addFindToggle(view: MarkdownView) {
    const buttons = view.containerEl.querySelector<HTMLElement>(FIND_BUTTONS);
    if (!buttons || buttons.querySelector(".rk-loose-toggle")) return;
    const button = createEl("button", { cls: "clickable-icon document-search-button" });
    buttons.prepend(button);
    this.addToggle(button);
  }

  /** Swap the find bar's cursor while the toggle is on. Returns whether the editor could be patched. */
  private hookEditor(editor: Editor): boolean {
    if (this.editorHooked !== null) return this.editorHooked;
    let proto: object | null = Object.getPrototypeOf(editor) as object | null;
    while (proto && !Object.prototype.hasOwnProperty.call(proto, "searchCursor")) proto = Object.getPrototypeOf(proto) as object | null;
    this.editorHooked = !!proto;
    if (!proto) return false;
    const enabled = this.enabled;
    this.register(
      around(proto as { searchCursor(query: string): unknown }, {
        searchCursor(next) {
          return function (this: Editor, query: string) {
            return enabled() && query.trim() ? looseCursor(this, query) : next.call(this, query);
          };
        },
      }),
    );
    return true;
  }
}
