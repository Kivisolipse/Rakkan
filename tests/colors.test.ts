import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { colorCss, colorVars, DEFAULT_COLORS, familyStyle, styleVars } from "../src/cm6/colors";

const settings = { colors: { gpt: { light: "#111111", dark: "#222222" } }, extraPrefixes: [{ prefix: "ernie", family: "ernie" }] };

describe("colours", () => {
  it("maps every built-in family in styles.css, as the exported stylesheet does", () => {
    const css = readFileSync("styles.css", "utf8");
    const rules = colorCss({ colors: {}, extraPrefixes: [] }).split("\n").slice(2);
    expect(rules).toHaveLength(Object.keys(DEFAULT_COLORS).length);
    for (const rule of rules) expect(css).toContain(rule);
  });

  it("sets each family's colours for the theme, the user's own first", () => {
    const light = colorVars(settings, false);
    const dark = colorVars(settings, true);
    expect(light["--rk-c-claude"]).toBe(DEFAULT_COLORS.claude.light);
    expect(dark["--rk-c-claude"]).toBe(DEFAULT_COLORS.claude.dark);
    expect(light["--rk-c2-gemini"]).toBe(DEFAULT_COLORS.gemini.light2);
    expect([light["--rk-c-gpt"], light["--rk-c2-gpt"], dark["--rk-c-gpt"]]).toEqual(["#111111", "#111111", "#222222"]);
    // A family added in the settings takes the generic colour until given its own.
    expect(light["--rk-c-ernie"]).toBe(DEFAULT_COLORS.generic.light);
  });

  it("reads an inline style back as properties", () => {
    expect(styleVars(familyStyle("ernie"))).toEqual({ "--rk-c": "var(--rk-c-ernie)", "--rk-c2": "var(--rk-c2-ernie)" });
    expect(styleVars(undefined)).toEqual({});
  });
});
