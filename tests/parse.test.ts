import { describe, expect, it } from "vitest";
import { familyOf, parse, signatureFamily, stripMarkers } from "../src/core";
import { codes, marks, owners } from "./helpers";

describe("inline markers", () => {
  it("marks inline AI text", () => {
    expect(owners("人写的。&&这句是 AI 写的&&，又回到人。")).toEqual([
      "H:人写的。",
      "A:这句是 AI 写的",
      "H:，又回到人。",
    ]);
  });

  it("leaves unclosed markers literal", () => {
    expect(owners("只有一个 &&没闭合")).toEqual(["H:只有一个 &&没闭合"]);
    expect(marks("只有一个 &&没闭合")).toEqual([]);
  });

  it("only recognises exactly two characters", () => {
    expect(owners("&&&三个&&&")).toEqual(["H:&&&三个&&&"]);
    expect(owners("a &&&& b &&&& c")).toEqual(["H:a &&&& b &&&& c"]);
  });

  it("@@ is literal in human regions", () => {
    expect(owners("人写的 @@也是人@@")).toEqual(["H:人写的 @@也是人@@"]);
  });

  it("allows @@ islands inside inline AI", () => {
    expect(owners("前&&AI@@人@@AI&&后")).toEqual(["H:前", "A:AI", "h:人", "A:AI", "H:后"]);
  });

  it("keeps the later-opened crossing pair literal", () => {
    expect(owners("&&甲@@乙&&丙@@")).toEqual(["A:甲@@乙", "H:丙@@"]);
  });

  it("pairs left to right regardless of neighbours (no flanking rules)", () => {
    expect(owners("说&&「我」&&是")).toEqual(["H:说", "A:「我」", "H:是"]);
    expect(owners("这是&&**AI 加粗的字**&&哦")).toEqual(["H:这是", "A:**AI 加粗的字**", "H:哦"]);
  });

  it("supports backslash escapes", () => {
    expect(owners("\\&&不是标记&&")).toEqual(["H:\\&&不是标记&&"]);
    expect(owners("&&甲\\&&乙&&")).toEqual(["A:甲\\&&乙"]);
  });

  it("lets HTML entities win", () => {
    expect(owners("a &&amp; b")).toEqual(["H:a &&amp; b"]);
  });

  it("ignores single @ and &", () => {
    expect(owners("mail me at a@b.com & @someone")).toEqual(["H:mail me at a@b.com & @someone"]);
  });

  it("attaches [@key] right after a closing marker", () => {
    expect(owners("&&模型写的&&[@gpt]。")).toEqual(["A@gpt:模型写的", "H:。"]);
    expect(owners("&&模型写的&& [@gpt]。")).toEqual(["A@gpt:模型写的", "H: 。"]);
    expect(marks("&&x&&[@gpt]")).toEqual(["open:&&", "close:&&", "cite:[@gpt]"]);
  });
});

describe("blocks", () => {
  const doc = ["前言", "", "&& Claude (claude-opus-5-5)", "", "AI 写的，@@人补的@@，&&不是标记&&。", "", "&&", "", "后记"].join("\n");

  it("parses a signed block", () => {
    const r = parse(doc);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].signature).toEqual({ raw: "Claude (claude-opus-5-5)", name: "Claude", id: "claude-opus-5-5" });
    expect(r.blocks[0].openLine).toBe(2);
    expect(r.blocks[0].closeLine).toBe(6);
    expect(owners(r)).toEqual(["H:前言", "A:AI 写的，", "h:人补的", "A:，&&不是标记&&。", "H:后记"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("accepts full-width parentheses and id-only signatures", () => {
    expect(parse("&& 助手（gpt-5）\n\nx\n\n&&").blocks[0].signature).toMatchObject({ name: "助手", id: "gpt-5" });
    expect(parse("&& (gemini-3-pro)\n\nx\n\n&&").blocks[0].signature).toMatchObject({ id: "gemini-3-pro" });
    expect(parse("&& AI\n\nx\n\n&&").blocks[0].signature).toMatchObject({ name: "AI" });
  });

  it("knows Muse by its model IDs and name, not by words that start the same", () => {
    for (const id of ["muse-spark-1.3", "muse-spark-1.2-contributor", "muse-wonder-1.0", "muse-image-1.0", "Muse", "Muse 助手"]) {
      expect(familyOf(id)?.id, id).toBe("muse");
    }
    for (const word of ["museum", "musetalk", "Museum 导览"]) expect(familyOf(word), word).toBeNull();
    // The other families match as before.
    expect(["llama-4-maverick", "o3-mini", "ollama", "glm-5"].map((s) => familyOf(s)?.id ?? null)).toEqual(["llama", "gpt", null, "glm"]);
  });

  it("credits a Muse block to its family and name", () => {
    const r = parse("&& Muse (muse-spark-1.3)\n\n四个字的\n\n&&");
    expect(signatureFamily(r.blocks[0].signature)?.id).toBe("muse");
    expect(r.stats.aiByAuthor).toEqual({ Muse: 4 });
  });

  it("treats `&& text &&` and `&&text` as inline, not blocks", () => {
    expect(parse("&& 一句话 &&").blocks).toHaveLength(0);
    expect(owners("&& 一句话 &&")).toEqual(["A: 一句话 "]);
    expect(parse("&&一句话\n\nx\n\n&&").blocks).toHaveLength(0);
  });

  it("closes the previous block on a new opener and warns", () => {
    const r = parse("&& Claude\n\n甲\n\n&& GPT\n\n乙\n\n&&");
    expect(r.blocks.map((b) => [b.signature.name, b.closeLine])).toEqual([
      ["Claude", null],
      ["GPT", 8],
    ]);
    expect(codes("&& Claude\n\n甲\n\n&& GPT\n\n乙\n\n&&")).toEqual(["implicit-close"]);
  });

  it("shows a lone closer literally and warns", () => {
    expect(owners("人\n\n&&\n\n人")).toEqual(["H:人&&人"]);
    expect(codes("人\n\n&&\n\n人")).toEqual(["lone-closer"]);
  });

  it("leaves an unclosed opener literal", () => {
    const r = parse("&& Claude\n\n没有结尾 @@x@@");
    expect(r.blocks).toHaveLength(0);
    expect(owners(r)).toEqual(["H:&& Claude没有结尾 @@x@@"]);
    expect(codes("&& Claude\n\n没有结尾")).toEqual(["unclosed-block"]);
  });

  it("requires blank lines around block lines", () => {
    expect(codes("| a |\n&& Claude\n\nx\n\n&&")).toEqual(["blank-line"]);
    expect(codes("&& Claude\nx\n&&")).toEqual(["blank-line", "blank-line"]);
  });

  it("lets an opener sit right below the frontmatter, but nowhere else", () => {
    expect(codes("---\ntitle: 示例\n---\n&& Claude\n\nx\n\n&&")).toEqual([]);
    expect(codes("---\ntitle: 示例\n---\n&& Claude\nx\n\n&&")).toEqual(["blank-line"]);
    expect(codes("---\ntitle: 示例\n---\n人写的\n&& Claude\n\nx\n\n&&")).toEqual(["blank-line"]);
    expect(codes("| a |\n| - |\n&& Claude\n\nx\n\n&&")).toEqual(["blank-line"]);
    // Without frontmatter an opener on the first line has nothing above it.
    expect(codes("&& Claude\n\nx\n\n&&")).toEqual([]);
  });

  it("counts code inside a block as AI", () => {
    const r = parse("&& Claude\n\n```js\nif (a && b) {}\n```\n\n&&");
    expect(owners(r)).toEqual(["A:if (a && b) {}"]);
  });
});

describe("quotes", () => {
  it("attributes corner-bracket quotes", () => {
    expect(owners("书上说「纸短情长」[@fakebook]，我同意。")).toEqual([
      "H:书上说「",
      "Q@fakebook:纸短情长",
      "H:」，我同意。",
    ]);
  });

  it("attributes straight and curly quotes, with one optional space", () => {
    expect(owners('He said "less is more" [@mies].')).toEqual(["H:He said \"", "Q@mies:less is more", "H:\" ."]);
    expect(owners("“引文”[@a]")).toEqual(["H:“", "Q@a:引文", "H:”"]);
  });

  it("does not attribute with two spaces or after plain text", () => {
    expect(owners("「引文」  [@a]")).toEqual(["H:「引文」  [@a]"]);
    expect(owners("普通引用 [@a]")).toEqual(["H:普通引用 [@a]"]);
  });

  it("ignores links and link definitions", () => {
    expect(owners("「x」[@a](http://e.com)")).toEqual(["H:「x」[@a](http://e.com)"]);
    expect(owners("「x」[@a]: def")).toEqual(["H:「x」[@a]: def"]);
  });

  it("activates both markers inside quotes", () => {
    expect(owners("「原文@@改@@原文&&补&&」[@a]")).toEqual([
      "H:「",
      "Q@a:原文",
      "h:改",
      "Q@a:原文",
      "A:补",
      "H:」",
    ]);
  });

  it("works inside AI blocks", () => {
    expect(owners('&& Claude\n\n引一句 "avoid it"[@x]。\n\n&&')).toEqual(['A:引一句 "', "Q@x:avoid it", 'A:"。']);
  });

  it("attributes cited blockquotes", () => {
    const r = parse("> 第一行\n> 第二行\n> [@fakebook]\n\n后面");
    expect(owners(r)).toEqual(["Q@fakebook:第一行第二行", "H:后面"]);
  });

  it("leaves normal blockquotes alone", () => {
    expect(owners("> 普通引用块\n> 第二行")).toEqual(["H:普通引用块第二行"]);
  });
});

describe("skipped regions", () => {
  it("skips undeclared code blocks, including in callouts and with tildes", () => {
    expect(owners("```js\na && b\n```")).toEqual(["H:a && b"]);
    expect(owners("~~~~\n&&x&&\n~~~\n&&y&&\n~~~~")).toEqual(["H:&&x&&~~~&&y&&"]);
    expect(owners("> [!note]\n> ```\n> &&x&&\n> ```")).toEqual(["H:[!note]> &&x&&"]);
  });

  it("warns about unclosed fences", () => {
    expect(codes("```\n&&x&&")).toEqual(["unclosed-fence"]);
  });

  it("skips inline code by backtick count", () => {
    expect(owners("`a && b` 和 ``x ` &&y&& ``")).toEqual(["H:`a && b` 和 ``x ` &&y&& ``"]);
    expect(owners("`没闭合 &&AI&&")).toEqual(["H:`没闭合 ", "A:AI"]);
  });

  it("supports declared markers in code", () => {
    const src = "&& Claude\n\n```ts @@\nlet count = @@0@@\n```\n\n&&";
    expect(owners(src)).toEqual(["A:let count = ", "h:0"]);
    expect(marks(src)).toContain("decl:@@");
  });

  it("uses the declared length only", () => {
    expect(owners("```c &&&\nif (a && b) return &&&fallback()&&&;\n```")).toEqual([
      "H:if (a && b) return ",
      "A:fallback()",
      "H:;",
    ]);
  });

  it("hides declared runs that have nothing to mark, without changing owners", () => {
    // `&&&` in an AI block, `@@` in human text: still markers, as the declaration says.
    const ai = "&& Claude\n\n```c &&&\nif (a && b) return &&&fallback()&&&;\n```\n\n&&";
    expect(owners(ai)).toEqual(["A:if (a && b) return fallback();"]);
    expect(stripMarkers(parse(ai)).text).toBe("```c\nif (a && b) return fallback();\n```\n\n");
    expect(owners("```ts @@\nlet a = @@0@@\n```")).toEqual(["H:let a = 0"]);
  });

  it("keeps idle runs literal inside an island, and a lone one too", () => {
    const src = "&& C\n\n```ts @@ &&&\nx @@a &&&b&&& c@@ &&&d @@e@@ f&&& &&&g\n```\n\n&&";
    expect(stripMarkers(parse(src)).text).toBe("```ts\nx a &&&b&&& c d e f &&&g\n```\n\n");
    expect(owners(src)).toEqual(["A:x ", "h:a &&&b&&& c", "A: d ", "h:e", "A: f &&&g"]);
  });

  it("skips inline math and warns when it swallows markers", () => {
    expect(owners("$x && y$ 外面")).toEqual(["H:$x && y$ 外面"]);
    const money = "约 $3.8 万，&&按汇率粗算&& ¥156/$";
    expect(owners(money)).toEqual([`H:${money}`]);
    expect(codes(money)).toEqual(["math-swallow"]);
    expect(owners("约 $3.8 万，&&按汇率粗算&& ¥156/\\$")).toEqual(["H:约 $3.8 万，", "A:按汇率粗算", "H: ¥156/\\$"]);
  });

  it("does not treat amounts as math (Pandoc rules)", () => {
    expect(owners("花了 $5 和 $6，&&AI&&")).toEqual(["H:花了 $5 和 $6，", "A:AI"]);
    expect(owners("$ 3 和 4$ &&AI&&")).toEqual(["H:$ 3 和 4$ ", "A:AI"]);
  });

  it("skips display math blocks", () => {
    expect(owners("$$\nx &&= 1 && y\n$$\n&&AI&&")).toEqual(["H:$$x &&= 1 && y$$", "A:AI"]);
  });

  it("hides comments, including multi-line ones", () => {
    expect(owners("前%%&&x&&%%后")).toEqual(["H:前后"]);
    expect(owners("前 %%\n&& Claude\n%% 后 &&AI&&")).toEqual(["H:前  后 ", "A:AI"]);
    expect(parse("前 %%\n&& Claude\n%% 后").blocks).toHaveLength(0);
  });

  it("skips URLs", () => {
    expect(owners("见 https://e.com/?a&&b=1 和 [链接](https://e.com/?x&&y) &&AI&&")).toEqual([
      "H:见 https://e.com/?a&&b=1 和 [链接](https://e.com/?x&&y) ",
      "A:AI",
    ]);
  });

  it("skips frontmatter", () => {
    expect(owners("---\ntitle: &&x&&\n---\n正文")).toEqual(["H:正文"]);
  });

  it("skips the iA annotation block", () => {
    expect(owners("正文 &&AI&&\n\n---\nAnnotations: 0,4 SHA-256 abc\n&: 1,2\n...")).toEqual(["H:正文 ", "A:AI"]);
  });

  it("reads trailing definitions", () => {
    const r = parse("正文 &&x&&[@opus]\n\n@opus: Claude (claude-opus-5-5)\n@book: 《假书》\n");
    expect(r.definitions).toEqual({ opus: "Claude (claude-opus-5-5)", book: "《假书》" });
    expect(owners(r)).toEqual(["H:正文 ", "A@opus:x"]);
  });
});

describe("conflict table leftovers", () => {
  it("is safe with diff hunks and SQL variables in human text", () => {
    expect(owners("@@ -1,3 +1,4 @@ 和 @@ROWCOUNT")).toEqual(["H:@@ -1,3 +1,4 @@ 和 @@ROWCOUNT"]);
  });

  it("leaves a single @@ in AI regions literal", () => {
    expect(owners("&& GPT\n\nSELECT @@ROWCOUNT;\n\n&&")).toEqual(["A:SELECT @@ROWCOUNT;"]);
  });

  it("does not clash with Obsidian syntax", () => {
    expect(owners("见 [[笔记#标题]] ^abc #tag")).toEqual(["H:见 [[笔记#标题]] ^abc #tag"]);
  });
});

describe("stats", () => {
  it("counts code points by owner, ignoring marks and whitespace", () => {
    const r = parse("人写&&AI&&[@gpt]\n\n&& Claude (claude-opus-5-5)\n\n块里@@人@@\n\n&&\n\n「引」[@a]");
    expect(r.stats.human).toBe(2 + 1 + 2); // 人写 + 人 + 「」
    expect(r.stats.ai).toBe(2 + 2);
    expect(r.stats.quote).toBe(1);
    expect(r.stats.aiByAuthor).toEqual({ "@gpt": 2, Claude: 2 });
    expect(r.stats.quoteByKey).toEqual({ a: 1 });
  });

  it("counts surrogate pairs once", () => {
    expect(parse("😀&&😀&&").stats).toMatchObject({ human: 1, ai: 1 });
  });
});
