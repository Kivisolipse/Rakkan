import { describe, expect, it } from "vitest";
import { exportPandoc, exportPlain, parse } from "../src/core";

const FENCE = "```";

describe("exportPlain", () => {
  it("is the note without markers, blocks and declarations", () => {
    const text = ["人写的。&&AI 句&&[@gpt]。", "", "&& Claude", "", "整段 @@我补的@@。", "", FENCE + "ts @@", "let @@a@@ = 1", FENCE, "", "&&", "", "尾。"].join("\n");
    const out = exportPlain(text);
    expect(out).not.toMatch(/&&|@@/);
    expect(out).toContain("人写的。AI 句。");
    expect(out).toContain("let a = 1");
    expect(parse(out).stats.ai).toBe(0);
  });
});

describe("exportPandoc", () => {
  const authorOf = (k: string) => (k === "gpt" ? { name: "GPT", family: "gpt" } : undefined);

  it("turns inline markers into bracketed spans", () => {
    expect(exportPandoc("人写的。&&AI 句&&[@gpt]，回到人。", { authorOf })).toBe(
      '人写的。[AI 句]{.rk-ai author="GPT" family="gpt"}，回到人。',
    );
    expect(exportPandoc("无署名 &&AI&&。")).toBe("无署名 [AI]{.rk-ai}。");
  });

  it("wraps a quote whole and keeps its citation", () => {
    expect(exportPandoc("书上说「纸短情长」[@fakebook]，对。")).toBe(
      '书上说[「纸短情长」]{.rk-quote author="fakebook"}[@fakebook]，对。',
    );
  });

  it("turns a block into a fenced div and its islands into human spans", () => {
    const text = ["&& Claude (claude-opus-5-5)", "", "整段 @@我补的@@。", "", "&&"].join("\n");
    expect(exportPandoc(text)).toBe(
      ['::: {.rk-ai author="Claude" model="claude-opus-5-5" family="claude"}', "", "整段 [我补的]{.rk-human}。", "", ":::"].join("\n"),
    );
  });

  it("closes a block that the next one ended", () => {
    const out = exportPandoc(["&& Claude", "", "甲。", "", "&& GPT", "", "乙。", "", "&&"].join("\n"));
    expect(out).toContain('甲。\n\n:::\n\n::: {.rk-ai author="GPT"');
  });

  it("only drops the markers in code, with the declaration and the space before it", () => {
    const text = ["&& Claude", "", FENCE + "ts @@", "let @@a@@ = 1", FENCE, "", "&&"].join("\n");
    const out = exportPandoc(text);
    expect(out).toContain(FENCE + "ts\nlet a = 1\n" + FENCE);
  });
});
