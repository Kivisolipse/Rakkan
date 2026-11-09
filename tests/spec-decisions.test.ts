// The SPEC changes decided after the fuzz report, one regression test (or a few) each.

import { describe, expect, it } from "vitest";
import { parse, parseBook, signRevision, toIA } from "../src/core";
import { owners } from "./helpers";

describe("the rule above all: when in doubt, not the person's", () => {
  it("does not hand an AI list item's leader to the person when signing drops the markers", () => {
    const s = signRevision("&&- x&&\n", "- x\n", "m");
    expect(parse(s.text).stats.human).toBe(0);
  });

  it("does not hand an AI block's list or table to the person when the revision moves it out", () => {
    const s = signRevision("&& AI\n\n- x\n| a |\n\n&&\n", "- x\n| a |\n", "m");
    expect(parse(s.text).stats.human).toBe(0);
    // `&& AI` has a name and no ID, so its text keeps the key `ai` (Q5c).
    expect(owners(s.text)).toEqual(["A@ai:x", "A@ai:a"]);
  });
});

describe("§7: line syntax is not counted and belongs to no one", () => {
  it.each([
    ["- x", 1],
    ["1. x", 1],
    ["## x", 1],
    ["- [x] x", 1],
    ["[^1]: x", 1],
    ["| a | b |", 2],
    ["|---|:-:|", 0],
    ["| a \\| b |", 4],
  ])("%s", (line, n) => {
    expect(parse(line).stats.human).toBe(n);
  });

  it("keeps the label of where it stands in an iA export", () => {
    // `- x` is three characters, all the AI's (the line break after it is whitespace, labelled as before).
    expect(toIA("&& AI\n\n- x\n\n&&\n")).toMatch(/^&AI: 0,3$/m);
  });
});

describe("§7 known limitation: who ticks a task is not recorded, so sign reports it", () => {
  it("reports a task the model ticked and one it unticked", () => {
    expect(signRevision("- [ ] a\n- [x] b\n", "- [x] a\n- [ ] b\n", "m").tasks).toEqual([0, 1]);
  });

  it("does not report a task line the model wrote", () => {
    expect(signRevision("- [ ] a\n", "- [ ] a\n- [x] b\n", "m").tasks).toEqual([]);
  });
});

describe("Q3 (§7): what can't be seen isn't counted", () => {
  it.each([
    ["no-break space", " "],
    ["line separator", " "],
    ["next line", "\u0085"],
    ["ideographic space", "　"],
    ["byte order mark", "﻿"],
    ["zero-width space", "​"],
    ["zero-width joiner", "‍"],
    ["variation selector", "️"],
    ["soft hyphen", "­"],
  ])("leaves out a %s", (_name, c) => {
    expect(parse(`a${c}b`).stats.human).toBe(2);
  });

  it("counts an emoji joined from three as three", () => {
    expect(parse("\u{1f468}‍\u{1f469}‍\u{1f467}").stats.human).toBe(3);
  });
});

describe("Q4a (§3.1): a pair is escaped after an odd number of backslashes", () => {
  const B = "\\";

  it("reads \\\\ as one literal backslash, so the pair after it is a marker", () => {
    expect(owners(`${B}${B}&&x${B}${B}&&`)).toEqual([`H:${B}${B}`, `A:x${B}${B}`]);
    expect(owners(`> ${B}${B}@@x${B}${B}@@\n> [@k]`)).toEqual([`Q@k:${B}${B}`, `h:x${B}${B}`]);
  });

  it("escapes the pair after one or three backslashes", () => {
    expect(owners(`${B}&&x&&`)).toEqual([`H:${B}&&x&&`]);
    expect(owners(`${B}${B}${B}&&x&&`)).toEqual([`H:${B}${B}${B}&&x&&`]);
    expect(owners(`> ${B}${B}${B}@@x@@\n> [@k]`)).toEqual([`Q@k:${B}${B}${B}@@x@@`]);
  });
});

describe("Q4b (§3.4): escapes in a signature work as in prose", () => {
  const B = "\\";

  it("opens a block when the signature's && is escaped, and reads it unescaped", () => {
    const r = parse(`&& 甲 ${B}&& 乙 (m)\n\n正文\n\n&&`);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].signature).toMatchObject({ name: "甲 && 乙", id: "m" });
  });

  it("opens no block when the && is not escaped", () => {
    expect(parse("&& 甲 && 乙\n\n正文\n\n&&").blocks).toHaveLength(0);
    expect(parse(`&& 甲 ${B}${B}&& 乙\n\n正文\n\n&&`).blocks).toHaveLength(0);
  });
});

describe("Q6 (§4.3): a key runs to the first whitespace, less one colon at its end", () => {
  it("defines a key with colons in it", () => {
    const d = parse("「x」[@doe:2006]\n\n@doe:2006: Jane Doe · source").definitions;
    expect(Object.keys(d)).toEqual(["doe:2006"]);
    expect(d["doe:2006"]).toMatch(/^Jane Doe/);
  });

  it("does not split at the last colon of the line", () => {
    expect(Object.keys(parse("「x」[@doe]\n\n@doe: Re: a letter · source").definitions)).toEqual(["doe"]);
  });

  it("reads a key with colons in the author book too", () => {
    expect(Object.keys(parseBook("- @doe:2006: Jane Doe · source\n- @a: A"))).toEqual(["doe:2006", "a"]);
  });
});

describe("Q7 (§5): a marker at the end of a bare URL closes the span", () => {
  const B = "\\";

  it("closes inline AI text that ends in a bare URL", () => {
    expect(owners("&&见 https://x.y/&&\n")).toEqual(["A:见 https://x.y/"]);
    expect(owners("&&见 http://x&&[@m]\n")).toEqual(["A@m:见 http://x"]);
  });

  it("closes a human island that ends in a bare URL", () => {
    expect(owners("&& AI\n\n@@见 https://x.y/@@\n\n&&\n")).toEqual(["h:见 https://x.y/"]);
  });

  it("closes after sentence punctuation that ends the URL, and after the closer of an outer span", () => {
    expect(owners("&&见 https://x.y/.&&")).toEqual(["A:见 https://x.y/."]);
    expect(owners("> &&见 @@https://x.y/@@&&\n> [@k]")).toEqual(["A:见 ", "h:https://x.y/"]);
  });

  it("keeps in the URL a pair that closes nothing there", () => {
    expect(owners("https://x.y/&&\n")).toEqual(["H:https://x.y/&&"]);
    expect(owners("https://x.y/&& 甲&&\n")).toEqual(["H:https://x.y/&& 甲&&"]);
    expect(owners("https://x.y/@@ 前\n")).toEqual(["H:https://x.y/@@ 前"]);
    expect(owners(`&&见 https://x.y/${B}&&`)).toEqual([`H:&&见 https://x.y/${B}&&`]);
    expect(owners("https://x.y/&&&\n")).toEqual(["H:https://x.y/&&&"]);
  });

  it("lets sign mark a revision that ends in a bare URL", () => {
    const o = "前文\n";
    const s = signRevision(o, "前文见 https://x.y/\n", "m");
    expect(s.unmarked).toEqual([]);
    expect(owners(s.text)).toEqual(["H:前文", "A@m:见 https://x.y/"]);
    expect(signRevision(o, s.text, "m").text).toBe(s.text);
  });
});

describe("Q5c: text that leaves a block with a name and no model ID keeps the name as a key", () => {
  it("names it with the key made from the block's name", () => {
    const o = "&& Claude Code\n\n的\n\n&&\n";
    const s = signRevision(o, "甲的\n", "m");
    expect(s.unmarked).toEqual([]);
    expect(owners(s.text)).toEqual(["A@m:甲", "A@claude-code:的"]);
    expect(signRevision(o, s.text, "m").text).toBe(s.text);
  });

  it("reports the line when the name makes no key, and keeps the original there", () => {
    const o = "&& 「」\n\n的\n\n&&\n";
    const s = signRevision(o, "甲的\n", "m");
    // 的 alone, without its block, would read as the person's: the whole original is kept.
    expect(s.text).toBe(o);
    expect(s.rejected).toEqual([{ line: 0, count: 6, original: 0, revised: "甲的\n" }]);
  });
});

describe("Q2 (§3): a line ends at CR LF, CR or LF, as in CommonMark", () => {
  it("ends a line at a lone CR, as the editor does", () => {
    expect(owners("> a\rb\n> [@k]")).toEqual(owners("> a\nb\n> [@k]"));
    expect(parse("a\rb\r\nc\nd").lines.map((l) => [l.from, l.to])).toEqual([[0, 1], [2, 3], [5, 6], [7, 8]]);
  });

  it("signs a file with mixed line ends without changing any of them", () => {
    const o = "&& AI\r\n\r\n正文\r\n\r\n&&\r\n人写的\n另一行\r";
    const s = signRevision(o, o.replace("人写的", "人写的甲"), "m");
    expect(s.text).toBe(o.replace("人写的", "人写的&&甲&&[@m]"));
  });
});
