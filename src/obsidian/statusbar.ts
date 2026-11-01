import { App, MarkdownView, Modal, Notice } from "obsidian";
import type { Author, Diagnostic, ParseResult } from "../core";

const pct = (n: number, total: number) => `${Math.round((n / total) * 100)}%`;

export function statusText(r: ParseResult, authors: Record<string, Author> = {}): { text: string; title: string } {
  const nameOf = (key: string) => (authors[key]?.name ?? (key ? "@" + key : ""));
  const { human, ai, quote, aiByAuthor, quoteByKey } = r.stats;
  const total = human + ai + quote;
  if (!total) return { text: "", title: "" };
  const parts = [`亲笔 ${pct(human, total)}`, `代笔 ${pct(ai, total)}`];
  if (quote) parts.push(`引文 ${pct(quote, total)}`);
  if (r.diagnostics.length) parts.push(`⚠ ${r.diagnostics.length}`);
  const lines = [`亲笔 ${human} 字`];
  for (const [who, n] of Object.entries(aiByAuthor).sort((a, b) => b[1] - a[1]))
    lines.push(`${who.startsWith("@") ? nameOf(who.slice(1)) : who} ${n} 字`);
  for (const [key, n] of Object.entries(quoteByKey).sort((a, b) => b[1] - a[1]))
    lines.push(`引文 ${nameOf(key)} ${n} 字`);
  if (r.diagnostics.length) lines.push(`${r.diagnostics.length} 处提醒，点击查看`);
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
    this.setTitle("落款提醒");
    if (!this.items.length) {
      contentEl.createEl("p", { text: "没有需要提醒的地方。" });
      return;
    }
    const list = contentEl.createEl("ul", { cls: "rk-diagnostics" });
    for (const d of this.items) {
      const li = list.createEl("li");
      const link = li.createEl("a", { text: `第 ${d.line + 1} 行`, href: "#" });
      li.appendText(`：${d.message}`);
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const editor = this.view?.editor;
        if (!editor) {
          new Notice("在编辑模式下才能跳转");
          return;
        }
        editor.setCursor({ line: d.line, ch: 0 });
        editor.scrollIntoView({ from: { line: d.line, ch: 0 }, to: { line: d.line, ch: 0 } }, true);
        this.close();
      });
    }
  }

  override onClose() {
    this.contentEl.empty();
  }
}
