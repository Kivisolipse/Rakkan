import { describe, expect, it } from "vitest";
import { parse, setOwner, signRevision } from "../src/core";

const markAll = (line: string) => setOwner(line, parse(line).lineContexts[0], 0, line.length, "ai");

describe("line leaders stay outside markers", () => {
  it("keeps a heading a heading", () => {
    expect(markAll("## 标题")).toBe("## &&标题&&");
  });

  it("keeps list items, tasks and numbers", () => {
    expect(markAll("- 条目")).toBe("- &&条目&&");
    expect(markAll("  * [ ] 待办")).toBe("  * [ ] &&待办&&");
    expect(markAll("12. 第十二")).toBe("12. &&第十二&&");
  });

  it("keeps a footnote label", () => {
    expect(markAll("[^1]: 注释")).toBe("[^1]: &&注释&&");
  });

  it("keeps table pipes, but not escaped ones or pipes in code", () => {
    expect(markAll("| a | b |")).toBe("| &&a&& | &&b&& |");
    expect(markAll("| a \\| b | `x|y` |")).toBe("| &&a \\| b&& | &&`x|y`&& |");
  });

  it("leaves a blockquote prefix where it is", () => {
    expect(markAll("> - 引用里的条目")).toBe("> - &&引用里的条目&&");
  });

  it("signs new headings, list items and table rows", () => {
    const r = signRevision("人写的。\n\n| a |\n|---|\n| 1 |\n", "人写的。\n## 新标题\n- 新条目\n\n| a |\n|---|\n| 1 |\n| 2 |\n", "claude-opus-5-5");
    expect(r.text).toBe(
      "人写的。\n## &&新标题&&[@claude-opus-5-5]\n- &&新条目&&[@claude-opus-5-5]\n\n| a |\n|---|\n| 1 |\n| &&2&&[@claude-opus-5-5] |\n",
    );
  });

  it("does not touch a plain paragraph", () => {
    expect(markAll("#不是标题")).toBe("&&#不是标题&&");
    expect(markAll("-不是列表")).toBe("&&-不是列表&&");
  });
});

describe("signRevision keeps lines in line around a new paragraph", () => {
  it("does not credit the next human line to the model", () => {
    const original = "# 人写的笔记\n\n我喜欢苹果。\n\n书上说「纸短情长」[@book]，我深以为然。\n\n- 第一条\n";
    const revised = "# 人写的笔记\n\n我很喜欢苹果。\n\n&& Claude (claude-opus-5-5)\n\n苹果富含膳食纤维。\n\n&&\n\n书上说「纸短情长」[@book]，我深以为然，也有点怀疑。\n\n- 第一条\n- 第二条\n";
    const r = signRevision(original, revised, "claude-opus-5-5");
    expect(r.text).toBe(
      "# 人写的笔记\n\n我&&很&&[@claude-opus-5-5]喜欢苹果。\n\n&& Claude (claude-opus-5-5)\n\n苹果富含膳食纤维。\n\n&&\n\n书上说「纸短情长」[@book]，我深以为然。\n\n- 第一条\n- &&第二条&&[@claude-opus-5-5]\n",
    );
    // A line with a quote can't be rewritten yet, so the change there is put back (Q5b).
    expect(r.unmarked).toEqual([10]);
    expect(r.rejected.map((x) => x.revised)).toEqual(["书上说「纸短情长」[@book]，我深以为然，也有点怀疑。"]);
  });
});
