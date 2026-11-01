// PDF export of our own. Obsidian's built-in export renders the note without
// saying which source lines a piece came from, so the colouring that depends on
// it (AI blocks, code, block lines) is lost, and it has no room for options of
// ours. This does what the built-in export does, with the pieces rendered one
// by one and coloured with their real lines:
//   - open a hidden window with the app's styles,
//   - render the note into it,
//   - ask the app's main process to print that window to a file.

import { Component, MarkdownRenderer, Modal, normalizePath, Notice, Platform, Setting, type App, type MarkdownPostProcessorContext, type TFile } from "obsidian";
import { exportPlain, parse, splitSections, type ParseResult } from "../core";
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
  /** Page numbers in the footer. */
  pageNumbers: boolean;
  /** A short summary of who wrote how much, after the text. */
  summary: boolean;
}

/** What the PDF export needs from the plugin besides the reading view's. */
export interface PdfDeps extends ReadingDeps {
  /** Display name of a `[@key]` author, when the author book knows it. */
  nameOf?(key: string): string | undefined;
}

export const DEFAULT_PDF: PdfOptions = {
  content: "color",
  includeName: true,
  pageSize: "A4",
  landscape: false,
  margin: "0",
  scale: 100,
  pageNumbers: true,
  summary: false,
};

/** Page sizes in inches. */
const PAGES: Record<PdfOptions["pageSize"], [number, number]> = {
  A3: [11.69, 16.54],
  A4: [8.27, 11.69],
  A5: [5.83, 8.27],
  Legal: [8.5, 14],
  Letter: [8.5, 11],
  Tabloid: [11, 17],
};
/** Margins in inches for the three choices (the dialog's 默认, 无, 最小). */
const MARGINS: Record<PdfOptions["margin"], number> = { "0": 0.6, "1": 0, "2": 0.2 };

interface ElectronLike {
  ipcRenderer: { once(channel: string, fn: () => void): void; send(channel: string, data: unknown): void };
  remote?: {
    dialog: { showSaveDialog(o: object): Promise<{ canceled: boolean; filePath?: string }> };
    getCurrentWindow?(): { show(): void; focus(): void };
    BrowserWindow?: { getAllWindows(): Array<{ getTitle(): string; show(): void; focus(): void }> };
  };
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
    private preview: (o: PdfOptions) => Promise<void>,
  ) {
    super(app);
    this.o = { ...DEFAULT_PDF, ...initial };
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
    new Setting(contentEl).setName("页码").addToggle((t) => t.setValue(this.o.pageNumbers).onChange((v) => (this.o.pageNumbers = v)));
    new Setting(contentEl)
      .setName("文末附署名统计")
      .setDesc("亲笔、代笔（按模型）、引文各占多少字。")
      .addToggle((t) => t.setValue(this.o.summary).onChange((v) => (this.o.summary = v)));
    new Setting(contentEl)
      .setName("缩放百分比")
      .addSlider((s) => s.setLimits(10, 100, 1).setValue(this.o.scale).setDynamicTooltip().onChange((v) => (this.o.scale = v)));

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("预览").onClick(async () => {
          this.save(this.o);
          await this.preview(this.o);
        }),
      )
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

/**
 * The app adds helpers (createDiv, addClass, …) to the DOM of its own window; a
 * window opened here has none, so copy over what the app added: whatever the
 * prototypes of this window have that the new window's lack.
 */
function installHelpers(win: Window) {
  const here = window as unknown as Record<string, { prototype?: object } & object>;
  const there = win as unknown as Record<string, { prototype?: object } & object>;
  const copy = (from: object | undefined, to: object | undefined) => {
    if (!from || !to) return;
    for (const name of Object.getOwnPropertyNames(from)) {
      if (name in to) continue;
      const d = Object.getOwnPropertyDescriptor(from, name);
      if (d) {
        try {
          Object.defineProperty(to, name, d);
        } catch {
          /* a property that cannot be defined is not one of the app's */
        }
      }
    }
  };
  for (const n of ["Node", "Element", "HTMLElement", "SVGElement", "DocumentFragment", "Document", "String", "Array", "Number"]) {
    copy(here[n]?.prototype, there[n]?.prototype);
  }
  copy(here.Math, there.Math);
  for (const n of ["createEl", "createDiv", "createSpan", "createSvg", "createFragment", "sleep", "nextFrame"]) {
    const f = (window as unknown as Record<string, unknown>)[n];
    if (typeof f === "function" && !((win as unknown as Record<string, unknown>)[n])) (win as unknown as Record<string, unknown>)[n] = f;
  }
}

/** The app opens such windows hidden. Show this one, by whichever route the app allows. */
function showWindow(win: Window, title: string) {
  const tries: Array<() => void> = [
    () => {
      const own = electronOf(win)?.remote?.getCurrentWindow?.();
      if (!own) throw new Error("the new window has no remote");
      own.show();
    },
    () => {
      const found = electronOf(window)?.remote?.BrowserWindow?.getAllWindows().find((w) => w.getTitle() === title);
      if (!found) throw new Error("no window titled " + title);
      found.show();
      found.focus();
    },
    () => win.focus(),
  ];
  for (const t of tries) {
    try {
      t();
      return;
    } catch (e) {
      console.debug("Rakkan: could not show the preview window this way", e);
    }
  }
}

/** A window that looks like the app, in light theme; hidden unless it is a preview. */
function openPrintWindow(title: string, visible = false, width = 900): Window | null {
  // The app creates every such window hidden and leaves showing it to whoever asked for it.
  const win = window.open("about:blank", "_blank", visible ? `popup,width=${width},height=900` : "popup,hide=true");
  if (!win) return null;
  installHelpers(win);
  const doc = win.document;
  doc.title = title;
  doc.head.appendChild(doc.createElement("base")).setAttribute("href", location.href);
  for (const node of Array.from(document.head.querySelectorAll("style, link[rel=stylesheet]"))) doc.head.appendChild(node.cloneNode(true));
  for (const a of Array.from(document.documentElement.attributes)) doc.documentElement.setAttribute(a.name, a.value);
  for (const a of Array.from(document.body.attributes)) doc.body.setAttribute(a.name, a.value);
  doc.body.classList.remove("theme-dark");
  doc.body.classList.add("theme-light");
  if (visible) showWindow(win, title);
  return win;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Render the note into `into`, the way the reading view would show it. */
async function renderNote(app: App, file: TFile, text: string, o: PdfOptions, into: HTMLElement, owner: Component, deps: PdfDeps) {
  if (o.includeName) into.createEl("h1", { text: file.basename });
  if (o.content === "plain") {
    const holder = into.createDiv("rk-export");
    await MarkdownRenderer.render(app, withoutFrontmatter(exportPlain(text, { nameOf: deps.nameOf })), holder, file.path, owner);
    if (o.summary) addSummary(into, text, deps);
    return;
  }
  const r = parse(text);
  const lines = text.split("\n");
  const notes = footnotesOf(lines, r);
  for (const s of splitSections(r)) {
    if (notes.defLines.has(s.lineStart)) continue;
    // `rk-export` keeps the reading view's own post-processor out of it: it would not know the lines.
    const holder = into.createDiv("rk-export");
    const chunk = lines.slice(s.lineStart, s.lineEnd + 1).map((l, k) => (r.lineContexts[s.lineStart + k]?.codeFence === undefined ? notes.refer(l) : l));
    await MarkdownRenderer.render(app, chunk.join("\n"), holder, file.path, owner);
    const ctx = {
      sourcePath: file.path,
      getSectionInfo: () => ({ text, lineStart: s.lineStart, lineEnd: s.lineEnd }),
    } as unknown as MarkdownPostProcessorContext;
    processSection(holder, ctx, deps);
  }
  // Footnotes are numbered across the whole note and collected at the end, since each piece was rendered alone.
  if (notes.order.length) {
    const holder = into.createDiv("rk-export rk-footnotes");
    holder.createEl("hr");
    await MarkdownRenderer.render(app, notes.order.map((label, i) => `${i + 1}. ${notes.defs.get(label)}`).join("\n"), holder, file.path, owner);
  }
  if (o.summary) addSummary(into, text, deps);
}

const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;

/** The note's footnotes: their texts, the lines that define them, and a function that numbers references in a line. */
function footnotesOf(lines: string[], r: ParseResult) {
  const defs = new Map<string, string>();
  const defLines = new Set<number>();
  let current: string | null = null;
  lines.forEach((line, i) => {
    if (r.lineContexts[i]?.codeFence !== undefined) return;
    const m = FOOTNOTE_DEF.exec(line);
    if (m) {
      current = m[1];
      defs.set(current, m[2]);
      defLines.add(i);
    } else if (current && /^(?: {4}|\t)\S/.test(line)) {
      defs.set(current, defs.get(current) + " " + line.trim());
      defLines.add(i);
    } else if (line.trim() !== "") current = null;
  });
  const order: string[] = [];
  const refer = (line: string) =>
    line.replace(/\[\^([^\]\s]+)\](?!:)/g, (all, label: string) => {
      if (!defs.has(label)) return all;
      let n = order.indexOf(label);
      if (n < 0) n = order.push(label) - 1;
      return `<sup>${n + 1}</sup>`;
    });
  return { defs, defLines, order, refer };
}

/** Who wrote how much, as a small table after the text. */
function addSummary(into: HTMLElement, text: string, deps: PdfDeps) {
  const { stats } = parse(text);
  const total = stats.human + stats.ai + stats.quote;
  if (!total) return;
  const box = into.createDiv("rk-export rk-summary");
  box.createEl("h2", { text: "署名" });
  const table = box.createEl("table");
  const row = (name: string, n: number) => {
    const tr = table.createEl("tr");
    tr.createEl("td", { text: name });
    tr.createEl("td", { text: `${n.toLocaleString()} 字` });
    tr.createEl("td", { text: `${Math.round((n / total) * 100)}%` });
  };
  row("亲笔", stats.human);
  for (const [who, n] of Object.entries(stats.aiByAuthor).sort((a, b) => b[1] - a[1])) row(`代笔 · ${deps.nameOf?.(who) ?? who}`, n);
  for (const [key, n] of Object.entries(stats.quoteByKey).sort((a, b) => b[1] - a[1])) row(`引文 · ${deps.nameOf?.(key) ?? (key || "无出处")}`, n);
}

function withoutFrontmatter(text: string): string {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

const RAINBOW: Array<[number, string]> = [
  [0, "#f0883a"],
  [0.22, "#ec5f55"],
  [0.42, "#dc3f77"],
  [0.62, "#bd57cc"],
  [0.82, "#8f6fe8"],
  [1, "#6f86f2"],
];

const rgb = (hex: string): [number, number, number] => {
  const h = hex.trim().replace("#", "");
  const f = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
};

function sample(stops: Array<[number, string]>, t: number): string {
  const x = Math.min(1, Math.max(0, t));
  let k = 0;
  while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
  const [t0, c0] = stops[k];
  const [t1, c1] = stops[k + 1];
  const u = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
  const a = rgb(c0);
  const b = rgb(c1);
  return "#" + [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * u).toString(16).padStart(2, "0")).join("");
}

/**
 * A printed page cannot clip a gradient to text reliably, so give every
 * character of rainbow and gradient text the colour it would have: a rainbow
 * by where the character sits across the page, a gradient by how far along its
 * phrase it is. The colours end up as plain text colour, which stays text in the PDF.
 */
async function paintGradients(view: HTMLElement, progress?: (done: number, total: number) => void) {
  const doc = view.ownerDocument;
  const box = view.getBoundingClientRect();
  const left = box.left;
  const width = box.width || 1;
  const range = doc.createRange();
  const isSpace = (c: string) => c.trim() === "";
  const elements = Array.from(view.querySelectorAll<HTMLElement>(".rk-style-rainbow, .rk-style-gradient"));
  let handled = 0;
  for (const el of elements) {
    // Long notes take a while: let the app breathe and say how far along it is.
    if (handled++ % 20 === 0) {
      progress?.(handled - 1, elements.length);
      await sleep(0);
    }
    const rainbow = el.classList.contains("rk-style-rainbow");
    const css = doc.defaultView!.getComputedStyle(el);
    const c1 = css.getPropertyValue("--rk-c").trim() || "#8b5cf6";
    const c2 = css.getPropertyValue("--rk-c2").trim() || c1;
    const stops: Array<[number, string]> = rainbow
      ? RAINBOW
      : [
          [0, c1],
          [1, c2],
        ];

    const nodes: Text[] = [];
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.parentElement?.closest(".rk-code-island")) nodes.push(n as Text);
    }
    const total = nodes.reduce((n, t) => n + t.data.length, 0) || 1;
    let seen = 0;
    // Measure first, change after: replacing nodes moves the layout under the ranges.
    const plans = nodes.map((node) => {
      const colors: Array<string | null> = [];
      for (let i = 0; i < node.data.length; i++) {
        let t: number;
        if (rainbow) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          t = (r.left + r.width / 2 - left) / width;
        } else {
          t = (seen + i) / Math.max(1, total - 1);
        }
        colors.push(isSpace(node.data[i]) ? null : sample(stops, t));
      }
      seen += node.data.length;
      return { node, colors };
    });
    for (const { node, colors } of plans) {
      const frag = doc.createDocumentFragment();
      for (let i = 0; i < node.data.length; i++) {
        // One span per character: the colour changes with every one.
        const c = colors[i];
        if (c === null) frag.append(node.data[i]);
        else {
          const span = doc.createElement("span");
          span.style.setProperty("color", c, "important");
          span.textContent = node.data[i];
          frag.append(span);
        }
      }
      node.replaceWith(frag);
    }
    el.style.setProperty("-webkit-text-fill-color", "currentcolor");
    el.style.background = "none";
  }
}

/**
 * Lay the note out in `win` exactly as wide as the printed page, so the
 * positions measured here are the printed ones. `preview` draws where the pages end.
 */
async function layoutPage(
  win: Window,
  app: App,
  file: TFile,
  text: string,
  o: PdfOptions,
  owner: Component,
  deps: PdfDeps,
  notice: Notice | null,
  preview = false,
) {
  await sleep(200);
  const [pw, ph] = PAGES[o.pageSize];
  const margin = MARGINS[o.margin];
  const scale = Math.min(2, Math.max(0.1, o.scale / 100));
  const [pageW, pageH] = o.landscape ? [ph, pw] : [pw, ph];
  const contentPx = Math.floor(((pageW - 2 * margin) * 96) / scale);
  const pagePx = Math.floor(((pageH - 2 * margin) * 96) / scale);
  const fit = win.document.head.appendChild(win.document.createElement("style"));
  fit.textContent = [
    "html, body { margin: 0 !important; background: #fff; }",
    `.print { position: static !important; width: ${contentPx}px !important; max-width: none !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; }`,
    `.print .markdown-preview-view { width: ${contentPx}px !important; max-width: none !important; margin: 0 !important; padding: 0 !important; }`,
    // Keep a heading with what follows, and a code block, table or quote on one page when it fits.
    "h1, h2, h3, h4, h5, h6 { break-after: avoid; }",
    "pre, table, blockquote, img, .callout { break-inside: avoid; }",
    ".rk-summary { margin-top: 2em; break-inside: avoid; } .rk-summary td { padding: 0.1em 1em 0.1em 0; }",
    preview
      ? `body { background: #888 !important; } .print { margin: 16px auto !important; background: #fff; padding: ${Math.round(margin * 96 / scale)}px !important; box-sizing: content-box; background-origin: content-box; background-image: repeating-linear-gradient(to bottom, transparent 0, transparent ${pagePx - 2}px, #d33 ${pagePx - 2}px, #d33 ${pagePx}px); }`
      : "",
  ].join("\n");
  const print = win.document.body.appendChild(win.document.createElement("div"));
  print.className = "print";
  const view = print.appendChild(win.document.createElement("div"));
  view.className = "markdown-preview-view markdown-rendered";
  await renderNote(app, file, text, o, view, owner, deps);
  await sleep(400);
  if (o.content === "color") await paintGradients(view, (d, t) => notice?.setMessage(`正在给彩虹字上色… ${d} / ${t}`));
  return { view, margin, scale, contentPx };
}

/** Ask for a place to save the file, render, and print. */
export async function exportPdf(app: App, file: TFile, text: string, o: PdfOptions, deps: PdfDeps, css: string) {
  if (!Platform.isDesktopApp) {
    await exportHtml(app, file, text, o, deps, css);
    return;
  }
  const mainElectron = electronOf(window);
  if (!mainElectron?.remote) {
    new Notice("这个版本的 Obsidian 不让插件调用保存对话框，没法导出");
    return;
  }
  const picked = await mainElectron.remote.dialog.showSaveDialog({
    defaultPath: file.basename + ".pdf",
    filters: [
      { name: "PDF Files", extensions: ["pdf"] },
      { name: "All Files", extensions: ["*"] },
    ],
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
    const { margin, scale } = await layoutPage(win, app, file, text, o, owner, deps, notice);

    const electron = electronOf(win);
    if (!electron) throw new Error("no electron in the print window");
    const options: Record<string, unknown> = {
      includeName: o.includeName,
      pageSize: o.pageSize,
      landscape: o.landscape,
      scaleFactor: o.scale,
      scale,
      printBackground: true,
      margins: { top: margin, left: margin, bottom: margin, right: margin },
      ...(o.pageNumbers
        ? {
            displayHeaderFooter: true,
            headerTemplate: "<span></span>",
            footerTemplate:
              '<div style="width:100%;text-align:center;font-size:9px;color:#888;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
          }
        : {}),
      open: true,
      filepath: picked.filePath,
    };
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

/** Show the pages in a window of their own, the red lines where one ends, before saving anything. */
export async function previewPdf(app: App, file: TFile, text: string, o: PdfOptions, deps: PdfDeps) {
  if (!Platform.isDesktopApp) {
    new Notice("预览只能在桌面端用");
    return;
  }
  const [pw, ph] = PAGES[o.pageSize];
  const pageW = (o.landscape ? ph : pw) * 96;
  const win = openPrintWindow(`${file.basename}（预览）`, true, Math.round(Math.min(1400, Math.max(500, pageW + 60))));
  if (!win) {
    new Notice("打不开预览窗口");
    return;
  }
  const notice = new Notice("正在准备预览…", 0);
  const owner = new Component();
  owner.load();
  win.addEventListener("pagehide", () => owner.unload());
  try {
    await layoutPage(win, app, file, text, o, owner, deps, notice, true);
  } catch (e) {
    console.error(e);
    new Notice("预览失败，详情见开发者工具的控制台");
    win.close();
  } finally {
    notice.hide();
  }
}

/**
 * Where there is no way to print to a file (phones), write a page that opens in
 * any browser, which can print or save it as a PDF from there.
 */
async function exportHtml(app: App, file: TFile, text: string, o: PdfOptions, deps: PdfDeps, css: string) {
  const owner = new Component();
  owner.load();
  const holder = document.body.createDiv("markdown-preview-view markdown-rendered");
  holder.setAttribute("style", "position:absolute;left:-99999px;top:0;width:760px;");
  try {
    await renderNote(app, file, text, o, holder, owner, deps);
    await sleep(300);
    const colors = document.getElementById("rakkan-colors")?.textContent ?? "";
    const title = file.basename.replace(/[<&]/g, "");
    const page = [
      "<!doctype html>",
      '<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${title}</title>`,
      "<style>",
      'body { font: 16px/1.7 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 760px; margin: 2em auto; padding: 0 1em; color: #222; background: #fff; }',
      "pre { background: #f5f5f5; padding: .6em .8em; overflow-x: auto; border-radius: 4px; }",
      "blockquote { border-left: 3px solid #bbb; margin-left: 0; padding-left: 1em; color: #555; }",
      "table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: .2em .6em; }",
      "img { max-width: 100%; }",
      colors,
      css,
      "/* Fixed backgrounds do not print: a rainbow runs across its own phrase. */",
      ".rk-style-rainbow { background-attachment: scroll !important; background-size: 100% 100% !important; background-position: 0 0 !important; }",
      "</style></head>",
      `<body class="theme-light"><div class="markdown-rendered">${holder.innerHTML}</div></body></html>`,
    ].join("\n");
    const dir = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
    let path = normalizePath(`${dir}${file.basename}.html`);
    for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${dir}${file.basename} ${n}.html`);
    await app.vault.create(path, page);
    new Notice(`这个设备没法直接生成 PDF，已存成网页：${path}。用浏览器打开后选「打印 → 存为 PDF」`, 10000);
  } catch (e) {
    console.error(e);
    new Notice("导出失败，详情见开发者工具的控制台");
  } finally {
    holder.remove();
    owner.unload();
  }
}
