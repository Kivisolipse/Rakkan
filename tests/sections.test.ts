import { describe, expect, it } from "vitest";
import { parse, splitSections } from "../src/core";

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
