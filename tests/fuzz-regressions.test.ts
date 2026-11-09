// What the fuzz tests (tests/fuzz.test.ts) found, each as a plain test with
// the smallest input. "Fixed" ones must keep passing. "Open" ones wait for a
// decision (see the fuzz report): it.fails marks behaviour expected to change,
// plain tests pin today's behaviour so that a change is noticed.

import { describe, expect, it } from "vitest";
import { parse, quoteText, signRevision } from "../src/core";
import { KNOWN_QUOTES } from "./arbitraries";
import { owners } from "./helpers";

const B = "\\";

/** A quote between two paragraphs of the person's own: three owners, in order, or something went wrong. */
const isolated = (q: string, key: string) => {
  const o = owners(`我写的前文\n\n${q}\n\n我写的后文`);
  return o.length === 3 && o[0] === "H:我写的前文" && o[1].startsWith(`Q@${key}:`) && o[2] === "H:我写的后文";
};

describe("fixed: parse stays fast on long lines", () => {
  // Each scan restarted for every candidate and ran to the end of the line.
  const cases: Array<[string, string]> = [
    ["code spans between closing quote marks with cites (cubic: 26 s at 20 000 characters)", "`a` 」[@k] "],
    ["inline math openers without a closer", "$a "],
    ["link destinations without a closer", "]("],
    ["closing quote marks with cites and no opening mark", "」[@k]"],
    ["many quotes with markers inside", "「&&」[@k]"],
  ];
  for (const [name, unit] of cases) {
    it(name, () => {
      const line = unit.repeat(Math.ceil(100_000 / unit.length));
      const t0 = performance.now();
      parse(line);
      expect(performance.now() - t0).toBeLessThan(1000);
    });
  }
});

describe("fixed: signRevision", () => {
  it("keeps an insertion in link text the model's when the result is signed again", () => {
    // The whole link becomes the model's (a link is never split); signing again used to hand it all back to the person.
    const o = "[t](https://x.y/&&)\n";
    const once = signRevision(o, "[甲t](https://x.y/&&)\n", "m").text;
    expect(owners(once)).toEqual(["A@m:[甲t](https://x.y/&&)"]);
    expect(signRevision(o, once, "m").text).toBe(once);
  });

  it("keeps the model ID of AI-block text that the revision moves out of the block", () => {
    const s = signRevision("&& (claude-x)\n的\n&& AI\n", "甲的\n&& AI\n", "m");
    expect(owners(s.text)).toEqual(["A@m:甲", "A@claude-x:的", "H:&& AI"]);
  });

  it("reports a line whose quote the revision dropped, instead of handing the quote to the person", () => {
    // A plain revision has no [@k]: the line had no quote left to refuse, and the quoted words silently became the person's.
    for (const [o, r] of [
      ['"x"[@k]\n', '甲"x"\n'],
      ["a「x」[@k]\n", "a甲「x」\n"],
      ['"&&"[@k]\n', '甲"&&"\n'],
      ["前\n\n> 引文\n> [@k]\n", "前甲\n\n> 引文\n"],
    ]) {
      const s = signRevision(o, r, "m");
      // Like every reported line it is left as revised, for the person to put the quote back (see Q5b).
      expect(s.unmarked, JSON.stringify(o)).not.toEqual([]);
    }
  });

  it("treats a bare URL that runs into a link as one atom, so signing again changes nothing", () => {
    // `https://x.y/@@[` (the URL stops at 甲) and `[甲t](…)` share the `[`; the change spread over one and then
    // the other, in an order that gave a different result each time.
    const o = "https://x.y/@@[t](https://x.y/&&)\n";
    const once = signRevision(o, "https://x.y/@@[甲t](https://x.y/&&)\n", "m").text;
    expect(signRevision(o, once, "m").text).toBe(once);
  });

  it("reports a link the revision made out of two authors' words, the same way each time", () => {
    // `&&!&&[t](u)` reads `![t](u)`, an image. The whole image went to the model, and signing that
    // again gave it all to the person. Whose it should be is open (Q8).
    const o = "&&!&&[t](u)\n";
    const once = signRevision(o, "![t](u)\n", "m");
    expect(once.unmarked).toEqual([0]);
    expect(signRevision(o, once.text, "m").text).toBe(once.text);
  });

  it("does not count its own escape backslash as a change when the result is signed again", () => {
    // `[@k&&[t](u)` is one link, and its literal && gets a backslash. Signing again saw the backslash as
    // the model's insertion and gave it the whole link.
    const o = "[@k&&[t](u)x\n";
    const once = signRevision(o, "[@k&&[t](u)x甲\n", "m").text;
    expect(owners(once)).toEqual([`H:[@k${B}&&[t](u)x`, "A@m:甲"]);
    expect(signRevision(o, once, "m").text).toBe(once);
  });

  it("closes the markers before a block reference, which only works at the end of the line", () => {
    // The atom ` ^id` starts with a space; when the insertion ended in that space the whole reference went
    // inside the markers, stopped being a reference, and signing again moved it back out.
    const o = "的 ^blockid\n";
    const once = signRevision(o, "的 甲 ^blockid\n", "m").text;
    expect(once).toBe("的 &&甲&&[@m] ^blockid\n");
    expect(signRevision(o, once, "m").text).toBe(once);
  });

  it("keeps the marks of AI text that ends in &, with the space inside the markers", () => {
    const s = signRevision("&&x & &&\n", "甲 x & \n", "m");
    expect(s.unmarked).toEqual([]);
    expect(owners(s.text)).toEqual(["A@m:甲 ", "A:x & "]);
  });
});

describe("fixed: untrusted quotes", () => {
  for (const [text, key] of KNOWN_QUOTES) {
    it(`keeps ${JSON.stringify(text)} the source's`, () => {
      expect(isolated(quoteText(text, key, { untrusted: true }), key)).toBe(true);
    });
  }

  it("escapes every ASCII punctuation mark and nothing else", () => {
    expect(quoteText("温度 %% 隐藏「x」", "heater", { untrusted: true })).toBe(`> 温度 ${B}%${B}% 隐藏「x」\n> [@heater]`);
  });

  it("starts a new line at \\r\\n, \\r and \\n, and trims nothing", () => {
    expect(quoteText(" a\r\nb\rc\n\n", "k", { untrusted: true })).toBe(">  a\n> b\n> c\n>\n>\n> [@k]");
  });

  it("refuses a key with whitespace or square brackets", () => {
    expect(() => quoteText("x", "a b", { untrusted: true })).toThrow(RangeError);
    expect(() => quoteText("x", "a]", { untrusted: true })).toThrow(RangeError);
  });

  it("keeps two quotes apart when one opens %% and the other closes it", () => {
    const q = (t: string, k: string) => quoteText(t, k, { untrusted: true });
    const o = owners(`前文\n\n${q("读数 %% 开始", "heater")}\n\n${q("结束 %% 读数", "lock")}\n\n后文`);
    expect(o.map((x) => x.split(":")[0])).toEqual(["H", "Q@heater", "Q@lock", "H"]);
  });
});

describe("open Q1: quoteText's default output does not escape", () => {
  for (const [text, key] of KNOWN_QUOTES) {
    it.fails(`keeps ${JSON.stringify(text)} the source's`, () => {
      expect(isolated(quoteText(text, key), key)).toBe(true);
    });
  }

  it.fails("keeps two quotes apart when one opens %% and the other closes it", () => {
    const o = owners(`前文\n\n${quoteText("读数 %% 开始", "heater")}\n\n${quoteText("结束 %% 读数", "lock")}\n\n后文`);
    expect(o.map((x) => x.split(":")[0])).toEqual(["H", "Q@heater", "Q@lock", "H"]);
  });
});

describe("open Q4: escapes (SPEC §3.1)", () => {
  // Today a backslash escapes the next character, whatever it is, as in CommonMark: `\\@@` is a backslash
  // shown as such, then a live marker. Read word for word, §3.1 ("a pair right after a backslash") says escaped.
  it("pins: \\\\@@ is a live marker", () => {
    expect(owners(`> ${B}${B}@@x${B}${B}@@\n> [@k]`)).toEqual([`Q@k:${B}${B}`, `h:x${B}${B}`]);
    expect(owners(`${B}${B}&&x${B}${B}&&`)).toEqual([`H:${B}${B}`, `A:x${B}${B}`]);
  });

  // §3.4: a signature can't contain &&. Today an escaped `\&&` counts too, so the line is no opener.
  it("pins: \\&& in an opener line keeps it from opening an AI block", () => {
    expect(parse(`&& 签名 ${B}&&\n\n正文\n\n&&`).blocks).toHaveLength(0);
    expect(parse("&& 签名 xy\n\n正文\n\n&&").blocks).toHaveLength(1);
  });
});

describe("open Q5: signRevision", () => {
  // A quote the model writes into its revision credits the quoted author: the model can put words in
  // someone else's mouth. Other options: credit the model, or report the line.
  it.fails("does not credit a quote the model added to the quoted author", () => {
    const s = signRevision("前文。", "前文。「新加的话」[@x]", "m");
    expect(owners(s.text)).not.toContain("Q@x:新加的话");
  });

  // An inline AI span can't start or end next to a literal & (the runs merge, SPEC §3.1). sign then reports
  // the line as unmarked and leaves it as revised, so the AI text that was kept counts as the person's.
  it.fails("keeps the marks of AI text that starts with &", () => {
    const s = signRevision("&& & x&&\n", "甲  & x\n", "m");
    expect(s.unmarked).toEqual([]);
  });
});

describe("open Q7: a bare URL takes the closing marker after it (SPEC §5)", () => {
  // A bare URL runs to the next space, so `&&` or `@@` right after it is part of the URL: the span never closes.
  it.fails("closes inline AI text that ends in a bare URL", () => {
    expect(owners("&&见 https://x.y/&&\n")).toEqual(["A:见 https://x.y/"]);
  });

  it.fails("closes a human island that ends in a bare URL", () => {
    expect(owners("&& AI\n\n@@见 https://x.y/@@\n\n&&\n")).toEqual(["h:见 https://x.y/"]);
  });

  // So sign can't mark the model's words when they end in one, and leaves them the person's (reported).
  it.fails("marks a revision that ends in a bare URL", () => {
    const s = signRevision("前文\n", "前文见 https://x.y/\n", "m");
    expect(s.unmarked).toEqual([]);
  });
});

describe("open Q8: a link or the like holding two authors' words", () => {
  // sign never splits an atom. When the revision dropped the markers inside one (here `!` and the link
  // became an image), it can't keep both owners: today the line is reported and left as revised, so the
  // AI's `!` counts as the person's. Options: the larger share wins, the model's wins, or split it as before.
  it.fails("keeps both authors of an atom the model did not change", () => {
    const s = signRevision("&&!&&[t](u)\n", "![t](u)\n", "m");
    expect(owners(s.text)).toEqual(["A:!", "H:[t](u)"]);
  });
});

describe("open Q5c: AI blocks with a name and no model ID", () => {
  // Text that a revision moves out of `&& Claude` (no ID) becomes unnamed inline AI: there is no key to
  // carry, and a display name is not a key. Options: use the name as a key, or report the line.
  it.fails("keeps the block's name on its text", () => {
    const s = signRevision("&& Claude\n的\n&& AI\n", "甲的\n&& AI\n", "m");
    expect(parse(s.text).stats.aiByAuthor).toHaveProperty("Claude");
  });
});

describe("open Q6: keys (SPEC §4.1)", () => {
  // §4.1 allows any key without whitespace or square brackets; a definition line ends the key at `:`.
  it.fails("can define a key with : in it", () => {
    expect(Object.keys(parse("「x」[@a:b]\n\n@a:b: 名字 · source").definitions)).toContain("a:b");
  });
});
