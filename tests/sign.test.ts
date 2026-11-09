import { describe, expect, it } from "vitest";
import { signRevision } from "../src/core";

const MODEL = "claude-opus-5-5";
const sign = (original: string, revised: string) => signRevision(original, revised, MODEL);

describe("signRevision", () => {
  it("marks only the changed words", () => {
    const r = sign("I has a apple.", "I have an apple.");
    expect(r.text).toBe(`I &&have an&&[@${MODEL}] apple.`);
    // Counted as paste revision counts: two words, two places.
    expect(r.changed).toBe(2);
    expect(r.unmarked).toEqual([]);
  });

  it("marks without a model when none is given", () => {
    expect(signRevision("我喜欢苹果", "我很喜欢苹果").text).toBe("我&&很&&喜欢苹果");
  });

  it("keeps other models' keys and the author's islands", () => {
    expect(sign("Mine, &&theirs&&[@gpt-5] and more.", "Mine, theirs and much more.").text).toBe(
      `Mine, &&theirs&&[@gpt-5] and &&much&&[@${MODEL}] more.`,
    );
    const block = "&& GPT (gpt-5)\n\nAI text with @@my words@@ here.\n\n&&\n";
    // The revision dropped the island's markers; the words were kept, so they stay the author's.
    expect(sign(block, block.replace("@@my words@@ here", "my words there")).text).toBe(block.replace("here", "there"));
  });

  it("leaves markers the revision kept, and lines it did not touch, as they are", () => {
    const original = "One @@odd@@ @@spacing@@ &&x&&[@gpt-5].\n\nA &&b&&[@gpt-5] c\n";
    const revised = "One @@odd@@ @@spacing@@ &&x&&[@gpt-5].\n\nA &&b&&[@gpt-5] c d\n";
    expect(sign(original, revised).text).toBe(`One @@odd@@ @@spacing@@ &&x&&[@gpt-5].\n\nA &&b&&[@gpt-5] c &&d&&[@${MODEL}]\n`);
  });

  it("puts right a mark the revision got wrong", () => {
    expect(sign("Plain words.", "Plain &&words&&[@gpt-5].").text).toBe("Plain words.");
    expect(sign("Plain words.", "Plain &&new&& words.").text).toBe(`Plain &&new&&[@${MODEL}] words.`);
  });

  it("marks a new line, and ignores what is not text", () => {
    const original = "---\ntitle: a\n---\nA line.\n";
    const revised = "---\ntitle: b\n---\nA line.\n\nAnother line.\n\n@fakebook: A Book That Does Not Exist · source\n";
    expect(sign(original, revised).text).toBe(
      `---\ntitle: b\n---\nA line.\n\n&&Another line.&&[@${MODEL}]\n\n@fakebook: A Book That Does Not Exist · source\n`,
    );
  });

  it("needs no marks for its own words in an AI block", () => {
    const block = `&& Claude (${MODEL})\n\nSome text.\n\n&&\n`;
    const revised = block.replace("Some text.", "Some better text.");
    expect(sign(block, revised)).toEqual({ text: revised, changed: 1, unmarked: [], foreign: [], tasks: [] });
  });

  it("reports its words in a block another model signed, which count as that model's", () => {
    const block = "&& GPT (gpt-5)\n\nSome text.\n\n&&\n";
    const revised = block.replace("Some text.", "Some better text.");
    expect(sign(block, revised)).toEqual({ text: revised, changed: 1, unmarked: [], foreign: [2], tasks: [] });
    // Without a model there is no telling.
    expect(signRevision(block, revised).foreign).toEqual([]);
  });

  it("reports changed lines it cannot mark and leaves them as written", () => {
    const r = sign('She said "hello"[@fakebook].\n', 'She said "hello"[@fakebook] twice.\n');
    expect(r.text).toBe('She said "hello"[@fakebook] twice.\n');
    expect(r.unmarked).toEqual([0]);
    const code = sign("```js\nlet a = 1\n```\n", "```js\nlet a = 2\n```\n");
    expect(code.unmarked).toEqual([1]);
  });

  it("keeps a long note cheap when the edits are far apart", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `第${i}行，这是一句足够长的中文，用来把整篇的字数撑到上万。`);
    const original = lines.join("\n\n") + "\n";
    const revised = original.replace("第0行", "第零行").replace("第399行", "第三九九行");
    const t0 = Date.now();
    const r = sign(original, revised);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.changed).toBe(2);
    expect(r.text.startsWith(`第&&零&&[@${MODEL}]行`)).toBe(true);
    expect(r.text.includes(`第&&三九九&&[@${MODEL}]行`)).toBe(true);
  });
});
