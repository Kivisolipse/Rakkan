import { describe, expect, it } from "vitest";
import { parse, Parser } from "../src/core";

// Small deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const PIECES = [
  "&&", "@@", "&& Claude (claude-opus-5-5)", "\n", "\n\n", "```", "```ts @@", "~~~", "$", "$$",
  "%%", "「", "」", "[@k]", '"', "`", "> ", "\\", "人", "AI", " ", "&&&", "---\n", "@k: def",
];

describe("memoised parser", () => {
  it("matches a fresh parse after random edits", () => {
    const rand = rng(42);
    const parser = new Parser();
    let doc = "前言\n\n&& Claude\n\n块里 @@人@@\n\n&&\n\n后记 &&AI&&";
    for (let step = 0; step < 1500; step++) {
      const pos = Math.floor(rand() * (doc.length + 1));
      if (rand() < 0.3 && doc.length > 0) {
        const len = Math.ceil(rand() * 6);
        doc = doc.slice(0, pos) + doc.slice(pos + len);
      } else {
        const piece = PIECES[Math.floor(rand() * PIECES.length)];
        doc = doc.slice(0, pos) + piece + doc.slice(pos);
      }
      if (doc.length > 600) doc = doc.slice(0, 300);
      const a = parser.parse(doc);
      const b = parse(doc);
      expect({ ...a, step }).toEqual({ ...b, step });
    }
  });

  it("parses ten thousand lines quickly", () => {
    const para = "人写的字，&&AI 写的字&&[@gpt]，「引文」[@a]。\n\n&& Claude\n\n块里 @@人@@ 和 `code && x`\n\n&&\n\n";
    const doc = para.repeat(1250); // 10k lines
    const parser = new Parser();
    let t = performance.now();
    parser.parse(doc);
    const cold = performance.now() - t;
    const edited = doc.slice(0, 5000) + "新" + doc.slice(5000);
    t = performance.now();
    parser.parse(edited);
    const warm = performance.now() - t;
    expect(cold).toBeLessThan(2000);
    expect(warm).toBeLessThan(cold);
  });
});
