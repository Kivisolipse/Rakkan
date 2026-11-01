import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromIA, parse, parseIA, sha256Hex, splitIA, stripMarkers, toIA } from "../src/core";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("sha256Hex", () => {
  it("agrees with node's implementation, around the padding boundaries", () => {
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "落款，每个字都有署名".repeat(30)]) {
      expect(sha256Hex(bytes(s))).toBe(createHash("sha256").update(s).digest("hex"));
    }
  });
});

const BLOCK = (text: string, ...authors: string[]) => {
  const n = [...text].length;
  const hash = sha256Hex(bytes(text));
  return `${text}\n\n---\nAnnotations: 0,${n} SHA-256 ${hash.slice(0, 32)}\n${authors.join("\n")}\n...\n`;
};

describe("reading an iA block", () => {
  const text = "人写的。AI 写的。又是人。";

  it("splits the text from the block", () => {
    const note = BLOCK(text, "@Human: 0,4 9,4", "&Claude <claude-opus-5-5>: 4,5");
    const s = splitIA(note)!;
    expect(s.body).toBe(text + "\n");
    const p = parseIA(s)!;
    expect(p.hash).toEqual({ from: 0, length: text.length, ok: true });
    expect(p.authors).toEqual([
      { kind: "human", name: "Human", ranges: [[0, 4], [9, 4]] },
      { kind: "ai", name: "Claude", id: "claude-opus-5-5", ranges: [[4, 5]] },
    ]);
  });

  it("treats a missing length as 1 and reads continuation lines", () => {
    const note = BLOCK("abcdef", "@Anton Sotkov: 0 2,2\n  5", "&AI: 1 4");
    const p = parseIA(splitIA(note)!)!;
    expect(p.authors[0].ranges).toEqual([[0, 1], [2, 2], [5, 1]]);
    expect(p.authors[1].ranges).toEqual([[1, 1], [4, 1]]);
  });

  it("notices a hash that does not match", () => {
    const note = BLOCK(text, "@Human: 0,13").replace(text, "别的文字，一样长的。AI。");
    expect(parseIA(splitIA(note)!)!.hash.ok).toBe(false);
  });

  it("finds no block in an ordinary note", () => {
    expect(splitIA("正文\n\n---\n\n另一段\n")).toBeNull();
    expect(fromIA("正文")).toBeNull();
  });
});

describe("fromIA", () => {
  it("marks AI ranges and leaves the rest alone", () => {
    const text = "人写的。AI 写的。又是人。";
    const out = fromIA(BLOCK(text, "@Human: 0,4 9,4", "&Claude: 4,5"))!;
    expect(out.hashOk).toBe(true);
    expect(out.text).toBe("人写的。&&AI 写的&&。又是人。\n");
    const r = parse(out.text);
    expect(r.stats.ai).toBe(4);
  });

  it("counts grapheme clusters, not UTF-16 units", () => {
    const text = "👨‍👩‍👧 家人，AI 补的。";
    // The family emoji is one cluster; the AI part starts after "家人，".
    const out = fromIA(BLOCK(text, "@Human: 0,5", "&AI: 5,6"))!;
    expect(out.hashOk).toBe(true);
    expect(stripMarkers(parse(out.text)).text).toBe(text + "\n");
    expect(parse(out.text).stats.ai).toBe(5);
  });
});

describe("toIA", () => {
  const note = "人写的开头。&&这句是 AI 补的&&[@claude]，然后又回到人。\n";

  it("writes the plain text and a block that reads back to the same ownership", () => {
    const out = toIA(note);
    const s = splitIA(out)!;
    expect(s.body).toBe("人写的开头。这句是 AI 补的，然后又回到人。\n");
    const p = parseIA(s)!;
    expect(p.hash.ok).toBe(true);
    const ai = p.authors.find((a) => a.kind === "ai")!;
    expect(ai.name).toBe("claude");
    expect(ai.ranges).toEqual([[6, 9]]);
  });

  it("round-trips: iA block → markers → iA block", () => {
    const once = toIA(note);
    const back = fromIA(once)!;
    expect(back.hashOk).toBe(true);
    expect(stripMarkers(parse(back.text)).text).toBe(splitIA(once)!.body);
    // The block says who the AI was; the markers alone do not, so the name is lost.
    expect(toIA(back.text)).toBe(once.replace("&claude:", "&AI:"));
  });

  it("names AI blocks by their signature and keeps quotes as references", () => {
    const text = ["&& Claude (claude-opus-5-5)", "", "整段 AI。", "", "&&", "", "书上说「纸短情长」[@fakebook]。"].join("\n");
    const out = toIA(text, { nameOf: (k) => (k === "fakebook" ? "假书" : undefined) });
    expect(out).toContain("&Claude <claude-opus-5-5>: ");
    expect(out).toContain("*假书: ");
    expect(out).toContain("@Human: ");
  });

  it("replaces an annotation block that is already there", () => {
    const out = toIA(BLOCK("正文", "@Human: 0,2"));
    expect(out.match(/Annotations:/g)).toHaveLength(1);
  });
});
