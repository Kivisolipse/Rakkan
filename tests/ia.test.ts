import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromIA, parse, parseIA, sha256Hex, splitIA, stripMarkers, toIA, unknownHumans } from "../src/core";

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
    // The name becomes an author key, defined at the end of the note.
    expect(out.text).toBe("人写的。&&AI 写的&&[@claude]。又是人。\n\n- @claude: Claude · AI\n");
    expect(parse(out.text).stats.ai).toBe(4);
  });

  it("gives a generic AI no key", () => {
    expect(fromIA(BLOCK("甲乙丙", "&AI: 1,1"))!.text).toBe("甲&&乙&&丙\n");
  });

  it("turns reference ranges into quotes with their author", () => {
    const text = "书上说纸短情长，对。";
    const out = fromIA(BLOCK(text, "@Human: 0,3 7,2", "*假书 <@fakebook>: 3,4"))!;
    expect(out.quotes).toBe(1);
    expect(out.text).toBe("书上说「纸短情长」[@fakebook]，对。\n\n- @fakebook: 假书 · 来源\n");
    const r = parse(out.text);
    expect(r.stats.quote).toBe(4);
  });

  it("does not wrap what is already quoted, and does not cross lines", () => {
    const text = "说「甲乙」好\n次行丙丁";
    // 「甲乙」 is characters 1..4; 丙丁 sits on the second line and 好\n joins neither.
    const out = fromIA(BLOCK(text, "*书: 1,4 9,2"))!;
    expect(out.text.split("\n")[0]).toBe("说「甲乙」[@书]好");
    expect(out.text.split("\n")[1]).toBe("次行「丙丁」[@书]");
  });

  it("keeps a reference as plain text when quote marks inside would break it", () => {
    const out = fromIA(BLOCK("甲「乙」丙", "*书: 0,5"))!;
    expect(out.quotes).toBe(0);
    expect(out.referenceChars).toBe(5);
    expect(out.text).toBe("甲「乙」丙\n");
  });

  it("does not define an author twice", () => {
    const out = fromIA(BLOCK("甲乙", "&Claude: 0,1", "&Claude <claude-opus-5-5>: 1,1"))!;
    expect(out.text.match(/- @claude:/g)).toHaveLength(1);
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
    // The key travels in the block, so the same author comes back.
    expect(back.text).toContain("&&这句是 AI 补的&&[@claude]");
    expect(toIA(back.text.replace(/\n\n- @claude.*\n$/, "\n"))).toBe(once);
  });

  it("keeps display names and keys of inline authors and quotes through a round trip", () => {
    const nameOf = (k: string) => ({ gpt: "GPT-4", fakebook: "假书" })[k];
    const text = "开头&&机器的话&&[@gpt]，书上说「纸短情长」[@fakebook]。\n";
    const once = toIA(text, { nameOf });
    expect(once).toContain("&GPT-4 <@gpt>: ");
    expect(once).toContain("*假书 <@fakebook>: ");
    const back = fromIA(once)!;
    expect(back.text).toContain("&&机器的话&&[@gpt]");
    expect(back.text).toContain("「纸短情长」[@fakebook]");
    expect(back.text).toContain("- @gpt: GPT-4 · AI");
    expect(back.text).toContain("- @fakebook: 假书 · 来源");
    expect(back.quotes).toBe(1);
  });

  it("names AI blocks by their signature and keeps quotes as references", () => {
    const text = ["&& Claude (claude-opus-5-5)", "", "整段 AI。", "", "&&", "", "书上说「纸短情长」[@fakebook]。"].join("\n");
    const out = toIA(text, { nameOf: (k) => (k === "fakebook" ? "假书" : undefined) });
    expect(out).toContain("&Claude <claude-opus-5-5>: ");
    expect(out).toContain("*假书 <@fakebook>: ");
    expect(out).toContain("@Human: ");
  });

  it("replaces an annotation block that is already there", () => {
    const out = toIA(BLOCK("正文", "@Human: 0,2"));
    expect(out.match(/Annotations:/g)).toHaveLength(1);
  });
});

describe("fromIA with several humans", () => {
  const book = {
    ada: { key: "ada", name: "Ada Example", kind: "human" as const },
    opus: { key: "opus", name: "Claude", kind: "ai" as const },
  };
  const text = "甲乙丙丁戊己庚辛";

  it("writes a human the book knows as that author's quote, and leaves the owner plain", () => {
    const out = fromIA(BLOCK(text, "@我自己: 0,4", "@Ada Example: 4,4"), { authors: book })!;
    expect(out.text).toBe("甲乙丙丁「戊己庚辛」[@ada]\n");
    expect(out.others).toEqual(["Ada Example"]);
  });

  it("treats the only unknown human as the owner", () => {
    const out = fromIA(BLOCK(text, "@Anton: 0,8"))!;
    expect(out.text).toBe(text + "\n");
    expect(out.others).toEqual([]);
  });

  it("asks which unknown human owns the vault: the others become quotes with a definition", () => {
    const note = BLOCK(text, "@Anton: 0,5", "@Beth Example: 5,3");
    expect(unknownHumans(note)).toEqual([
      { name: "Anton", chars: 5 },
      { name: "Beth Example", chars: 3 },
    ]);
    const asBeth = fromIA(note, { owner: "beth example" })!;
    expect(asBeth.text).toBe("「甲乙丙丁戊」[@anton]己庚辛\n\n- @anton: Anton · 人\n");
    // Without an answer the one with most text is the owner.
    const dflt = fromIA(note)!;
    expect(dflt.text).toBe("甲乙丙丁戊「己庚辛」[@beth-example]\n\n- @beth-example: Beth Example · 人\n");
  });

  it("does not ask when the book settles it", () => {
    expect(unknownHumans(BLOCK(text, "@Anton: 0,4", "@Ada Example: 4,4"), book)).toEqual([{ name: "Anton", chars: 4 }]);
  });

  it("reuses the key of a book author found by name, without defining it again", () => {
    const out = fromIA(BLOCK(text, "@我: 0,4", "&Claude <claude-opus-5-5>: 4,4"), { authors: book })!;
    expect(out.text).toBe("甲乙丙丁&&戊己庚辛&&[@opus]\n");
  });
});

describe("fromIA with no owner", () => {
  it("writes every unknown human as a quote when the owner is null", () => {
    const out = fromIA(BLOCK("甲乙丙丁", "@Anton: 0,4"), { owner: null })!;
    expect(out.text).toBe("「甲乙丙丁」[@anton]\n\n- @anton: Anton · 人\n");
    expect(out.others).toEqual(["Anton"]);
  });
});
