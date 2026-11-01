import { Notice, normalizePath, type App, type Editor, type TFile } from "obsidian";
import { exportPandoc, exportPlain, fromIA, signatureFamily, toIA, type Author, type ExtraPrefix } from "../core";

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
  if (kind === "plain") out = exportPlain(text);
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

/** Replace the note's text with its iA annotations written as Rakkan markers (one undo step). */
export function importIA(editor: Editor) {
  const res = fromIA(editor.getValue());
  if (!res) {
    new Notice("这篇笔记末尾没有 iA 的标注块");
    return;
  }
  if (!res.hashOk) {
    new Notice("标注和正文对不上（哈希不符），没有转换。可能是标注之后又改过正文");
    return;
  }
  editor.setValue(res.text);
  new Notice(
    res.referenceChars
      ? `已转换。iA 里标为"参考"的 ${res.referenceChars} 个字没有对应的引文作者，保持为普通文字`
      : "已转换",
  );
}
