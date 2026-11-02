import { describe, expect, it } from "vitest";
import { looseRegex, parse, stripMarkers } from "../src/core";

describe("stripMarkers", () => {
  it("removes inline markers and cites but keeps other syntax", () => {
    const r = parse("这是&&**AI**&&[@gpt]，「引」[@a]，`a && b`");
    expect(stripMarkers(r).text).toBe("这是**AI**，「引」，`a && b`");
  });

  it("removes block lines with one surrounding blank line", () => {
    const r = parse("前\n\n&& Claude\n\n块@@人@@\n\n&&\n\n后");
    expect(stripMarkers(r).text).toBe("前\n\n块人\n\n后");
  });

  it("strips a range and maps back to source offsets", () => {
    const src = "人&&AI&&人";
    const s = stripMarkers(parse(src), 1, 8);
    expect(s.text).toBe("AI人");
    expect(s.map.map((i) => src[i]).join("")).toBe("AI人");
  });

  it("removes code declarations", () => {
    const r = parse("```ts &&&\nx = &&&1&&&\n```");
    expect(stripMarkers(r).text).toBe("```ts\nx = 1\n```");
  });

  it("never touches math", () => {
    const r = parse("$a && b$ 和 &&x&&");
    expect(stripMarkers(r).text).toBe("$a && b$ 和 x");
  });
});

describe("looseRegex", () => {
  it("matches across markers and formatting", () => {
    const re = looseRegex("分页机制");
    expect("这是分&&页@@机**制".match(re)?.[0]).toBe("分&&页@@机**制");
    expect("[[分页]]机制".match(looseRegex("分页机制"))?.[0]).toBe("分页]]机制");
  });

  it("is case-insensitive for letters and escapes regex syntax", () => {
    expect("Tw**ój**".match(looseRegex("twój"))?.[0]).toBe("Tw**ój");
    expect("a.b".match(looseRegex("a.b"))?.[0]).toBe("a.b");
    expect("axb".match(looseRegex("a.b"))).toBeNull();
  });

  it("stays linear on long runs of formatting characters", () => {
    const t0 = Date.now();
    looseRegex("ab").test("a" + "*".repeat(100000) + "c");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
