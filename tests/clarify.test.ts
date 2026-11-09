// Clarify quote: the person settles a quote, and the answer is written into the note as markers.

import { describe, expect, it } from "vitest";
import { clarifications, clarifyOptions, clarifyQuote, insertQuote, lint, nextMixedQuote, parse, quoteAt, quotesOf, signRevision, type Clarification } from "../src/core";
import { owners } from "./helpers";

/** `text` with the quote at `at` clarified as `how`. */
function clarify(text: string, at: string, how: Clarification, blockOpener?: string): string {
  const r = parse(text);
  const q = quoteAt(r, text.indexOf(at));
  if (!q) throw new Error("no quote there");
  const c = clarifyQuote(r, q, how, { blockOpener });
  if (!c) throw new Error(`can't clarify as ${how}`);
  return text.slice(0, c.from) + c.insert + text.slice(c.to);
}

/** Signing the clarified note again, with nothing changed, leaves it as it is. */
const stable = (text: string) => expect(signRevision(text, text, "m").text).toBe(text);

const MIXED = "前&&@@「@@模型的话@@」[@x]@@&&后";

describe("a quote whose parts have different writers", () => {
  it("is reported by the parser and by lint, as mixed-quote", () => {
    const r = parse(MIXED);
    expect(r.diagnostics.map((d) => [d.code, MIXED.slice(d.from, d.to)])).toEqual([["mixed-quote", "「@@模型的话@@」[@x]"]]);
    expect(lint(r, { x: { key: "x", kind: "human" } }).map((i) => i.code)).toEqual(["mixed-quote"]);
    // A quote with one writer is not.
    expect(parse("我引「原话」[@x]，&&模型说「新话」[@y]&&").diagnostics).toEqual([]);
  });

  it("is found by Go to next unclarified quote, from the top again past the last", () => {
    const text = `${MIXED}\n\n我引「原话」[@y]\n\n${MIXED}`;
    const r = parse(text);
    const first = nextMixedQuote(r, 0)!;
    const second = nextMixedQuote(r, first.from)!;
    expect(second.from).toBeGreaterThan(first.from);
    expect(nextMixedQuote(r, second.from)!.from).toBe(first.from);
    expect(nextMixedQuote(parse("我引「原话」[@y]"), 0)).toBeNull();
  });
});

/** The choices offered for the quote of `text` that is exactly `quote`, or why there are none. */
function offered(text: string, quote: string) {
  const r = parse(text);
  const q = quotesOf(r).find((x) => text.slice(x.from, x.to) === quote);
  if (!q) throw new Error("no such quote");
  const o = clarifyOptions(r, q);
  return o.refusal ?? o.choices.map((c) => c.how);
}

/** `doc` with `quoted` pasted at `|` as Paste as quote does it, the cursor shown as `|`. */
function paste(doc: string, quoted: string): string {
  const at = doc.indexOf("|");
  const d = doc.replace("|", "");
  const c = insertQuote(d, at, at, quoted, { blockOpener: "Claude" });
  const next = d.slice(0, c.from) + c.insert + d.slice(c.to);
  return next.slice(0, c.cursor) + "|" + next.slice(c.cursor);
}

describe("Paste as quote", () => {
  it("writes a quote the person gives in AI text as confirmed, not as the model's citation", () => {
    const inline = paste("&& Claude\n\n模型说|然后\n\n&&", "「原话」[@x]");
    expect(inline).toBe("&& Claude\n\n模型说@@「原话」[@x]@@|然后\n\n&&");
    // The words are the source's, as a quote the person gives; without the island they would be the model's.
    expect(owners(inline.replace("|", ""))).toContain("Q@x:原话");
    expect(parse(inline.replace("|", "")).claims).toEqual([]);
    expect(paste("&&模型说|然后&&[@m]", "「原话」[@x]")).toBe("&&模型说@@「原话」[@x]@@|然后&&[@m]");
  });

  it("moves a blockquote the person gives out of the AI block, which goes on after it", () => {
    const out = paste("&& Claude\n\n前文\n\n|后文\n\n&&", "> 原话\n> [@x]\n");
    expect(out.replace("|", "")).toBe("&& Claude\n\n前文\n\n&&\n\n> 原话\n> [@x]\n\n&& Claude\n\n后文\n\n&&");
    expect(parse(out.replace("|", "")).claims).toEqual([]);
  });

  it("leaves a quote in the person's own text as it is", () => {
    expect(paste("我说|然后", "「原话」[@x]")).toBe("我说「原话」[@x]|然后");
  });
});

describe("the Clarify quote menu", () => {
  it("offers only the choices that can be written", () => {
    expect(offered("我引「原话」[@x]", "「原话」[@x]")).toEqual(["confirm", "ai", "remove"]);
    expect(offered(MIXED, "「@@模型的话@@」[@x]")).toEqual(["confirm", "ai", "remove", "human"]);
    // A claim right behind the quote's cite: as the model's citation the two would run together.
    expect(offered("「原」[@x][@m]", "「原」[@x]")).toEqual(["confirm", "remove"]);
  });

  it("says why, when none can", () => {
    expect(offered("@@“@@&&@@” [@x]模型@@&&", "“@@&&@@” [@x]")).toBe("unpaired-marker");
    expect(offered("「「」[@x]话」[@m]", "「」[@x]")).toBe("other");
  });
});

describe("Clarify quote", () => {
  it("offers a human island only in an AI region", () => {
    expect(clarifications(quoteAt(parse("我引「原话」[@x]"), 3)!)).toEqual(["confirm", "ai", "remove"]);
    expect(clarifications(quoteAt(parse(MIXED), 6)!)).toEqual(["confirm", "ai", "remove", "human"]);
    expect(clarifications(quoteAt(parse("&& AI\n\n模型说「新话」[@x]\n\n&&"), 12)!)).toEqual(["confirm", "ai", "remove", "human"]);
  });

  it("a: confirms a quote from its source, written by the person", () => {
    const n = clarify(MIXED, "模型", "confirm");
    expect(n).toBe("前「模型的话」[@x]后");
    expect(owners(n)).toEqual(["H:前「", "Q@x:模型的话", "H:」后"]);
    expect(parse(n).diagnostics).toEqual([]);
    stable(n);
    // In an AI block, the quote goes in a human island.
    const b = clarify("&& AI\n\n模型说「新话」[@x]完\n\n&&", "新话", "confirm");
    expect(owners(b)).toEqual(["A:模型说", "h:「", "Q@x:新话", "h:」", "A:完"]);
    stable(b);
  });

  it("b: marks it as the model's citation, the claim kept", () => {
    const n = clarify(MIXED, "模型", "ai");
    expect(n).toBe("前&&「模型的话」[@x]&&后");
    expect(owners(n)).toEqual(["H:前", "A:「模型的话」", "H:后"]);
    expect(parse(n).claims.map((c) => [n.slice(c.from, c.to), c.key])).toEqual([["模型的话", "x"]]);
    stable(n);
    // The model's key stays when it was known.
    expect(clarify("我引「原 &&改&&[@m] 话」[@x]。", "原", "ai")).toBe("我引&&「原 改 话」[@x]&&[@m]。");
  });

  it("c: removes the quote markup, every word keeping who typed it", () => {
    const n = clarify(MIXED, "模型", "remove");
    expect(n).toBe("前&&模型的话&&后");
    expect(owners(n)).toEqual(["H:前", "A:模型的话", "H:后"]);
    stable(n);
    // The person's words stay theirs, the model's words in it the model's.
    const h = clarify("我引「原 &&改&& 话」[@x]。", "原", "remove");
    expect(owners(h)).toEqual(["H:我引原 ", "A:改", "H: 话。"]);
    stable(h);
  });

  it("d: removes the quote markup and marks the words as an explicit human island", () => {
    const n = clarify(MIXED, "模型", "human");
    expect(n).toBe("前&&@@模型的话@@&&后");
    expect(owners(n)).toEqual(["H:前", "h:模型的话", "H:后"]);
    stable(n);
    const b = clarify("&& AI\n\n模型说「新话」[@x]完\n\n&&", "新话", "human");
    expect(owners(b)).toEqual(["A:模型说", "h:新话", "A:完"]);
    stable(b);
  });

  it("leaves the rest of the line alone, islands in other AI spans included", () => {
    const text = "前&&模型@@补「原话」[@x]@@尾&&[@m]，&&另@@岛@@&&";
    for (const how of ["confirm", "ai", "remove", "human"] as const) {
      const n = clarify(text, "原话", how);
      const o = owners(n);
      expect(o.slice(0, 2)).toEqual(["H:前", "A@m:模型"]);
      expect(o.slice(-3)).toEqual(["H:，", "A:另", "h:岛"]);
      stable(n);
    }
  });

  it("escapes a lone pair of markers the new ones would pair with, and writes no block line", () => {
    const a = clarify("&&前「原」[@x]", "原", "ai");
    expect(a).toBe("\\&&前&&「原」[@x]&&");
    expect(owners(a)).toEqual(["H:\\&&前", "A:「原」"]);
    stable(a);
    const b = clarify("&& AI\n\n@@前「原」[@x]\n\n&&", "原", "confirm");
    expect(b).toBe("&& AI\n\n\\@@前@@「原」[@x]@@\n\n&&");
    expect(owners(b)).toEqual(["A:\\@@前", "h:「", "Q@x:原", "h:」"]);
    stable(b);
    expect(owners(clarify("&& AI\n\n@@前「原」[@x]\n\n&&", "原", "human"))).toEqual(["A:\\@@前", "h:原"]);
    // The words `&&` alone on a line would close the block.
    const c = clarify("&& AI\n\n「&&」[@x]\n\n&&", "&&」", "remove");
    expect(c).toBe("&& AI\n\n\\&&\n\n&&");
    expect(owners(c)).toEqual(["A:\\&&"]);
    // Shows nothing that was not there.
    const r = parse("&&@@ @@「」[@x]&&");
    const d = clarifyQuote(r, quoteAt(r, 8)!, "confirm");
    if (d) expect(owners(r.text.slice(0, d.from) + d.insert + r.text.slice(d.to)).join("")).not.toContain("@@");
  });

  describe("a cited blockquote", () => {
    const human = "前文\n\n> 第一 &&改&& 行\n> 第二 @@人@@ 行\n> [@x]\n\n后文";
    const inBlock = "&& AI\n\n模型的话\n\n> 第一 @@人@@ 行\n> - 第二行\n> [@x]\n\n更多\n\n&&";

    it("a: makes every word the source's; in an AI block, the blockquote leaves it", () => {
      expect(owners(clarify(human, "第一", "confirm"))).toEqual(["H:前文", "Q@x:第一 改 行第二 人 行", "H:后文"]);
      const n = clarify(inBlock, "第一", "confirm");
      expect(n).toBe("&& AI\n\n模型的话\n\n&&\n\n> 第一 人 行\n> - 第二行\n> [@x]\n\n&& AI\n\n更多\n\n&&");
      expect(owners(n)).toEqual(["A:模型的话", "Q@x:第一 人 行第二行", "A:更多"]);
      expect(parse(n).diagnostics).toEqual([]);
      stable(n);
      // Alone in its block, the block goes.
      expect(clarify("&& AI\n\n> 第一行\n> [@x]\n\n&&", "第一", "confirm")).toBe("> 第一行\n> [@x]");
    });

    it("b: puts it in an AI block, or takes out the person's islands in one", () => {
      const n = clarify(human, "第一", "ai", "Claude (claude-opus-5-5)");
      expect(n).toBe("前文\n\n&& Claude (claude-opus-5-5)\n\n> 第一 改 行\n> 第二 人 行\n> [@x]\n\n&&\n\n后文");
      expect(owners(n)).toEqual(["H:前文", "A:第一 改 行第二 人 行", "H:后文"]);
      expect(parse(n).claims.map((c) => c.key)).toEqual(["x"]);
      stable(n);
      expect(owners(clarify(inBlock, "第一", "ai"))).toEqual(["A:模型的话第一 人 行第二行更多"]);
    });

    it("c: takes off the blockquote and the [@key] line, every word keeping who typed it", () => {
      const n = clarify(human, "第一", "remove");
      expect(n).toBe("前文\n\n第一 &&改&& 行\n第二 人 行\n\n后文");
      expect(owners(n)).toEqual(["H:前文第一 ", "A:改", "H: 行第二 人 行后文"]);
      stable(n);
      expect(owners(clarify(inBlock, "第一", "remove"))).toEqual(["A:模型的话第一 ", "h:人", "A: 行第二行更多"]);
      // `&&` that opens a span at the start of a line stays a marker.
      expect(clarify("> &&改&&字\n> [@x]", "字", "remove")).toBe("&&改&&字");
    });

    it("d: in an AI block, makes its lines human islands, list markers outside", () => {
      const n = clarify(inBlock, "第一", "human");
      expect(n).toBe("&& AI\n\n模型的话\n\n@@第一 人 行@@\n- @@第二行@@\n\n更多\n\n&&");
      expect(owners(n)).toEqual(["A:模型的话", "h:第一 人 行第二行", "A:更多"]);
      stable(n);
      expect(clarifications(quoteAt(parse(human), human.indexOf("第一"))!)).not.toContain("human");
    });
  });
});
