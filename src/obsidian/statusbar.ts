import { App, MarkdownView, Modal, Notice } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { escapeMathDelimiters, type Author, type Diagnostic, type ParseResult } from "../core";
import { t } from "../i18n";

const pct = (n: number, total: number) => `${Math.round((n / total) * 100)}%`;

export function statusText(r: ParseResult, authors: Record<string, Author> = {}): { text: string; title: string } {
  const nameOf = (key: string) => (authors[key]?.name ?? (key ? "@" + key : ""));
  const { human, ai, quote, aiByAuthor, quoteByKey } = r.stats;
  const total = human + ai + quote;
  if (!total) return { text: "", title: "" };
  const parts = [t("原创 {x}", { x: pct(human, total) }), t("AI {x}", { x: pct(ai, total) })];
  if (quote) parts.push(t("引用 {x}", { x: pct(quote, total) }));
  if (r.diagnostics.length) parts.push(`⚠ ${r.diagnostics.length}`);
  const lines = [t("原创 {n} 字", { n: human })];
  for (const [who, n] of Object.entries(aiByAuthor).sort((a, b) => b[1] - a[1]))
    lines.push(t("{name} {n} 字", { name: who.startsWith("@") ? nameOf(who.slice(1)) : who, n }));
  for (const [key, n] of Object.entries(quoteByKey).sort((a, b) => b[1] - a[1]))
    lines.push(t("引用 {name} {n} 字", { name: nameOf(key), n }));
  if (r.diagnostics.length) lines.push(t("{n} 处提醒（点击查看）", { n: r.diagnostics.length }));
  return { text: parts.join(" · "), title: lines.join("\n") };
}

export class DiagnosticsModal extends Modal {
  constructor(
    app: App,
    private items: Diagnostic[],
    private view: MarkdownView | null,
  ) {
    super(app);
  }

  override onOpen() {
    const { contentEl } = this;
    this.setTitle(t("落款提醒"));
    if (!this.items.length) {
      contentEl.createEl("p", { text: t("没有提醒。") });
      return;
    }
    const list = contentEl.createEl("ul", { cls: "rk-diagnostics" });
    for (const d of this.items) {
      const li = list.createEl("li");
      const link = li.createEl("a", { text: t("第 {n} 行", { n: d.line + 1 }), href: "#" });
      li.appendText(t("：") + t(d.message));
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const editor = this.view?.editor;
        if (!editor) {
          new Notice(t("仅在编辑模式下可跳转"));
          return;
        }
        editor.setCursor({ line: d.line, ch: 0 });
        editor.scrollIntoView({ from: { line: d.line, ch: 0 }, to: { line: d.line, ch: 0 } }, true);
        this.close();
      });
      if (d.code === "math-swallow") {
        const fix = li.createEl("button", { text: t("改成 \\$"), cls: "rk-fix" });
        fix.addEventListener("click", () => {
          const cm = (this.view?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
          if (!cm) {
            new Notice(t("仅在编辑模式下可修复"));
            return;
          }
          const changes = escapeMathDelimiters(cm.state.doc.toString(), d);
          if (changes.length) cm.dispatch({ changes, userEvent: "input.rakkan" });
          this.close();
        });
      }
    }
  }

  override onClose() {
    this.contentEl.empty();
  }
}
