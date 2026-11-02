import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { language, setLanguage, t } from "../src/i18n";
import { en } from "../src/i18n/en";

const CJK = /[　-〿一-鿿＀-￯]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "i18n" ? [] : sources(p);
    return p.endsWith(".ts") && e.name !== "i18n.ts" ? [p] : [];
  });
}

/** The Chinese text of every `t("…")` call, and of every message the parser reports. */
function keys(): Map<string, string> {
  const found = new Map<string, string>();
  const literal = /"((?:[^"\\\n]|\\.)*)"/;
  for (const file of sources("src")) {
    const text = readFileSync(file, "utf8");
    const calls = [
      ...text.matchAll(/\bt\(("(?:[^"\\\n]|\\.)*")/g),
      // the parser's diagnostics are Chinese keys that are translated where they are shown
      ...text.matchAll(/diag\([^\n]*?,\s*("(?:[^"\\\n]|\\.)*")\);/g),
      ...text.matchAll(/message:\s*("(?:[^"\\\n]|\\.)*")/g),
    ];
    for (const m of calls) {
      const key = JSON.parse(m[1]) as string;
      if (CJK.test(key) && literal.test(m[1])) found.set(key, file);
    }
  }
  return found;
}

describe("i18n", () => {
  afterEach(() => setLanguage("zh"));

  it("has an English text for every Chinese text in the source", () => {
    const missing = [...keys()].filter(([k]) => !(k in en)).map(([k, f]) => `${f}: ${k}`);
    expect(missing).toEqual([]);
  });

  it("has no English text that nothing uses", () => {
    const used = keys();
    const stale = Object.keys(en).filter((k) => !used.has(k));
    expect(stale).toEqual([]);
  });

  it("keeps the same {placeholders} in both languages", () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [zh, english] of Object.entries(en)) expect(holes(english), zh).toEqual(holes(zh));
  });

  it("translates, fills in values, and falls back to Chinese", () => {
    setLanguage("zh");
    expect(t("已补全 {n} 个空行", { n: 3 })).toBe("已补全 3 个空行");
    setLanguage("en");
    expect(language()).toBe("en");
    expect(t("已补全 {n} 个空行", { n: 3 })).toBe("Added 3 blank lines");
    expect(t("一句没有翻译的话")).toBe("一句没有翻译的话");
  });

  it("follows Obsidian's language when set to auto", () => {
    setLanguage("auto", "zh-TW");
    expect(language()).toBe("zh");
    setLanguage("auto", "ja");
    expect(language()).toBe("en");
  });
});
