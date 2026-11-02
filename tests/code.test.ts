import { describe, expect, it } from "vitest";
import { codeBlockText, escapeMathDelimiters, fenceLines, parse } from "../src/core";

const FENCE = "```";

describe("code lines know their fence", () => {
  it("records the opening fence on content lines only", () => {
    const r = parse(["前", FENCE + "ts @@", "let a = @@0@@", "return a", FENCE, "后"].join("\n"));
    expect(r.lineContexts.map((c) => c.codeFence)).toEqual([undefined, undefined, 1, 1, undefined, undefined]);
    expect(r.lineContexts[2].mode).toBe("code");
  });

  it("marks undeclared code lines as other, still with their fence", () => {
    const r = parse([FENCE + "js", "a && b", FENCE].join("\n"));
    expect(r.lineContexts[1]).toMatchObject({ mode: "other", codeFence: 0 });
  });
});

describe("codeBlockText", () => {
  it("gives the code with and without the declared markers", () => {
    const r = parse(["&& Claude", "", FENCE + "ts @@", "let a = @@0@@", "@@return a@@", FENCE, "", "&&"].join("\n"));
    expect(codeBlockText(r, 2)).toEqual({ plain: "let a = 0\nreturn a", raw: "let a = @@0@@\n@@return a@@" });
  });

  it("keeps the declared length only", () => {
    const r = parse(["&& Claude", "", FENCE + "diff @@@", "@@ -1 +1 @@", "x @@@y@@@", FENCE, "", "&&"].join("\n"));
    expect(codeBlockText(r, 2)!.plain).toBe("@@ -1 +1 @@\nx y");
  });

  it("is unchanged when nothing is declared, and null when empty", () => {
    const r = parse([FENCE + "js", "a && b", FENCE, FENCE + "js", FENCE].join("\n"));
    const t = codeBlockText(r, 0)!;
    expect(t.plain).toBe(t.raw);
    expect(codeBlockText(r, 3)).toBeNull();
  });

  it("leaves out a blockquote's markers, as the rendered block does", () => {
    const r = parse(["&& Claude", "", "> " + FENCE + "ts @@", "> let a = @@0@@", ">   return a", "> " + FENCE, "", "&&"].join("\n"));
    expect(codeBlockText(r, 2)).toEqual({ plain: "let a = 0\n  return a", raw: "let a = @@0@@\n  return a" });
  });

  it("does the same for a formula declared in a blockquote, after a line of text", () => {
    const r = parse(["&& Claude", "", "> 先有一行字。", ">", "> $$ %@@", "> x^2 + @@\\beta@@", "> $$", "", "&&"].join("\n"));
    expect(r.diagnostics).toEqual([]);
    expect(fenceLines(r, 4).map((l) => r.text.slice(l.from, l.to))).toEqual(["x^2 + @@\\beta@@"]);
    expect(codeBlockText(r, 4)!.plain).toBe("x^2 + \\beta");
  });
});

describe("escapeMathDelimiters", () => {
  const apply = (text: string, changes: Array<{ from: number; insert: string }>) => {
    let out = text;
    for (const c of [...changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.from);
    return out;
  };

  it("escapes both dollar signs of a swallowed span, and the markers work afterwards", () => {
    const text = "约 $3.8 万，&&按汇率粗算&& ¥156/$";
    const d = parse(text).diagnostics.find((x) => x.code === "math-swallow")!;
    const fixed = apply(text, escapeMathDelimiters(text, d));
    expect(fixed).toBe("约 \\$3.8 万，&&按汇率粗算&& ¥156/\\$");
    const r = parse(fixed);
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.ai).toBe(5);
  });

  it("does nothing for a range that is not a pair of dollar signs", () => {
    expect(escapeMathDelimiters("abc", { from: 0, to: 3 })).toEqual([]);
  });
});
