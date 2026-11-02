import { Notice, SuggestModal, normalizePath, type App, type Editor, type TFile } from "obsidian";
import { exportPandoc, exportPlain, fromIA, signatureFamily, toIA, unknownHumans, type Author, type ExtraPrefix, type HumanChoice } from "../core";

export type ExportKind = "plain" | "pandoc" | "ia";

const SUFFIX: Record<ExportKind, string> = { plain: "去标记", pandoc: "Pandoc", ia: "iA" };

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
) {
  const nameOf = (key: string) => authors[key]?.name;
  let out: string;
  if (kind === "plain") out = exportPlain(text, { nameOf });
  else if (kind === "ia") out = toIA(text, { nameOf });
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
  const path = freePath(app, file, SUFFIX[kind]);
  await app.vault.create(path, out);
  new Notice(`已导出：${path}`);
}

/** Of the humans the author book does not know, which one owns this vault? Perhaps none: they may all be quotes. */
class OwnerModal extends SuggestModal<HumanChoice | null> {
  constructor(
    app: App,
    private choices: HumanChoice[],
    private onPick: (name: string | null) => void,
  ) {
    super(app);
    this.setPlaceholder("这些人都不在署名簿里：哪一位是这个库的主人？其余的会写成引文");
  }

  getSuggestions(query: string): Array<HumanChoice | null> {
    const q = query.trim().toLowerCase();
    const found: Array<HumanChoice | null> = this.choices.filter((c) => !q || c.name.toLowerCase().includes(q));
    return q ? found : [...found, null];
  }

  renderSuggestion(c: HumanChoice | null, el: HTMLElement): void {
    if (!c) {
      el.createDiv({ text: "都不是，全部写成引文" });
      el.createEl("small", { text: "这些人写的字都是别人的" });
      return;
    }
    el.createDiv({ text: c.name });
    el.createEl("small", { text: `${c.chars} 个字` });
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
    new Notice("这篇笔记末尾没有 iA 的标注块");
    return;
  }
  if (!res.hashOk) {
    new Notice("标注和正文对不上（哈希不符），没有转换。可能是标注之后又改过正文");
    return;
  }
  editor.setValue(res.text);
  const parts = ["已转换"];
  if (res.quotes) parts.push(`${res.quotes} 处"参考"写成了引文`);
  if (res.others.length) parts.push(`${res.others.join("、")} 的字写成了引文`);
  if (res.referenceChars) parts.push(`另有 ${res.referenceChars} 个字的"参考"没法写成引文（里面已有引号），保持为普通文字`);
  new Notice(parts.join("，"));
}
