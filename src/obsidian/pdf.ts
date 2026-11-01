// PDF export of our own. Obsidian's built-in export renders the note without
// saying which source lines a piece came from, so the colouring that depends on
// it (AI blocks, code, block lines) is lost, and it has no room for options of
// ours. This does what the built-in export does, with the pieces rendered one
// by one and coloured with their real lines:
//   - open a hidden window with the app's styles,
//   - render the note into it,
//   - ask the app's main process to print that window to a file.

import { Component, MarkdownRenderer, Modal, Notice, Platform, Setting, type App, type MarkdownPostProcessorContext, type TFile } from "obsidian";
import { exportPlain, parse, splitSections } from "../core";
import { processSection, type ReadingDeps } from "./reading";

export interface PdfOptions {
  /** `color`: AI text in its colours. `plain`: no colours and no markers at all. */
  content: "color" | "plain";
  includeName: boolean;
  pageSize: "A3" | "A4" | "A5" | "Legal" | "Letter" | "Tabloid";
  landscape: boolean;
  /** Electron margin types as Obsidian names them: 0 default, 1 none, 2 minimal. */
  margin: "0" | "1" | "2";
  /** Percent, 10–100. */
  scale: number;
}

export const DEFAULT_PDF: PdfOptions = {
  content: "color",
  includeName: true,
  pageSize: "A4",
  landscape: false,
  margin: "0",
  scale: 100,
};

interface ElectronLike {
  ipcRenderer: { once(channel: string, fn: () => void): void; send(channel: string, data: unknown): void };
  remote?: { dialog: { showSaveDialog(o: object): Promise<{ canceled: boolean; filePath?: string }> } };
}

const electronOf = (win: Window): ElectronLike | null => {
  const w = win as unknown as { electron?: ElectronLike; require?: (m: string) => unknown };
  return w.electron ?? (w.require?.("electron") as ElectronLike | undefined) ?? null;
};

export class PdfModal extends Modal {
  private o: PdfOptions;

  constructor(
    app: App,
    private file: TFile,
    initial: PdfOptions,
    private save: (o: PdfOptions) => void,
    private run: (o: PdfOptions) => Promise<void>,
  ) {
    super(app);
    this.o = { ...initial };
  }

  override onOpen() {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("mod-narrow");
    titleEl.setText("导出为 PDF");
    contentEl.createEl("p", { cls: "u-muted", text: `把「${this.file.basename}」导出为 PDF。` });

    new Setting(contentEl)
      .setName("内容")
      .setDesc("带颜色：AI 的字按模型上色，标记不显示。纯文字：没有颜色，也没有任何标记。")
      .addDropdown((d) =>
        d
          .addOption("color", "带颜色")
          .addOption("plain", "纯文字")
          .setValue(this.o.content)
          .onChange((v) => (this.o.content = v as PdfOptions["content"])),
      );
    new Setting(contentEl).setName("将笔记名作为标题").addToggle((t) => t.setValue(this.o.includeName).onChange((v) => (this.o.includeName = v)));
    new Setting(contentEl).setName("页面尺寸").addDropdown((d) => {
      for (const s of ["A3", "A4", "A5", "Legal", "Letter", "Tabloid"]) d.addOption(s, s);
      d.setValue(this.o.pageSize).onChange((v) => (this.o.pageSize = v as PdfOptions["pageSize"]));
    });
    new Setting(contentEl).setName("横向打印").addToggle((t) => t.setValue(this.o.landscape).onChange((v) => (this.o.landscape = v)));
    new Setting(contentEl).setName("页边距").addDropdown((d) =>
      d
        .addOption("0", "默认")
        .addOption("2", "最小")
        .addOption("1", "无")
        .setValue(this.o.margin)
        .onChange((v) => (this.o.margin = v as PdfOptions["margin"])),
    );
    new Setting(contentEl)
      .setName("缩放百分比")
      .addSlider((s) => s.setLimits(10, 100, 1).setValue(this.o.scale).setDynamicTooltip().onChange((v) => (this.o.scale = v)));

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("导出")
          .setCta()
          .onClick(async () => {
            this.save(this.o);
            this.close();
            await this.run(this.o);
          }),
      )
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
  }

  override onClose() {
    this.contentEl.empty();
  }
}

/** A hidden window that looks like the app, in light theme. */
function openPrintWindow(title: string): Window | null {
  const win = window.open("about:blank", "_blank", "popup,hide=true");
  if (!win) return null;
  const doc = win.document;
  doc.title = title;
  doc.head.appendChild(doc.createElement("base")).setAttribute("href", location.href);
  for (const node of Array.from(document.head.querySelectorAll("style, link[rel=stylesheet]"))) doc.head.appendChild(node.cloneNode(true));
  for (const a of Array.from(document.documentElement.attributes)) doc.documentElement.setAttribute(a.name, a.value);
  for (const a of Array.from(document.body.attributes)) doc.body.setAttribute(a.name, a.value);
  doc.body.classList.remove("theme-dark");
  doc.body.classList.add("theme-light");
  return win;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Render the note into `into`, the way the reading view would show it. */
async function renderNote(app: App, file: TFile, text: string, o: PdfOptions, into: HTMLElement, owner: Component, deps: ReadingDeps) {
  if (o.includeName) into.createEl("h1", { text: file.basename });
  if (o.content === "plain") {
    const holder = into.createDiv("rk-export");
    await MarkdownRenderer.render(app, withoutFrontmatter(exportPlain(text)), holder, file.path, owner);
    return;
  }
  const r = parse(text);
  const lines = text.split("\n");
  for (const s of splitSections(r)) {
    // `rk-export` keeps the reading view's own post-processor out of it: it would not know the lines.
    const holder = into.createDiv("rk-export");
    await MarkdownRenderer.render(app, lines.slice(s.lineStart, s.lineEnd + 1).join("\n"), holder, file.path, owner);
    const ctx = {
      sourcePath: file.path,
      getSectionInfo: () => ({ text, lineStart: s.lineStart, lineEnd: s.lineEnd }),
    } as unknown as MarkdownPostProcessorContext;
    processSection(holder, ctx, deps);
  }
}

function withoutFrontmatter(text: string): string {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** Ask for a place to save the file, render, and print. */
export async function exportPdf(app: App, file: TFile, text: string, o: PdfOptions, deps: ReadingDeps) {
  if (!Platform.isDesktopApp) {
    new Notice("导出 PDF 只能在桌面端用");
    return;
  }
  const mainElectron = electronOf(window);
  if (!mainElectron?.remote) {
    new Notice("这个版本的 Obsidian 不让插件调用保存对话框，没法导出");
    return;
  }
  const picked = await mainElectron.remote.dialog.showSaveDialog({
    defaultPath: file.basename + ".pdf",
    filters: [{ name: "PDF Files", extensions: ["pdf"] }, { name: "All Files", extensions: ["*"] }],
    properties: ["showOverwriteConfirmation"],
  });
  if (picked.canceled || !picked.filePath) return;

  const win = openPrintWindow(file.basename);
  if (!win) {
    new Notice("打不开用来打印的隐藏窗口");
    return;
  }
  const notice = new Notice("正在准备 PDF…", 0);
  const owner = new Component();
  owner.load();
  try {
    await sleep(200);
    const print = win.document.body.createDiv("print");
    const view = print.createDiv("markdown-preview-view markdown-rendered");
    // The theme's variables are what the reading view's colours are made of.
    await renderNote(app, file, text, o, view, owner, deps);
    await sleep(400);

    const electron = electronOf(win);
    if (!electron) throw new Error("no electron in the print window");
    const options: Record<string, unknown> = {
      includeName: o.includeName,
      pageSize: o.pageSize,
      landscape: o.landscape,
      marginsType: parseInt(o.margin),
      scaleFactor: o.scale,
      scale: Math.min(2, Math.max(0.1, o.scale / 100)),
      printBackground: true,
      open: true,
      filepath: picked.filePath,
    };
    if (o.margin === "1" || o.margin === "2") options.margins = { top: 0, left: 0, bottom: 0, right: 0 };
    await new Promise<void>((done) => {
      electron.ipcRenderer.once("print-to-pdf", () => done());
      electron.ipcRenderer.send("print-to-pdf", options);
    });
    new Notice(`PDF 已保存：${picked.filePath}`);
  } catch (e) {
    console.error(e);
    new Notice("导出 PDF 失败，详情见开发者工具的控制台");
  } finally {
    notice.hide();
    owner.unload();
    win.close();
  }
}
