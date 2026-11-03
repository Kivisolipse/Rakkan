import { describe, expect, it } from "vitest";
import { lint, parse, parseBook } from "../src/core";

/** `line:code:text` for every problem; `line` counts from 1. */
function problems(src: string, book = ""): string[] {
  const r = parse(src);
  return lint(r, parseBook(book), [{ prefix: "house-", family: "house" }]).map(
    (i) => `${i.line + 1}:${i.code}:${src.slice(i.from, i.to)}`,
  );
}

describe("lint", () => {
  it("passes a note signed as the skill says", () => {
    const note = [
      "---",
      "title: t",
      "---",
      "&& Claude (claude-opus-5-5)",
      "",
      "A paragraph with @@the author's words@@ and \"a quote\"[@fakebook].",
      "",
      "&&",
      "",
      "The author's sentence, with &&a few words&&[@claude-opus-5-5] in it, and \\&& and `x && y`.",
      "",
      "> A passage.",
      "> [@fakebook]",
      "",
      "@fakebook: A Book That Does Not Exist · source",
    ].join("\n");
    expect(problems(note)).toEqual([]);
  });

  it("keeps the parser's warnings", () => {
    expect(problems("&& Claude\n\nnever closed\n")).toEqual(["1:unclosed-block:&& Claude"]);
  });

  it("finds a marker without a partner, once", () => {
    expect(problems("one &&two\nthree&& four")).toEqual(["1:unpaired-marker:&&", "2:unpaired-marker:&&"]);
    // Prose that means the characters escapes them.
    expect(problems("a && b")).toEqual(["1:unpaired-marker:&&"]);
    expect(problems("&&AI words with @@an island&&")).toEqual(["1:unpaired-marker:@@"]);
    // The parser already warns about a closer with no opener.
    expect(problems("text\n\n&&\n").map((p) => p.split(":")[1])).toEqual(["lone-closer"]);
  });

  it("finds markers that do nothing where they are", () => {
    expect(problems("&& AI\n\nan &&inline&& mark in a block\n\n&&\n")).toEqual([
      "3:inert-marker:&&",
      "3:inert-marker:&&",
    ]);
    expect(problems("human text with @@an island@@")).toEqual(["1:inert-marker:@@", "1:inert-marker:@@"]);
    expect(problems("&&A@@B&&C@@")).toEqual(["1:unpaired-marker:@@", "1:inert-marker:@@"]);
  });

  it("finds keys that nothing defines", () => {
    expect(problems('"a"[@nobody] and "b"[@nobody]')).toEqual(["1:unknown-key:[@nobody]"]);
    expect(problems("> a\n> [@nobody]")).toEqual(["2:unknown-key:[@nobody]"]);
    expect(problems('"a"[@ada]', "- @ada: Ada Example · human")).toEqual([]);
    expect(problems('"a"[@ada]\n\n@ada: Ada Example · human')).toEqual([]);
  });

  it("knows an AI by its model ID alone", () => {
    expect(problems("&&a&&[@gpt-5] &&b&&[@house-7] &&c&&[@mystery]")).toEqual(["1:unknown-key:[@mystery]"]);
    // A model ID names an AI, not a source.
    expect(problems('"a"[@claude-opus-5-5]')).toEqual(["1:unknown-key:[@claude-opus-5-5]"]);
  });
});
