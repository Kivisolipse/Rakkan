import type { StyleSettings } from "../cm6/resolve";
import { publishDescribe } from "./publish";
import { Notice, SuggestModal, normalizePath, type App, type Editor, type TFile } from "obsidian";
import { exportPandoc, exportPlain, exportPublish, fromIA, signatureFamily, toIA, unknownHumans, type Author, type ExtraPrefix, type HumanChoice } from "../core";
import { t } from "../i18n";

export type ExportKind = "plain" | "pandoc" | "ia" | "publish";

const suffix = (kind: ExportKind): string => ({ plain: t("无标记"), pandoc: "Pandoc", ia: "iA", publish: "Publish" })[kind];

/** `Note (去标记).md`, or with a number when that name is taken. */
function freePath(app: App, file: TFile, suffix: string): string {
  const dir = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  for (let n = 0; ; n++) {
    const path = normalizePath(`${dir}${file.basename} (${suffix}${n ? " " + (n + 1) : ""}).md`);
    if (!app.vault.getAbstractFileByPath(path)) return path;
  }
}

/** Write the current note, converted, to a new note beside it; the note itself stays as it is. */
export async function exportNote(
  app: App,
  file: TFile,
  text: string,
  kind: ExportKind,
  authors: Record<string, Author>,
  extra: ExtraPrefix[],
  styles?: StyleSettings,
) {
  const nameOf = (key: string) => authors[key]?.name;
  let out: string;
  if (kind === "plain") out = exportPlain(text, { nameOf });
  else if (kind === "ia") out = toIA(text, { nameOf });
  else if (kind === "publish") {
    if (!styles) throw new Error("publish export needs the style settings");
    out = exportPublish(text, { describe: publishDescribe(styles) });
  }
  else {
    out = exportPandoc(text, {
      authorOf: (key) => {
        const a = authors[key];
        if (!a) return undefined;
        const family = signatureFamily({ raw: "", ...(a.name ? { name: a.name } : {}), ...(a.id ? { id: a.id } : {}) }, extra)?.id;
        return { ...(a.name ? { name: a.name } : {}), ...(family ? { family } : {}) };
      },
    });
  }
  const path = freePath(app, file, suffix(kind));
  await app.vault.create(path, out);
  new Notice(t("已导出：{path}", { path }));
}

/** Of the humans the author book does not know, which one owns this vault? Perhaps none: they may all be quotes. */
class OwnerModal extends SuggestModal<HumanChoice | null> {
  constructor(
    app: App,
    private choices: HumanChoice[],
    private onPick: (name: string | null) => void,
  ) {
    super(app);
    this.setPlaceholder(t("以下人员均不在署名簿中：请选择本库的所有者，其余人员将转为引用"));
  }

  getSuggestions(query: string): Array<HumanChoice | null> {
    const q = query.trim().toLowerCase();
    const found: Array<HumanChoice | null> = this.choices.filter((c) => !q || c.name.toLowerCase().includes(q));
    return q ? found : [...found, null];
  }

  renderSuggestion(c: HumanChoice | null, el: HTMLElement): void {
    if (!c) {
      el.createDiv({ text: t("均不是，全部转为引用") });
      el.createEl("small", { text: t("这些人所写的文字均视为他人所作") });
      return;
    }
    el.createDiv({ text: c.name });
    el.createEl("small", { text: t("{n} 个字", { n: c.chars }) });
  }

  onChooseSuggestion(c: HumanChoice | null): void {
    this.onPick(c ? c.name : null);
  }
}

/** Replace the note's text with its iA annotations written as Rakkan markers (one undo step). */
export function importIA(app: App, editor: Editor, authors: Record<string, Author>) {
  const choices = unknownHumans(editor.getValue(), authors);
  if (choices.length) {
    new OwnerModal(app, choices, (owner) => convertIA(editor, authors, owner)).open();
    return;
  }
  convertIA(editor, authors);
}

function convertIA(editor: Editor, authors: Record<string, Author>, owner?: string | null) {
  const res = fromIA(editor.getValue(), { authors, owner });
  if (!res) {
    new Notice(t("本笔记末尾没有 iA 标注块"));
    return;
  }
  if (!res.hashOk) {
    new Notice(t("标注与正文不一致（哈希不符），未转换。标注生成后正文可能已被修改"));
    return;
  }
  editor.setValue(res.text);
  const parts = [t("已转换")];
  if (res.quotes) parts.push(t("{n} 处参考已转为引用", { n: res.quotes }));
  if (res.others.length) parts.push(t("{names} 的文字已转为引用", { names: res.others.join(t("、")) }));
  if (res.referenceChars) parts.push(t("另有 {n} 个字的参考无法转为引用（其中已含引号），保留为普通文字", { n: res.referenceChars }));
  new Notice(parts.join(t("，")));
}
