import { describe, expect, it } from "vitest";
import { alignSections, parse, splitSections } from "../src/core";

const FENCE = "```";
const sections = (...lines: string[]) => splitSections(parse(lines.join("\n"))).map((s) => [s.lineStart, s.lineEnd]);

describe("splitSections", () => {
  it("splits at blank lines and skips the frontmatter", () => {
    expect(sections("---", "title: 试", "---", "", "一段。", "还是这段。", "", "# 标题", "", "另一段。")).toEqual([
      [4, 5],
      [7, 7],
      [9, 9],
    ]);
  });

  it("keeps a code block together even with blank lines in it", () => {
    expect(sections("前", "", FENCE + "ts", "a", "", "b", FENCE, "", "后")).toEqual([[0, 0], [2, 6], [8, 8]]);
  });

  it("keeps a loose list, and a list item's indented continuation, together", () => {
    expect(sections("- 甲", "", "- 乙", "", "  乙的第二段", "", "段落")).toEqual([[0, 4], [6, 6]]);
  });

  it("gives AI block lines their own sections", () => {
    expect(sections("&& Claude", "", "整段。", "", "&&")).toEqual([[0, 0], [2, 2], [4, 4]]);
  });
});

describe("alignSections", () => {
  const source = ["&& Claude", "# 标题", "- 第一项\n- 第二项 [[笔记|别名]]", "同一句话", "同一句话", "尾声"];

  it("pairs rendered pieces with source pieces by their words", () => {
    expect(alignSections(["Claude", "标题", "第一项第二项别名", "尾声"], source)).toEqual([0, 1, 2, 5]);
  });

  it("matches repeats in order and never reuses a piece", () => {
    expect(alignSections(["同一句话", "同一句话", "同一句话"], source)).toEqual([3, 4, null]);
  });

  it("gives null to what nothing matches, without losing its place", () => {
    expect(alignSections(["没有这句", "尾声"], source)).toEqual([null, 5]);
    expect(alignSections(["", "尾声"], source)).toEqual([null, 5]);
  });
});
