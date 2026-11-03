import { describe, expect, it } from "vitest";
import { carryOwners, signRevision, trimPaste } from "../src/core";

const humans = (s: string) => "H".repeat(s.length);

describe("carryOwners", () => {
  it("marks only the changed words", () => {
    const r = carryOwners("I has a apple.", humans("I has a apple."), "I have an apple.");
    expect(r.owners).toBe("HH" + "AAAA" + "H" + "AA" + "HHHHHHH");
    expect(r.changed).toBe(2);
  });

  it("works on Chinese text, character by character", () => {
    expect(carryOwners("我喜欢苹果", humans("我喜欢苹果"), "我很喜欢苹果")).toEqual({ owners: "HAHHHH", changed: 1 });
  });

  it("changes nothing when nothing changed", () => {
    const original = "一段没有被改的话。";
    expect(carryOwners(original, humans(original), original)).toEqual({ owners: humans(original), changed: 0 });
  });

  it("keeps the old owners of what was kept, AI included", () => {
    expect(carryOwners("甲乙丙丁", "HXXH", "甲乙丙戊").owners).toBe("HXXA");
  });

  it("counts replaced words once and drops deleted ones", () => {
    const original = "this is very very good";
    expect(carryOwners(original, humans(original), "this is good")).toEqual({ owners: humans("this is good"), changed: 0 });
    // `rather` and `great` are separated by a space that was kept: two places.
    expect(carryOwners(original, humans(original), "this is rather great").changed).toBe(2);
  });

  it("keeps line breaks and marks changes line by line", () => {
    const original = "first line\nsecond line";
    const r = carryOwners(original, humans(original), "first line\nsecond lines");
    expect(r.owners.slice(0, 18)).toBe(humans("first line\nsecond "));
    // A word that changed is marked whole.
    expect(r.owners.slice(18)).toBe("AAAAA");
  });

  it("treats a very large rewrite as one change instead of stalling", () => {
    const t0 = Date.now();
    const r = carryOwners("字".repeat(3000), humans("字".repeat(3000)), "词".repeat(3000));
    expect(r).toEqual({ owners: "A".repeat(3000), changed: 1 });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("keeps a long text cheap when the edits are far apart", () => {
    const original = Array.from({ length: 3000 }, (_, i) => `第${i}行，一句话。`).join("\n");
    const edited = original.replace("第0行", "第零行").replace("第2999行", "第末行");
    const t0 = Date.now();
    const r = carryOwners(original, humans(original), edited);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.changed).toBe(2);
    expect(r.owners.replace(/H/g, "")).toBe("A".repeat("零".length + "末".length));
  });

  it("keeps as much as a longest common subsequence", () => {
    // Characters from a small alphabet, so that there are many ways to match.
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    const text = () => Array.from({ length: 1 + rand(40) }, () => "甲乙丙"[rand(3)]).join("");
    for (let round = 0; round < 200; round++) {
      const a = text();
      const b = text();
      const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
      const owners = carryOwners(a, humans(a), b).owners;
      expect(owners.length).toBe(b.length);
      expect(owners.replace(/A/g, "").length).toBe(dp[0][0]);
    }
  });

  it("keeps owners aligned with the text", () => {
    for (const [a, b] of [
      ["abc def", "abc xyz def"],
      ["你好，世界", "你好世界！"],
      ["", "新的"],
      ["旧的", ""],
    ]) {
      expect(carryOwners(a, humans(a), b).owners.length).toBe(b.length);
    }
  });
});

describe("trimPaste", () => {
  it("drops a line break or indent the copy added", () => {
    expect(trimPaste("一句话", "一句话。\n")).toBe("一句话。");
    expect(trimPaste("first line\nsecond line", "  first line\r\nsecond lines\n")).toBe("first line\nsecond lines");
    expect(trimPaste("a line\n", "a line, longer\n")).toBe("a line, longer\n");
  });
});

describe("paste revision end to end", () => {
  // What the plugin does: the clipboard replaces the selection, and the note is signed.
  const paste = (doc: string, selected: string, clipboard: string, key?: string) => {
    const from = doc.indexOf(selected);
    return signRevision(doc, doc.slice(0, from) + trimPaste(selected, clipboard) + doc.slice(from + selected.length), key).text;
  };

  it("marks the changed words as AI in a human paragraph, with the model", () => {
    expect(paste("I has a apple.", "I has a apple.", "I have an apple.\n", "gpt")).toBe("I &&have an&&[@gpt] apple.");
  });

  it("works without naming a model", () => {
    expect(paste("我喜欢苹果", "我喜欢苹果", "我很喜欢苹果")).toBe("我&&很&&喜欢苹果");
  });

  it("leaves an AI block's own text unmarked and keeps human islands as islands", () => {
    const doc = "&& Claude\n\n甲乙 @@我写的@@ 丙\n\n&&";
    expect(paste(doc, "甲乙 @@我写的@@ 丙", "甲乙 我写的 丁")).toBe("&& Claude\n\n甲乙 @@我写的@@ 丁\n\n&&");
  });

  it("keeps another model's key on text that was not changed", () => {
    const doc = "Mine &&theirs&&[@gpt-5] and more.";
    expect(paste(doc, doc, "Mine theirs and much more.", "claude-opus-5-5")).toBe(
      "Mine &&theirs&&[@gpt-5] and &&much&&[@claude-opus-5-5] more.",
    );
  });
});
