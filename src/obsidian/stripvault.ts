// Removing every Rakkan marker from the vault, for someone about to stop using
// the plugin, and putting them back. Before any note changes, where its markers
// were goes into the authorship archive at the root of the vault; a note left
// unchanged since can have them back exactly.

import { Modal, Notice, normalizePath, setIcon, type App, type TFile } from "obsidian";
import {
  archiveNote,
  ARCHIVE_PATH,
  emptyArchive,
  mayHaveMarkers,
  parseArchive,
  planRestore,
  plainHash,
  restoreNote,
  serializeArchive,
  type Archive,
  type ArchivedNote,
  type ArchiveEntry,
  type RestorePlan,
} from "../core";
import { t } from "../i18n";

const archivePath = () => normalizePath(ARCHIVE_PATH);

/** The archive, null when there is none, or "unreadable". */
async function readArchive(app: App): Promise<Archive | null | "unreadable"> {
  const path = archivePath();
  if (!(await app.vault.adapter.exists(path))) return null;
  return parseArchive(await app.vault.adapter.read(path)) ?? "unreadable";
}

/** Write the archive and read it back; false when what is on disk is not what was meant. */
async function writeArchive(app: App, archive: Archive): Promise<boolean> {
  const path = archivePath();
  try {
    await app.vault.adapter.write(path, serializeArchive(archive));
    const back = parseArchive(await app.vault.adapter.read(path));
    return back?.notes.length === archive.notes.length;
  } catch {
    return false;
  }
}

function checkbox(parent: HTMLElement, text: string, cls = "rk-strip-check"): HTMLInputElement {
  const label = parent.createEl("label", { cls });
  const box = label.createEl("input", { type: "checkbox" });
  label.createSpan({ text });
  return box;
}

interface Item {
  file: TFile;
  /** The note as scanned; it is only changed if it is still this. */
  text: string;
  note: ArchivedNote;
  box?: HTMLInputElement;
}

export class StripVaultModal extends Modal {
  private items: Item[] = [];
  private unsupported = 0;
  private running = false;

  constructor(
    app: App,
    private nameOf: (key: string) => string | undefined,
  ) {
    super(app);
  }

  override onOpen() {
    this.modalEl.addClass("rk-strip-modal");
    this.setTitle(t("从整个库中移除标记"));
    this.contentEl.createEl("p", { text: t("正在扫描库中的笔记…") });
    void this.scan().then(() => this.render());
  }

  private async scan() {
    const items: Item[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(file);
      if (!mayHaveMarkers(text)) continue;
      try {
        const note = archiveNote(text, { nameOf: this.nameOf });
        if (note) items.push({ file, text, note });
      } catch {
        // Its markers could not be recorded exactly, so it is left alone.
        this.unsupported++;
      }
    }
    this.items = items.sort((a, b) => a.file.path.localeCompare(b.file.path));
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    if (!this.items.length) {
      el.createEl("p", { text: t("库中没有含 Rakkan 标记的笔记。") });
      return;
    }

    el.createEl("p", { cls: "rk-strip-warning", text: t("移除后修改过的笔记，标记将永久丢失。") });
    el.createEl("p", {
      text: t("以下 {n} 篇笔记含有 Rakkan 标记。勾选的笔记将被改写：删除全部 && 与 @@ 标记、AI 块的开合行和代码块上的声明，引用末尾的 [@key] 改为「— 名字」。其余 Markdown 不变。", {
        n: this.items.length,
      }),
    });
    el.createEl("p", {
      text: t("改写前，各笔记的标记位置将写入库根目录的 {path}（不含正文）。之后可用命令「从署名存档恢复标记」恢复，前提是笔记在此期间未经修改。请勿删除该文件。", {
        path: archivePath(),
      }),
    });

    const refreshPicker = this.picker(el, () => update());
    if (this.unsupported) el.createEl("p", { cls: "rk-strip-note", text: t("另有 {n} 篇笔记的标记无法完整记录，不会被修改。", { n: this.unsupported }) });
    el.createEl("p", { cls: "rk-strip-note", text: t("仅卸载插件不会修改任何笔记，标记将以原文保留，重新安装后即可恢复显示。") });

    const lost = checkbox(el, t("我确认：移除后修改过的笔记，署名信息无法恢复。"));
    const backup = checkbox(el, t("我确认：已对本库做好备份。"));
    const vault = this.app.vault.getName();
    el.createEl("p", { text: t("请输入库名称「{name}」以确认：", { name: vault }) });
    const input = el.createEl("input", { type: "text", cls: "rk-strip-input", attr: { spellcheck: "false", autocomplete: "off" } });

    const buttons = el.createDiv({ cls: "modal-button-container" });
    const go = buttons.createEl("button", { cls: "mod-warning" });
    buttons.createEl("button", { text: t("取消") }).addEventListener("click", () => this.close());

    const chosen = () => this.items.filter((i) => i.box?.checked);
    const update = () => {
      const n = chosen().length;
      refreshPicker();
      go.setText(t("移除 {n} 篇笔记中的标记", { n }));
      go.disabled = this.running || !n || !lost.checked || !backup.checked || input.value.trim() !== vault;
    };
    for (const c of [lost, backup, input]) c.addEventListener("input", update);
    update();
    go.addEventListener("click", () => {
      if (!go.disabled) void this.run(chosen(), go);
    });
  }

  /**
   * The notes to choose from, by folder, with a filter on the path. "Select
   * all" and a folder's box act on the notes the filter shows; a note hidden
   * by the filter keeps its tick. Returns what redraws the boxes and counts.
   */
  private picker(el: HTMLElement, changed: () => void): () => void {
    const filter = el.createEl("input", { type: "search", cls: "rk-strip-filter", attr: { placeholder: t("按路径筛选") } });
    const head = el.createDiv({ cls: "rk-strip-head" });
    const all = checkbox(head, t("全选"), "rk-strip-check rk-strip-all");
    const tally = head.createSpan({ cls: "rk-strip-count" });
    const list = el.createDiv({ cls: "rk-strip-list" });

    const byFolder = new Map<string, Item[]>();
    for (const item of this.items) {
      const folder = item.file.parent?.path ?? "/";
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), item]);
    }
    const startOpen = this.items.length <= 30;
    const groups = [...byFolder.entries()]
      .sort(([a], [b]) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)))
      .map(([folder, items]) => {
        const wrap = list.createDiv({ cls: "rk-strip-folder" });
        const header = wrap.createDiv({ cls: "rk-strip-row rk-strip-folder-row" });
        const toggle = header.createSpan({ cls: "rk-strip-toggle" });
        const box = header.createEl("input", { type: "checkbox" });
        const name = header.createSpan({ cls: "rk-strip-path", text: folder === "/" ? t("库根目录") : folder });
        const count = header.createSpan({ cls: "rk-strip-count" });
        const body = wrap.createDiv({ cls: "rk-strip-items" });
        const rows = items.map((item) => {
          const row = body.createEl("label", { cls: "rk-strip-row" });
          item.box = row.createEl("input", { type: "checkbox" });
          item.box.checked = true;
          row.createSpan({ cls: "rk-strip-path", text: item.file.name });
          row.createSpan({ cls: "rk-strip-count", text: t("{n} 处", { n: item.note.edits.length }) });
          return { item, row };
        });
        const g = { items, rows, wrap, box, toggle, count, body, open: startOpen };
        for (const target of [toggle, name])
          target.addEventListener("click", () => {
            g.open = !g.open;
            refresh();
          });
        box.addEventListener("change", () => {
          for (const i of visible(items)) i.box!.checked = box.checked;
        });
        return g;
      });

    const query = () => filter.value.trim().toLowerCase();
    const visible = (items: Item[]) => items.filter((i) => !query() || i.file.path.toLowerCase().includes(query()));
    const mark = (box: HTMLInputElement, items: Item[]) => {
      const on = items.filter((i) => i.box!.checked).length;
      box.checked = items.length > 0 && on === items.length;
      box.indeterminate = on > 0 && on < items.length;
    };
    const refresh = () => {
      const filtering = query() !== "";
      for (const g of groups) {
        const shown = visible(g.items);
        g.wrap.toggle(shown.length > 0);
        for (const r of g.rows) r.row.toggle(shown.includes(r.item));
        const open = filtering || g.open;
        g.body.toggle(open);
        setIcon(g.toggle, open ? "chevron-down" : "chevron-right");
        mark(g.box, shown);
        g.count.setText(t("{n} / {m} 篇", { n: g.items.filter((i) => i.box!.checked).length, m: g.items.length }));
      }
      mark(all, visible(this.items));
      tally.setText(t("已选 {n} / 共 {m} 篇", { n: this.items.filter((i) => i.box!.checked).length, m: this.items.length }));
    };

    all.addEventListener("change", () => {
      for (const i of visible(this.items)) i.box!.checked = all.checked;
      changed();
    });
    list.addEventListener("change", changed);
    filter.addEventListener("input", changed);
    return refresh;
  }

  private async run(items: Item[], go: HTMLButtonElement) {
    this.running = true;
    go.disabled = true;
    const stop = (message: string) => {
      this.close();
      new Notice(message, 0);
    };

    // The archive first: no note loses its markers before they are on disk.
    const existing = await readArchive(this.app);
    if (existing === "unreadable") return stop(t("{path} 无法读取，未修改任何笔记。请先移走或修复该文件。", { path: archivePath() }));
    const archive = existing ?? emptyArchive();
    const entries = new Map<Item, ArchiveEntry>();
    for (const i of items) entries.set(i, { path: i.file.path, sha256: i.note.sha256, edits: i.note.edits });
    archive.notes.push(...entries.values());
    if (!(await writeArchive(this.app, archive))) return stop(t("署名存档写入失败，未修改任何笔记。"));

    let done = 0;
    const left: Item[] = [];
    for (const [n, item] of items.entries()) {
      go.setText(t("正在处理 {i} / {n}…", { i: n + 1, n: items.length }));
      let changed = false;
      try {
        await this.app.vault.process(item.file, (text) => {
          // Edited since the scan: the archive entry is not for this text.
          if (text !== item.text) return text;
          changed = true;
          return item.note.plain;
        });
      } catch {
        changed = false;
      }
      if (changed) done++;
      else left.push(item);
    }

    if (left.length) {
      const drop = new Set(left.map((i) => entries.get(i)));
      archive.notes = archive.notes.filter((e) => !drop.has(e));
      await writeArchive(this.app, archive);
    }
    stop(
      left.length
        ? t("已移除 {n} 篇笔记中的标记，署名存档位于 {path}。{m} 篇未修改（扫描后被编辑或写入失败）：{paths}", {
            n: done,
            path: archivePath(),
            m: left.length,
            paths: left.map((i) => i.file.path).join(t("、")),
          })
        : t("已移除 {n} 篇笔记中的标记，署名存档位于 {path}。", { n: done, path: archivePath() }),
    );
  }

  override onClose() {
    this.contentEl.empty();
  }
}

export class RestoreArchiveModal extends Modal {
  private archive!: Archive;
  private plan!: RestorePlan;
  private running = false;

  override onOpen() {
    this.modalEl.addClass("rk-strip-modal");
    this.setTitle(t("从署名存档恢复标记"));
    this.contentEl.createEl("p", { text: t("正在读取署名存档…") });
    void this.load();
  }

  private async load() {
    const el = this.contentEl;
    const archive = await readArchive(this.app);
    if (archive === null || archive === "unreadable") {
      el.empty();
      el.createEl("p", {
        text: archive === null ? t("库根目录没有署名存档（{path}）。", { path: archivePath() }) : t("{path} 无法读取：格式不符或已损坏。", { path: archivePath() }),
      });
      return;
    }
    const notes: Array<{ path: string; hash: string }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) notes.push({ path: file.path, hash: plainHash(await this.app.vault.cachedRead(file)) });
    this.archive = archive;
    this.plan = planRestore(archive, notes);
    this.render();
  }

  private group(title: string, rows: string[], open = false) {
    if (!rows.length) return;
    const d = this.contentEl.createEl("details", { cls: "rk-strip-group" });
    d.open = open;
    d.createEl("summary", { text: title });
    const list = d.createEl("ul", { cls: "rk-strip-list" });
    for (const r of rows) list.createEl("li", { text: r });
  }

  private render() {
    const el = this.contentEl;
    const { plan } = this;
    el.empty();
    el.createEl("p", { text: t("存档中共有 {n} 篇笔记的署名信息。", { n: this.archive.notes.length }) });
    const moved = (r: RestorePlan["restore"][number]) => (r.path === r.entry.path ? r.path : t("{path}（原为 {old}）", { path: r.path, old: r.entry.path }));
    this.group(t("可恢复：{n} 篇", { n: plan.restore.length }), plan.restore.map(moved), true);
    this.group(t("移除后已修改，无法恢复：{n} 篇", { n: plan.changed.length }), plan.changed.map((e) => e.path));
    this.group(t("未找到对应笔记：{n} 篇", { n: plan.missing.length }), plan.missing.map((e) => e.path));
    this.group(t("多篇笔记内容相同，无法确定对应关系：{n} 篇", { n: plan.ambiguous.length }), plan.ambiguous.map((e) => e.path));
    if (plan.restore.length < this.archive.notes.length) el.createEl("p", { cls: "rk-strip-note", text: t("无法恢复的条目保留在存档中。") });

    const buttons = el.createDiv({ cls: "modal-button-container" });
    const go = buttons.createEl("button", { cls: "mod-cta", text: t("恢复 {n} 篇笔记的标记", { n: plan.restore.length }) });
    go.disabled = !plan.restore.length;
    buttons.createEl("button", { text: t("取消") }).addEventListener("click", () => this.close());
    go.addEventListener("click", () => {
      if (!this.running && plan.restore.length) void this.run(go);
    });
  }

  private async run(go: HTMLButtonElement) {
    this.running = true;
    go.disabled = true;
    const restored = new Set<ArchiveEntry>();
    for (const [n, { entry, path }] of this.plan.restore.entries()) {
      go.setText(t("正在处理 {i} / {n}…", { i: n + 1, n: this.plan.restore.length }));
      const file = this.app.vault.getFileByPath(path);
      if (!file) continue;
      try {
        await this.app.vault.process(file, (text) => {
          const out = restoreNote(text, entry);
          if (out === null) return text;
          restored.add(entry);
          return out;
        });
      } catch {
        restored.delete(entry);
      }
    }

    this.archive.notes = this.archive.notes.filter((e) => !restored.has(e));
    let kept = true;
    if (this.archive.notes.length) kept = await writeArchive(this.app, this.archive);
    else await this.app.vault.adapter.remove(archivePath()).catch(() => (kept = false));
    this.close();
    const left = this.archive.notes.length;
    const parts = [t("已恢复 {n} 篇笔记的标记", { n: restored.size })];
    if (left) parts.push(t("{m} 篇仍保留在存档中", { m: left }));
    else if (kept) parts.push(t("署名存档已删除"));
    if (!kept) parts.push(t("署名存档未能更新，其中仍含已恢复的条目"));
    new Notice(parts.join(t("，")), 0);
  }

  override onClose() {
    this.contentEl.empty();
  }
}
