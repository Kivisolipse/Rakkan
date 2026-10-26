import { describe, expect, it } from "vitest";
import { minimalChange, parse, setOwner, type Owner } from "../src/core";

/** Rewrite line `n` of `doc` so that the first occurrence of `target` belongs to `owner`. */
function mark(doc: string, n: number, target: string, owner: Owner): string | null {
  const r = parse(doc);
  const line = doc.split("\n")[n];
  const from = line.indexOf(target);
  return setOwner(line, r.lineContexts[n], from, from + target.length, owner);
}

describe("setOwner", () => {
  it("wraps text as inline AI in human regions", () => {
    expect(mark("人写的一句话", 0, "一句", "ai")).toBe("人写的&&一句&&话");
  });

  it("merges with adjacent spans and drops empty ones", () => {
    expect(mark("甲&&乙&&丙", 0, "丙", "ai")).toBe("甲&&乙丙&&");
    expect(mark("甲&&乙&&丙", 0, "乙", "human")).toBe("甲乙丙");
  });

  it("makes islands inside AI blocks", () => {
    const doc = "&& Claude\n\nAI 写的一段话\n\n&&";
    expect(mark(doc, 2, "一段", "human")).toBe("AI 写的@@一段@@话");
    expect(mark("&& Claude\n\nAI @@人@@ AI\n\n&&", 2, "人", "ai")).toBe("AI 人 AI");
  });

  it("keeps spaces outside markers", () => {
    expect(mark("a b c", 0, " b ", "ai")).toBe("a &&b&& c");
  });

  it("joins islands separated only by whitespace", () => {
    expect(mark("&& Claude\n\nAI @@x@@ y AI\n\n&&", 2, "y", "human")).toBe("AI @@x y@@ AI");
  });

  it("wraps links, tags and inline code as a whole", () => {
    expect(mark("见 [[UIUC 2]] 吧", 0, "2", "ai")).toBe("见 &&[[UIUC 2]]&& 吧");
    expect(mark("看 [文](http://e.com) 吧", 0, "文", "ai")).toBe("看 &&[文](http://e.com)&& 吧");
    expect(mark("跑 `npm i` 吧", 0, "npm", "ai")).toBe("跑 &&`npm i`&& 吧");
    expect(mark("标签 #学习 吧", 0, "学", "ai")).toBe("标签 &&#学习&& 吧");
  });

  it("keeps [@key] attached to untouched spans", () => {
    expect(mark("&&模型&&[@gpt]和人", 0, "和", "human")).toBe("&&模型&&[@gpt]和人");
    expect(mark("&&模型&&[@gpt]和人", 0, "人", "ai")).toBe("&&模型&&[@gpt]和&&人&&");
  });

  it("escapes literal markers that would otherwise pair", () => {
    expect(mark("a && b 和 c", 0, "c", "ai")).toBe("a \\&& b 和 &&c&&");
  });

  it("refuses lines with quotes", () => {
    expect(mark("「引」[@a] 外", 0, "外", "ai")).toBeNull();
  });
});

describe("minimalChange", () => {
  it("finds the smallest replacement", () => {
    expect(minimalChange("abc", "aXbc")).toEqual({ from: 1, to: 1, insert: "X" });
    expect(minimalChange("abc", "abc")).toBeNull();
  });
});
