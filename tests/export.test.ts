import { describe, expect, it } from "vitest";
import { exportPandoc, exportPlain, exportPublish, parse } from "../src/core";

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

describe("exportPlain keeps the source of a cited blockquote", () => {
  it("turns the [@key] line into a dash and the name", () => {
    const text = ["> 整段的引用。", "> 最后一行。", "> [@fakebook]", "", "后文。"].join("\n");
    expect(exportPlain(text)).toBe(["> 整段的引用。", "> 最后一行。", "> — fakebook", "", "后文。"].join("\n"));
    expect(exportPlain(text, { nameOf: (k) => (k === "fakebook" ? "假书" : undefined) })).toContain("> — 假书");
  });

  it("leaves other markers and ordinary text alone", () => {
    expect(exportPlain("人写的。&&AI 句&&[@gpt]，回到人。")).toBe("人写的。AI 句，回到人。");
  });
});

describe("exportPublish", () => {
  const describeAttr = (a: { kind: string; key?: string }) =>
    a.kind === "human" ? null : { cls: a.kind === "quote" ? "rk rk-quote" : "rk rk-ai rk-fam-" + (a.key ?? "claude"), label: a.key ?? "Claude" };
  const pub = (text: string) => exportPublish(text, { describe: describeAttr });

  it("wraps inline AI text in a span, with the author as its title", () => {
    expect(pub("人写的。&&AI 句&&[@gpt]，回到人。")).toBe('人写的。<span class="rk rk-ai rk-fam-gpt" title="gpt">AI 句</span>，回到人。');
  });

  it("turns a quote into a span and its citation into a small author name", () => {
    expect(pub("书上说「纸短情长」[@fakebook]，对。")).toBe(
      '书上说<span class="rk rk-quote" title="fakebook">「纸短情长」</span><sup class="rk-cite">fakebook</sup>，对。',
    );
  });

  it("turns a block into a div that still holds Markdown, and islands into spans", () => {
    const out = pub(["&& Claude (claude-opus-5-5)", "", "整段 @@我补的@@。", "", "&&"].join("\n"));
    expect(out).toBe(
      ['<div class="rk-block rk rk-ai rk-fam-claude">', "", '<p class="rk-sig">Claude</p>', "", '整段 <span class="rk rk-island">我补的</span>。', "", "</div>"].join("\n"),
    );
    expect(out).not.toMatch(/&&|@@/);
  });

  it("closes a block that the next one ended", () => {
    const out = pub(["&& Claude", "", "甲。", "", "&& GPT", "", "乙。", "", "&&"].join("\n"));
    expect(out).toContain("甲。\n\n</div>\n\n<div");
  });

  it("drops markers in code and in declared formulas", () => {
    const text = ["&& Claude", "", "```ts @@", "let @@a@@ = 1", "```", "", "$$ %@@", "x = @@y@@", "$$", "", "&&"].join("\n");
    const out = pub(text);
    expect(out).toContain("```ts\nlet a = 1\n```");
    expect(out).toContain("$$\nx = y\n$$");
  });

  it("escapes text that would break the attribute", () => {
    const quote = exportPublish("&&甲&&", { describe: () => ({ cls: 'a"b', label: 'x"<y' }) });
    expect(quote).toBe('<span class="a&quot;b" title="x&quot;&lt;y">甲</span>');
  });
});
