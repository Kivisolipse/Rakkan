import { describe, expect, it } from "vitest";
import { pasteEdits } from "../src/core";

const humans = (s: string) => "H".repeat(s.length);

describe("pasteEdits", () => {
  it("marks only the changed words", () => {
    const original = "I has a apple.";
    const r = pasteEdits(original, humans(original), "I have an apple.");
    expect(r.plain).toBe("I have an apple.");
    expect(r.owners).toBe("HH" + "AAAA" + "H" + "AA" + "HHHHHHH");
    expect(r.changed).toBe(2);
  });

  it("works on Chinese text, character by character", () => {
    const original = "我喜欢苹果";
    const r = pasteEdits(original, humans(original), "我很喜欢苹果");
    expect(r.plain).toBe("我很喜欢苹果");
    expect(r.owners).toBe("HAHHHH");
    expect(r.changed).toBe(1);
  });

  it("changes nothing when nothing changed", () => {
    const original = "一段没有被改的话。";
    expect(pasteEdits(original, humans(original), original)).toEqual({
      plain: original,
      owners: humans(original),
      changed: 0,
    });
  });

  it("keeps the old owners of what was kept, AI included", () => {
    const original = "甲乙丙丁";
    const r = pasteEdits(original, "HAAH", "甲乙丙戊");
    expect(r.plain).toBe("甲乙丙戊");
    expect(r.owners).toBe("HAAA");
  });

  it("counts replaced words once and drops deleted ones", () => {
    const original = "this is very very good";
    const r = pasteEdits(original, humans(original), "this is good");
    expect(r.plain).toBe("this is good");
    expect(r.owners).toBe(humans("this is good"));
    expect(r.changed).toBe(0);
    const r2 = pasteEdits(original, humans(original), "this is rather great");
    expect(r2.plain).toBe("this is rather great");
    // `rather` and `great` are separated by a space that was kept: two places.
    expect(r2.changed).toBe(2);
  });

  it("ignores a trailing line break the copy added", () => {
    const original = "一句话";
    const r = pasteEdits(original, humans(original), "一句话。\n");
    expect(r.plain).toBe("一句话。");
    expect(r.owners).toBe("HHHA");
  });

  it("keeps line breaks and marks changes line by line", () => {
    const original = "first line\nsecond line";
    const r = pasteEdits(original, humans(original), "first line\nsecond lines\n");
    expect(r.plain).toBe("first line\nsecond lines");
    expect(r.owners.slice(0, 18)).toBe(humans("first line\nsecond "));
    // A word that changed is marked whole.
    expect(r.owners.slice(18)).toBe("AAAAA");
  });

  it("treats a very large rewrite as one change instead of stalling", () => {
    const original = "字".repeat(3000);
    const edited = "词".repeat(3000);
    const t0 = Date.now();
    const r = pasteEdits(original, humans(original), edited);
    expect(r.changed).toBe(1);
    expect(r.owners).toBe("A".repeat(3000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("keeps owners aligned with the text", () => {
    for (const [a, b] of [
      ["abc def", "abc xyz def"],
      ["你好，世界", "你好世界！"],
      ["", "新的"],
      ["旧的", ""],
    ]) {
      const r = pasteEdits(a, humans(a), b);
      expect(r.owners.length).toBe(r.plain.length);
    }
  });
});

// What ends up in the note: the owners from pasteEdits, written back the way pasting does it.
import { parse, pasteEdits as edits, rewriteLine } from "../src/core";

function writeBack(doc: string, line: number, plain: string, owners: string, key?: string): string | null {
  const r = parse(doc);
  const ctx = r.lineContexts[line];
  return rewriteLine(plain, ctx, (chars) => {
    for (const c of chars) {
      c.owner = owners[c.at - ctx.prefix] === "A" ? "ai" : "human";
      if (c.owner === "ai" && key) c.key = key;
      else delete c.key;
    }
  });
}

describe("paste edits end to end", () => {
  it("marks the changed words as AI in a human paragraph, with the model", () => {
    const original = "I has a apple.";
    const res = edits(original, humans(original), "I have an apple.");
    expect(writeBack(original, 0, res.plain, res.owners, "gpt")).toBe("I &&have an&&[@gpt] apple.");
  });

  it("works without naming a model", () => {
    const original = "我喜欢苹果";
    const res = edits(original, humans(original), "我很喜欢苹果");
    expect(writeBack(original, 0, res.plain, res.owners)).toBe("我&&很&&喜欢苹果");
  });

  it("leaves an AI block's own text unmarked and keeps human islands as islands", () => {
    const doc = "&& Claude\n\n甲乙 @@我写的@@ 丙\n\n&&";
    // Plain text of the line, with owners: 甲乙 AI, 我写的 human, 丙 AI.
    const plain = "甲乙 我写的 丙";
    const owners = "AAHHHHHA";
    const res = edits(plain, owners, "甲乙 我写的 丁");
    expect(writeBack(doc, 2, res.plain, res.owners)).toBe("甲乙 @@我写的@@ 丁");
  });
});
