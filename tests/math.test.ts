import { describe, expect, it } from "vitest";
import { exportPandoc, exportPlain, parse, stripMarkers } from "../src/core";
import { owners } from "./helpers";

const block = (...body: string[]) => ["&& Claude", "", ...body, "", "&&"].join("\n");

describe("declared math blocks", () => {
  const src = block("$$ %@@", "x = @@y + z@@", "$$");

  it("takes islands inside a formula, the rest belongs to the block", () => {
    const r = parse(src);
    expect(owners(r)).toEqual(["A:x = ", "h:y + z"]);
    expect(r.lineContexts[3]).toMatchObject({ mode: "code", atLen: 2, codeFence: 2 });
  });

  it("does not count the dollar lines, and the declaration is a mark", () => {
    const r = parse(src);
    expect(r.stats.human).toBe(3);
    expect(r.stats.ai).toBe(2);
    expect(r.segments.filter((s) => s.mark === "decl").map((s) => r.text.slice(s.from, s.to))).toEqual(["%@@"]);
  });

  it("is stripped down to the formula as MathJax saw it", () => {
    const text = stripMarkers(parse(src)).text;
    expect(text).toBe("$$\nx = y + z\n$$\n\n");
    expect(exportPlain(src)).toBe(text);
    expect(exportPandoc(src)).toContain("$$\nx = y + z\n$$");
  });

  it("keeps a longer declaration, and ignores `%@` that is not a declaration", () => {
    expect(owners(block("$$ %@@@", "a @@b@@ @@@c@@@", "$$"))).toEqual(["A:a @@b@@ ", "h:c"]);
    const plain = parse(block("$$ %@", "a @@b@@", "$$"));
    expect(plain.lineContexts[3].mode).toBe("other");
  });

  it("leaves an undeclared formula as it was", () => {
    const r = parse(block("$$", "x = @@y@@", "$$"));
    expect(r.lineContexts[3].mode).toBe("other");
    expect(stripMarkers(r).text).toContain("x = @@y@@");
  });

  it("outside a block the declaration changes nothing, as in code", () => {
    expect(owners("$$ %@@\nx = @@y@@\n$$")).toEqual(["H:x = @@y@@"]);
  });
});
