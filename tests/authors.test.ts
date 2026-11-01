import { describe, expect, it } from "vitest";
import { BOOK_TEMPLATE, parse, parseAuthor, parseBook, quoteText } from "../src/core";
import { authorOf, resolve, type StyleSettings } from "../src/cm6/resolve";

const styles = (authors = {}): StyleSettings => ({
  familyColors: true,
  aiStyle: "color",
  quoteStyle: "color",
  familyStyle: {},
  modelStyle: {},
  forceStyle: "",
  extraPrefixes: [],
  authors,
});

describe("parseAuthor", () => {
  it("reads name, id, kind and colour", () => {
    expect(parseAuthor("ada", "Ada Example · 人 · #3b82f6")).toEqual({
      key: "ada",
      name: "Ada Example",
      kind: "human",
      color: "#3b82f6",
    });
    expect(parseAuthor("opus", "Claude (claude-opus-5-5) · AI")).toEqual({
      key: "opus",
      name: "Claude",
      id: "claude-opus-5-5",
      kind: "ai",
    });
    expect(parseAuthor("b", "《一本不存在的书》 (ISBN 000) · 来源")).toMatchObject({ kind: "source", id: "ISBN 000" });
  });

  it("accepts parts in any order and full-width parentheses", () => {
    expect(parseAuthor("a", "助手（gpt-5） · #fff · AI")).toMatchObject({ name: "助手", id: "gpt-5", kind: "ai", color: "#fff" });
  });

  it("guesses AI from a model id when no kind is given", () => {
    expect(parseAuthor("a", "Claude (claude-opus-5-5)").kind).toBe("ai");
    expect(parseAuthor("a", "Someone").kind).toBe("human");
  });
});

describe("parseBook", () => {
  it("reads bullet and bare lines, first definition wins, ignores everything else", () => {
    const book = parseBook("# 署名簿\n\n说明文字 @ 这里\n\n- @a: 甲 · 人\n@b: 乙 · 来源\n- @a: 丙 · AI\n");
    expect(Object.keys(book)).toEqual(["a", "b"]);
    expect(book.a.name).toBe("甲");
    expect(book.b.kind).toBe("source");
  });

  it("parses its own template", () => {
    const book = parseBook(BOOK_TEMPLATE);
    expect(Object.keys(book)).toEqual(["claude", "gpt", "ada", "fakebook"]);
    expect(book.ada).toMatchObject({ kind: "human", color: "#3b82f6" });
  });
});

describe("definitions at the end of a note", () => {
  it("accept the bullet form and are not counted as text", () => {
    const r = parse("正文 &&x&&[@a]\n\n- @a: Claude (claude-opus-5-5) · AI\n");
    expect(r.definitions).toEqual({ a: "Claude (claude-opus-5-5) · AI" });
    expect(r.stats.human).toBe(2);
  });
});

describe("quoteText", () => {
  it("picks a quote mark that is free", () => {
    expect(quoteText("纸短情长", "a")).toBe("「纸短情长」[@a]");
    expect(quoteText("他说「好」", "a")).toBe('"他说「好」"[@a]');
  });

  it("uses a cited blockquote for several lines or when all marks are taken", () => {
    expect(quoteText("甲\n\n乙", "a")).toBe("> 甲\n>\n> 乙\n> [@a]");
    expect(quoteText('他说「好」又说"行"', "a")).toBe('> 他说「好」又说"行"\n> [@a]');
  });

  it("round-trips through the parser", () => {
    for (const text of ["纸短情长", "甲\n乙"]) {
      const r = parse(quoteText(text, "a"));
      expect(r.stats.quote).toBe(text.replace(/\s/g, "").length);
    }
  });
});

describe("author colours", () => {
  const doc = (src: string) => parse(src);

  it("colours a human author by its colour, a stable hue otherwise", () => {
    const book = { ada: parseAuthor("ada", "Ada · 人 · #3b82f6"), bob: parseAuthor("bob", "Bob · 人") };
    const r = doc("「x」[@ada] 「y」[@bob]");
    const quotes = r.segments.filter((s) => s.role === "text" && s.attr.kind === "quote");
    const a = resolve(quotes[0].attr, r, styles(book))!;
    const b = resolve(quotes[1].attr, r, styles(book))!;
    expect(a.style).toBe("--rk-c: #3b82f6; --rk-c2: #3b82f6;");
    expect(b.style).toMatch(/^--rk-c: hsl\(\d+ 52% 48%\)/);
    expect(resolve(quotes[1].attr, r, styles(book))!.style).toBe(b.style);
    expect(a.label).toBe("Ada");
  });

  it("dims sources and leaves unknown keys to the default quote colour", () => {
    const book = { book: parseAuthor("book", "《书》 · 来源") };
    const r = doc("「x」[@book] 「y」[@nobody]");
    const quotes = r.segments.filter((s) => s.role === "text" && s.attr.kind === "quote");
    const a = resolve(quotes[0].attr, r, styles(book))!;
    const b = resolve(quotes[1].attr, r, styles(book))!;
    expect(a.cls).toContain("rk-source");
    expect(a.style).toBeUndefined();
    expect(b.style).toBeUndefined();
    expect(b.label).toBe("@nobody");
  });

  it("quoting an AI uses its family colour", () => {
    const book = { c: parseAuthor("c", "Claude (claude-opus-5-5) · AI") };
    const r = doc("「x」[@c]");
    const q = r.segments.find((s) => s.role === "text" && s.attr.kind === "quote")!;
    expect(resolve(q.attr, r, styles(book))!.style).toContain("var(--rk-c-claude)");
  });

  it("finds the model of an inline AI span through the book, and the note's own definition wins", () => {
    const book = { m: parseAuthor("m", "GPT (gpt-5) · AI") };
    const r = doc("&&x&&[@m]\n\n@m: Claude (claude-opus-5-5) · AI\n");
    const t = r.segments.find((s) => s.role === "text" && s.attr.kind === "ai")!;
    expect(resolve(t.attr, r, styles(book))!.cls).toContain("rk-fam-claude");
    const r2 = doc("&&x&&[@m]");
    const t2 = r2.segments.find((s) => s.role === "text" && s.attr.kind === "ai")!;
    expect(resolve(t2.attr, r2, styles(book))!.cls).toContain("rk-fam-gpt");
    expect(authorOf("m", r, styles(book))!.name).toBe("Claude");
  });

  it("applies an author's own colour to AI text too", () => {
    const book = { m: parseAuthor("m", "GPT (gpt-5) · AI · #ff0000") };
    const r = doc("&&x&&[@m]");
    const t = r.segments.find((s) => s.role === "text" && s.attr.kind === "ai")!;
    expect(resolve(t.attr, r, styles(book))!.style).toBe("--rk-c: #ff0000; --rk-c2: #ff0000;");
  });
});
