// The SPEC changes decided after the fuzz report, one regression test (or a few) each.

import { describe, expect, it } from "vitest";
import { parse, signRevision, toIA } from "../src/core";
import { owners } from "./helpers";

describe("the rule above all: when in doubt, not the person's", () => {
  it("does not hand an AI list item's leader to the person when signing drops the markers", () => {
    const s = signRevision("&&- x&&\n", "- x\n", "m");
    expect(parse(s.text).stats.human).toBe(0);
  });

  it("does not hand an AI block's list or table to the person when the revision moves it out", () => {
    const s = signRevision("&& AI\n\n- x\n| a |\n\n&&\n", "- x\n| a |\n", "m");
    expect(parse(s.text).stats.human).toBe(0);
    expect(owners(s.text)).toEqual(["A:x", "A:a"]);
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
