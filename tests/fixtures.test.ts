import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "../src/core";
import { owners } from "./helpers";

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("fixtures", () => {
  it("sample.md", () => {
    const r = parse(read("sample.md"));
    expect(r.diagnostics).toEqual([]);
    expect(r.blocks.map((b) => b.signature.id)).toEqual(["claude-opus-5-5"]);
    expect(r.definitions).toEqual({ gpt: "GPT (gpt-5)", fakebook: "《一本不存在的书》" });
    expect(owners(r)).toMatchSnapshot();
    expect(r.stats).toMatchSnapshot();
  });

  it("money.md: only the trailing `/$` line is swallowed by math", () => {
    const r = parse(read("money.md"));
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([["math-swallow", 3]]);
    expect(owners(r).filter((o) => o.startsWith("A:"))).toEqual(["A:按当前汇率估算", "A:这是估算"]);
  });
});
