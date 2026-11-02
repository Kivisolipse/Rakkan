// The author book as a form: search, add, rename, colour and delete without
// opening the note. Every change is written into the book's lines, so the note
// stays the source of truth.

import { Modal, Notice, setIcon, setTooltip, type App } from "obsidian";
import { addBookAuthor, hueHex, keyFromName, removeBookAuthor, signatureFamily, updateBookAuthor } from "../core";
import type { Author, AuthorKind, ExtraPrefix, KindWords } from "../core";
import { DEFAULT_COLORS } from "../cm6/colors";
import { kindLabel } from "./authors";
import { t } from "../i18n";

const KIND_ICON = { human: "user", ai: "bot", source: "book-open" } as const;
const KINDS: AuthorKind[] = ["human", "ai", "source"];
const KEY_OK = /^[^\s:[\]@]+$/;

export interface AuthorsHost {
  /** The authors of the book, as last read. */
  authors(): Author[];
  extraPrefixes(): ExtraPrefix[];
  /** Rewrite the book note; resolves when the new text is saved and read back. */
  editBook(change: (text: string) => string): Promise<boolean>;
  setColor(key: string, color: string | null): Promise<void>;
}

/** The colour an author shows when the book gives none. */
function automaticColor(a: Author, extra: ExtraPrefix[]): string {
  if (a.kind === "human") return hueHex(a.key);
  if (a.kind === "source") return DEFAULT_COLORS.quote.light;
  const fam = signatureFamily({ raw: "", ...(a.name ? { name: a.name } : {}), ...(a.id ? { id: a.id } : {}) }, extra);
  return (DEFAULT_COLORS[fam?.id ?? "generic"] ?? DEFAULT_COLORS.generic).light;
}

const words = (): KindWords => ({ human: kindLabel("human"), ai: kindLabel("ai"), source: kindLabel("source") });

export class AuthorsModal extends Modal {
  private query = "";
  private list!: HTMLElement;

  constructor(
    app: App,
    private host: AuthorsHost,
  ) {
    super(app);
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("rk-authors-modal");
    this.setTitle(t("作者"));

    this.addForm(contentEl);

    const search = contentEl.createEl("input", { type: "search", cls: "rk-authors-search", attr: { placeholder: t("搜索作者") } });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });
    this.list = contentEl.createDiv({ cls: "rk-authors-list" });
    this.renderList();
  }

  private addForm(parent: HTMLElement) {
    const form = parent.createDiv({ cls: "rk-authors-add" });
    const name = form.createEl("input", { type: "text", attr: { placeholder: t("名字") } });
    const key = form.createEl("input", { type: "text", attr: { placeholder: t("key（可选）") } });
    const kind = form.createEl("select");
    for (const k of KINDS) kind.createEl("option", { value: k, text: kindLabel(k) });
    const add = form.createEl("button", { text: t("添加"), cls: "mod-cta" });

    const submit = async () => {
      const label = name.value.trim();
      if (!label) {
        new Notice(t("请先填写名字"));
        return;
      }
      let k = key.value.trim().replace(/^@/, "") || keyFromName(label);
      if (!KEY_OK.test(k)) {
        new Notice(t("名字无法生成 key，请手动填写 key"));
        return;
      }
      const taken = new Set(this.host.authors().map((a) => a.key));
      if (taken.has(k)) {
        // Offer the next free key with a number after it, or let the user change the key.
        let n = 2;
        while (taken.has(`${k}-${n}`)) n++;
        const suggestion = `${k}-${n}`;
        if (!(await new KeyTakenModal(this.app, k, suggestion).ask())) {
          key.focus();
          return;
        }
        k = suggestion;
      }
      const ok = await this.host.editBook((text) => addBookAuthor(text, { key: k, name: label, kind: kind.value as AuthorKind }, words()));
      if (!ok) return;
      name.value = "";
      key.value = "";
      this.renderList();
    };
    add.addEventListener("click", () => void submit());
    for (const el of [name, key]) el.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && void submit());
  }

  private renderList() {
    const q = this.query.trim().toLowerCase();
    this.list.empty();
    const shown = this.host.authors().filter((a) => !q || a.key.toLowerCase().includes(q) || (a.name ?? "").toLowerCase().includes(q));
    if (!shown.length) this.list.createDiv({ cls: "rk-authors-empty", text: t("没有匹配的作者") });
    for (const a of shown) this.renderRow(a);
  }

  private renderRow(a: Author) {
    const row = this.list.createDiv({ cls: "rk-authors-row" });
    const icon = row.createSpan({ cls: "rk-kind" });
    setIcon(icon, KIND_ICON[a.kind]);
    setTooltip(icon, kindLabel(a.kind));

    const name = row.createEl("input", { type: "text", cls: "rk-authors-name", value: a.name ?? "" });
    name.placeholder = `@${a.key}`;
    name.addEventListener("change", () => {
      void this.host.editBook((text) => updateBookAuthor(text, a.key, { name: name.value }, words()));
    });
    row.createEl("small", { cls: "rk-authors-key", text: `@${a.key}` });

    const color = row.createEl("input", { type: "color", value: a.color ?? automaticColor(a, this.host.extraPrefixes()) });
    let timer: number | undefined;
    color.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.host.setColor(a.key, color.value), 400);
    });
    const reset = row.createEl("button", { cls: "clickable-icon" });
    setIcon(reset, "rotate-ccw");
    setTooltip(reset, t("恢复自动颜色"));
    reset.addEventListener("click", () => void this.host.setColor(a.key, null).then(() => this.renderList()));

    // Deleting asks twice: the first click arms the button.
    const del = row.createEl("button", { cls: "clickable-icon" });
    setIcon(del, "trash-2");
    setTooltip(del, t("删除"));
    let armed: number | undefined;
    del.addEventListener("click", () => {
      if (armed === undefined) {
        del.addClass("mod-warning");
        setTooltip(del, t("再次点击以删除"));
        armed = window.setTimeout(() => {
          armed = undefined;
          del.removeClass("mod-warning");
          setTooltip(del, t("删除"));
        }, 3000);
        return;
      }
      window.clearTimeout(armed);
      void this.host.editBook((text) => removeBookAuthor(text, a.key)).then((ok) => ok && this.renderList());
    });
  }
}

/** The key is already in the book: change it, or take the next free one with a number after it. */
class KeyTakenModal extends Modal {
  private choice = false;
  private done!: (suffix: boolean) => void;

  constructor(
    app: App,
    private key: string,
    private suggestion: string,
  ) {
    super(app);
  }

  /** Resolves true to use the suggestion, false to go back and change the key. */
  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.done = resolve;
      this.open();
    });
  }

  override onOpen() {
    this.setTitle(t("key「{key}」已存在", { key: this.key }));
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    const change = row.createEl("button", { text: t("修改 key（暂不添加）") });
    const suffix = row.createEl("button", { text: t("使用 {key}", { key: this.suggestion }), cls: "mod-cta" });
    change.addEventListener("click", () => this.close());
    suffix.addEventListener("click", () => {
      this.choice = true;
      this.close();
    });
    suffix.focus();
  }

  override onClose() {
    this.contentEl.empty();
    this.done(this.choice);
  }
}
