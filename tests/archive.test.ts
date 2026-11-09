import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyArchiveEdits,
  archiveNote,
  emptyArchive,
  exportPlain,
  parseArchive,
  planRestore,
  plainHash,
  restoreNote,
  serializeArchive,
  type ArchiveEntry,
} from "../src/core";

const nameOf = (key: string) => ({ fakebook: "《一本不存在的书》" })[key];

const NOTES: Record<string, string> = {
  inline: "人写的，&&模型补的&&，又是人。\n",
  cited: "前文 &&GPT 写的&&[@gpt] 后文。\n\n[@gpt]: GPT (gpt-5)\n",
  block: "开头。\n\n&& Claude (claude-opus-5-5)\n\nAI 的一段，里面有 @@人改的@@ 字。\n\n第二段。\n\n&&\n\n结尾。\n",
  unclosed: "开头。\n\n&& Claude (claude-opus-5-5)\n\nAI 写到最后。\n",
  quote: "> 「天下大势，分久必合」\n> [@fakebook]\n\n[@fakebook]: 《一本不存在的书》 · 来源\n",
  inlineQuote: "他说「原话如此」[@fakebook]，然后走了。\n",
  code: "&& AI\n\n```ts @@\nconst a = 1; @@// 人@@\n```\n\n&&\n",
  crlf: "第一行 &&AI&&\r\n第二行\r\n",
  edge: "&&开头就是 AI&&",
};

const files = (dir: URL) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => [f, readFileSync(new URL(f, dir), "utf8")] as const);

const ALL = [
  ...Object.entries(NOTES),
  ...files(new URL("./fixtures/", import.meta.url)),
  ...files(new URL("../demo-vault/", import.meta.url)),
];

describe("archiveNote", () => {
  it.each(ALL)("%s: the plain note is exportPlain, and the edits give the note back", (_, text) => {
    const a = archiveNote(text, { nameOf });
    const lf = text.replace(/\r\n/g, "\n");
    if (!a) {
      expect(exportPlain(lf, { nameOf })).toBe(lf);
      return;
    }
    expect(a.plain).toBe(exportPlain(lf, { nameOf }));
    expect(applyArchiveEdits(a.plain, a.edits)).toBe(lf);
    expect(restoreNote(a.plain, { path: "x.md", sha256: a.sha256, edits: a.edits })).toBe(lf);
  });

  it("keeps no text of the note, only the markers", () => {
    const a = archiveNote(NOTES.block)!;
    const kept = a.edits.map((e) => e[2]).join("");
    expect(kept).not.toContain("AI 的一段");
    expect(kept).toContain("&& Claude (claude-opus-5-5)");
    expect(kept).toContain("@@");
  });

  it("turns `— name` back into the citation", () => {
    const a = archiveNote(NOTES.quote, { nameOf })!;
    expect(a.plain).toContain("> — 《一本不存在的书》");
    expect(a.edits.some(([, len, text]) => len > 0 && text.includes("[@fakebook]"))).toBe(true);
  });

  it("is null for a note without markers", () => {
    expect(archiveNote("纯人写的，没有标记。\n")).toBeNull();
    expect(archiveNote("Windows 换行\r\n没有标记\r\n")).toBeNull();
  });
});

describe("restoreNote", () => {
  const a = archiveNote(NOTES.inline)!;
  const entry: ArchiveEntry = { path: "a.md", sha256: a.sha256, edits: a.edits };

  it("refuses a note changed by even one character", () => {
    expect(restoreNote(a.plain.replace("又是人", "又是他"), entry)).toBeNull();
    expect(restoreNote(a.plain + " ", entry)).toBeNull();
  });

  it("does not mind line breaks turned into CRLF", () => {
    expect(restoreNote(a.plain.replace(/\n/g, "\r\n"), entry)).toBe(NOTES.inline);
  });
});

describe("the archive file", () => {
  it("survives being written and read", () => {
    const archive = emptyArchive();
    for (const [path, text] of Object.entries(NOTES)) {
      const a = archiveNote(text, { nameOf });
      if (a) archive.notes.push({ path, sha256: a.sha256, edits: a.edits });
    }
    const json = serializeArchive(archive);
    expect(JSON.parse(json)).toEqual(archive);
    expect(parseArchive(json)).toEqual(archive);
    expect(parseArchive(serializeArchive(emptyArchive()))).toEqual(emptyArchive());
  });

  it("rejects what it cannot read", () => {
    expect(parseArchive("not json")).toBeNull();
    expect(parseArchive(JSON.stringify({ format: "rakkan-authorship", version: 2, notes: [] }))).toBeNull();
    expect(parseArchive(JSON.stringify({ format: "rakkan-authorship", version: 1, notes: [{ path: "a.md", sha256: "x", edits: [] }] }))).toBeNull();
  });
});

describe("planRestore", () => {
  const h = (s: string) => plainHash(s);
  const entry = (path: string, plain: string): ArchiveEntry => ({ path, sha256: h(plain), edits: [] });

  it("matches by path, then by content for a moved note", () => {
    const archive = { ...emptyArchive(), notes: [entry("a.md", "A"), entry("old/b.md", "B"), entry("c.md", "C"), entry("d.md", "D")] };
    const plan = planRestore(archive, [
      { path: "a.md", hash: h("A") },
      { path: "new/b.md", hash: h("B") },
      { path: "c.md", hash: h("C changed") },
    ]);
    expect(plan.restore.map((r) => [r.entry.path, r.path])).toEqual([
      ["a.md", "a.md"],
      ["old/b.md", "new/b.md"],
    ]);
    expect(plan.changed.map((e) => e.path)).toEqual(["c.md"]);
    expect(plan.missing.map((e) => e.path)).toEqual(["d.md"]);
  });

  it("does not guess between notes with the same content", () => {
    const archive = { ...emptyArchive(), notes: [entry("gone.md", "same")] };
    const plan = planRestore(archive, [
      { path: "x.md", hash: h("same") },
      { path: "y.md", hash: h("same") },
    ]);
    expect(plan.restore).toEqual([]);
    expect(plan.ambiguous.map((e) => e.path)).toEqual(["gone.md"]);
  });

  it("gives a note to the newest entry that matches", () => {
    const older = { ...entry("a.md", "A"), edits: [[0, 0, "old"]] as ArchiveEntry["edits"] };
    const newer = { ...entry("a.md", "A"), edits: [[0, 0, "new"]] as ArchiveEntry["edits"] };
    const plan = planRestore({ ...emptyArchive(), notes: [older, newer] }, [{ path: "a.md", hash: h("A") }]);
    expect(plan.restore.map((r) => r.entry)).toEqual([newer]);
    expect(plan.changed).toEqual([older]);
  });
});
