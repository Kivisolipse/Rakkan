import { describe, expect, it } from "vitest";
import { BOOK_TEMPLATE, hueHex, parse, parseAuthor, parseBook, quoteText, setBookColor, addBookAuthor, updateBookAuthor, removeBookAuthor, keyFromName } from "../src/core";
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
  it("keeps one plain line in the line, and uses a cited blockquote for anything else", () => {
    expect(quoteText("纸短情长", "a")).toBe("「纸短情长」[@a]");
    expect(quoteText("It is a *truth* universally acknowledged", "a")).toBe("「It is a *truth* universally acknowledged」[@a]");
    expect(quoteText("甲\n\n乙", "a")).toBe("> 甲\n>\n> 乙\n> [@a]");
    // A character that could be a marker, code, math, a comment or a quotation mark.
    for (const t of ['他说「好」又说"行"', "a `b`", "$x$", "50%", "a & b", "a@b.c"]) expect(quoteText(t, "a")).toMatch(/^> /);
    // What means something only at the start or end of a line, and space a paragraph drops.
    for (const t of ["# 标题", "#tag", "> 引用", "- 项", "1. 项", "<div>", "[a]: /url", "---", "~~~", " 前", "后 ", "末尾\\", "段落 ^abc"])
      expect(quoteText(t, "a")).toMatch(/^> /);
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
    expect(b.style).toMatch(/^--rk-c: #[0-9a-f]{6}; --rk-c2: #[0-9a-f]{6};$/);
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

describe("setBookColor", () => {
  const book = "# 署名簿\n\n- @ada: Ada · 人 · #3b82f6\n- @bob: Bob (id) · 人\r\n- @c: 《书》 · 来源\n";

  it("replaces, adds and removes a colour on one line only", () => {
    expect(setBookColor(book, "ada", "#ff0000")).toBe(book.replace("#3b82f6", "#ff0000"));
    expect(setBookColor(book, "ada", null)).toBe(book.replace(" · #3b82f6", ""));
    expect(setBookColor(book, "c", "#00ff00")).toBe(book.replace("来源", "来源 · #00ff00"));
  });

  it("keeps line endings and leaves unknown keys alone", () => {
    expect(setBookColor(book, "bob", "#111111")).toContain("- @bob: Bob (id) · 人 · #111111\r\n");
    expect(setBookColor(book, "nobody", "#111111")).toBe(book);
  });

  it("produces something parseBook reads back", () => {
    expect(parseBook(setBookColor(book, "c", "#00ff00")).c).toMatchObject({ kind: "source", color: "#00ff00" });
  });
});

describe("hueHex", () => {
  it("is a stable #rrggbb", () => {
    expect(hueHex("ada")).toMatch(/^#[0-9a-f]{6}$/);
    expect(hueHex("ada")).toBe(hueHex("ada"));
    expect(hueHex("ada")).not.toBe(hueHex("bob"));
  });
});

describe("editing the book", () => {
  const zh = { human: "人", ai: "AI", source: "来源" } as const;
  const book = "# 署名簿\n\n- @ada: Ada · 人 · #3b82f6\n- @bob: Bob (id) · 人\r\n- @c: 《书》 · 来源\n";

  it("adds an author at the end, on its own line", () => {
    expect(addBookAuthor("- @c: X\n", { key: "d", name: "Dee", kind: "ai" }, zh)).toBe("- @c: X\n- @d: Dee · AI\n");
    expect(addBookAuthor("- @c: X\r\n", { key: "d", name: "Dee", kind: "ai" }, zh)).toBe("- @c: X\r\n- @d: Dee · AI\r\n");
    expect(addBookAuthor("# x", { key: "d", name: "Dee", kind: "human", color: "#111111" }, zh)).toBe("# x\n- @d: Dee · 人 · #111111\n");
  });

  it("changes the name and kind and keeps the model ID and colour", () => {
    const b = "- @ada: Ada (m-1) · AI · #3b82f6\n";
    expect(updateBookAuthor(b, "ada", { name: "Ada L." }, zh)).toBe("- @ada: Ada L. (m-1) · AI · #3b82f6\n");
    expect(updateBookAuthor(b, "ada", { kind: "human" }, zh)).toBe("- @ada: Ada (m-1) · 人 · #3b82f6\n");
    expect(updateBookAuthor(book, "bob", { name: "Rob" }, zh)).toContain("- @bob: Rob (id) · 人\r\n");
    expect(updateBookAuthor(book, "nobody", { name: "x" }, zh)).toBe(book);
  });

  it("does not let a name break its own line", () => {
    const out = updateBookAuthor(book, "ada", { name: "A · B" }, zh);
    expect(parseBook(out).ada).toMatchObject({ name: "A B", kind: "human", color: "#3b82f6" });
  });

  it("removes one author", () => {
    expect(removeBookAuthor(book, "ada")).toBe(book.replace("- @ada: Ada · 人 · #3b82f6\n", ""));
    expect(removeBookAuthor(book, "nobody")).toBe(book);
  });

  it("makes a key from a name", () => {
    expect(keyFromName(" Ada  Example ")).toBe("ada-example");
    expect(keyFromName("「书」[x]")).toBe("书x");
  });
});
