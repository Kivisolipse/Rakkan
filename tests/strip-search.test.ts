import { describe, expect, it } from "vitest";
import { dropMarkerRuns, excerpt, findPlain, looseQuery, looseRegex, looseRegexSource, parse, stripMarkers } from "../src/core";

describe("stripMarkers", () => {
  it("removes inline markers and cites but keeps other syntax", () => {
    const r = parse("这是&&**AI**&&[@gpt]，「引」[@a]，`a && b`");
    expect(stripMarkers(r).text).toBe("这是**AI**，「引」，`a && b`");
  });

  it("removes block lines with one surrounding blank line", () => {
    const r = parse("前\n\n&& Claude\n\n块@@人@@\n\n&&\n\n后");
    expect(stripMarkers(r).text).toBe("前\n\n块人\n\n后");
  });

  it("strips a range and maps back to source offsets", () => {
    const src = "人&&AI&&人";
    const s = stripMarkers(parse(src), 1, 8);
    expect(s.text).toBe("AI人");
    expect(s.map.map((i) => src[i]).join("")).toBe("AI人");
  });

  it("removes code declarations", () => {
    const r = parse("```ts &&&\nx = &&&1&&&\n```");
    expect(stripMarkers(r).text).toBe("```ts\nx = 1\n```");
  });

  it("never touches math", () => {
    const r = parse("$a && b$ 和 &&x&&");
    expect(stripMarkers(r).text).toBe("$a && b$ 和 x");
  });
});

describe("looseRegex", () => {
  it("matches across markers and formatting", () => {
    const re = looseRegex("分页机制");
    expect("这是分&&页@@机**制".match(re)?.[0]).toBe("分&&页@@机**制");
    expect("[[分页]]机制".match(looseRegex("分页机制"))?.[0]).toBe("分页]]机制");
  });

  it("matches across citations", () => {
    expect("写的&&[@claude]句子".match(looseRegex("写的句子"))?.[0]).toBe("写的&&[@claude]句子");
    expect("「引文」[@ji]，后文".match(looseRegex("」，"))?.[0]).toBe("」[@ji]，");
    expect("a [@b c] d".match(looseRegex("ad"))).toBeNull();
  });

  it("is case-insensitive unless told otherwise, and escapes regex syntax", () => {
    expect("Tw**ój**".match(looseRegex("twój"))?.[0]).toBe("Tw**ój");
    expect("STRASSE".match(looseRegex("straße"))).toBeNull();
    expect("aB".match(looseRegex("Ab", "g"))).toBeNull();
    expect("a.b".match(looseRegex("a.b"))?.[0]).toBe("a.b");
    expect("axb".match(looseRegex("a.b"))).toBeNull();
  });

  it("lets a run of whitespace match any run", () => {
    expect("分页\n\n机制".match(looseRegex("分页  机制"))?.[0]).toBe("分页\n\n机制");
  });

  it("stays linear on long runs of formatting characters", () => {
    const t0 = Date.now();
    looseRegex("ab").test("a" + "*".repeat(100000) + "c");
    looseRegex("ab").test("a" + "[@x]".repeat(25000) + "c");
    looseRegex("ab").test("a" + "[@".repeat(50000) + "c");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("looseQuery", () => {
  const re = (s: string) => `/${looseRegexSource(s)}/`;
  /** The regex a query became, as Obsidian compiles it (case-insensitive). */
  const compiled = (q: string) => new RegExp(looseQuery(q).slice(1, -1), "gmi");

  it("turns words and phrases into regexes", () => {
    expect(looseQuery("分页机制")).toBe(re("分页机制"));
    expect(looseQuery('"分页 机制" 公式')).toBe(`${re("分页 机制")} ${re("公式")}`);
    expect(looseQuery("-草稿")).toBe(`-${re("草稿")}`);
    expect(looseQuery("e-mail")).toBe(re("e-mail"));
  });

  it("keeps what is not the note's text, regexes, keywords and grouping", () => {
    expect(looseQuery("path:demo tag:#ai #ai [status:done] /a.b/")).toBe("path:demo tag:#ai #ai [status:done] /a.b/");
    expect(looseQuery('file:"my note" path:(a b) 机制')).toBe(`file:"my note" path:(a b) ${re("机制")}`);
    expect(looseQuery("(分页 OR 机制)")).toBe(`(${re("分页")} OR ${re("机制")})`);
    expect(looseQuery("line:分页机制 section:(a b)")).toBe(`line:${re("分页机制")} section:(${re("a")} ${re("b")})`);
    expect(looseQuery("match-case:Ab -task-todo:x")).toBe(`match-case:${re("Ab")} -task-todo:${re("x")}`);
    expect(looseQuery("[status:(a b)] c")).toBe(`[status:(a b)] ${re("c")}`);
  });

  it("leaves a regex or a phrase still being typed in one piece", () => {
    expect(looseQuery("/a b")).toBe("/a b");
    expect(looseQuery("/a\\/b/ c")).toBe(`/a\\/b/ ${re("c")}`);
    expect(compiled('"分页 机').test("介绍分页@@ 机制")).toBe(true);
    expect(compiled('"a \\"b').test('x a "b')).toBe(true);
  });

  it("keeps a phrase to whole words, as Obsidian does", () => {
    expect(compiled('"cat"').test("a ca**t** sat")).toBe(true);
    expect(compiled('"cat"').test("category")).toBe(false);
    expect(compiled('"cat"').test("concat")).toBe(false);
    expect(compiled('"分页"').test("介绍分页机制")).toBe(true);
    expect(compiled('"cat"').exec("a cat")?.[0]).toBe("cat");
  });
});

describe("findPlain", () => {
  const src = "开头。\n\n&& Claude (claude-opus-5-5)\n\n介绍分页@@机制@@的段落。\n\n&&\n\n原创段落，&&AI 写的&&[@claude]句子。\n";
  const p = stripMarkers(parse(src));

  it("finds words split by markers and maps the hit back to the source", () => {
    const [hit] = findPlain(p, "分页机制");
    expect(src.slice(hit.from, hit.to)).toBe("分页@@机制");
    expect(p.text.slice(hit.plainFrom, hit.plainTo)).toBe("分页机制");
  });

  it("does not find text that only exists in markers", () => {
    expect(findPlain(p, "claude-opus")).toEqual([]);
    expect(findPlain(p, "[@claude]")).toEqual([]);
  });

  it("cuts an excerpt from the line, without markers", () => {
    const [hit] = findPlain(p, "AI 写的");
    expect(excerpt(p.text, hit.plainFrom, hit.plainTo)).toEqual({ before: "原创段落，", hit: "AI 写的", after: "句子。" });
    const short = excerpt(p.text, hit.plainFrom, hit.plainTo, 3, 1);
    expect(short).toEqual({ before: "…段落，", hit: "AI 写的", after: "句…" });
  });
});

describe("dropMarkerRuns", () => {
  it("drops markers from a fragment and keeps code operators", () => {
    expect(dropMarkerRuns("分页@@机制@@，&&AI 写的&&[@claude]")).toBe("分页机制，AI 写的");
    expect(dropMarkerRuns("if (a && b)")).toBe("if (a && b)");
  });
});
