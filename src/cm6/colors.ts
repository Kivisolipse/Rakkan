// Default family colours and the CSS that exposes them as variables. Pure,
// so any CM6 host can use it.

import type { ExtraPrefix } from "../core";

export interface ColorPair {
  light: string;
  dark: string;
}

export const DEFAULT_COLORS: Record<string, ColorPair & { light2?: string; dark2?: string }> = {
  claude: { light: "#d97757", dark: "#e3916f" },
  gpt: { light: "#10a37f", dark: "#2ec79a" },
  gemini: { light: "#4e7ff0", dark: "#7aa2f7", light2: "#9b72cb", dark2: "#b08fe0" },
  deepseek: { light: "#4d6bfe", dark: "#7d93ff" },
  grok: { light: "#6b7280", dark: "#a1a1aa" },
  llama: { light: "#0866ff", dark: "#4c8dff" },
  qwen: { light: "#615ced", dark: "#8b87f5" },
  mistral: { light: "#fa520f", dark: "#ff7a45" },
  kimi: { light: "#0ea5e9", dark: "#38bdf8" },
  glm: { light: "#14b8a6", dark: "#2dd4bf" },
  generic: { light: "#8b5cf6", dark: "#a78bfa" },
  quote: { light: "#b08d57", dark: "#d4b483" },
};

/** CSS for the colour variables; regenerated whenever settings change. */
export function colorCss(s: {
  colors: Record<string, ColorPair>;
  extraPrefixes: ExtraPrefix[];
  /** How strong colours are in writing mode (0–1). */
  writingStrength?: number;
  /** Opacity of quoted sources (0–1). */
  sourceOpacity?: number;
}): string {
  const light: string[] = [];
  const dark: string[] = [];
  const rules: string[] = [];
  const ids = new Set([...Object.keys(DEFAULT_COLORS), ...s.extraPrefixes.map((e) => e.family)]);
  for (const id of ids) {
    const d = DEFAULT_COLORS[id] ?? DEFAULT_COLORS.generic;
    const c = s.colors[id] ?? d;
    light.push(`--rk-c-${id}: ${c.light}; --rk-c2-${id}: ${s.colors[id] ? c.light : d.light2 ?? c.light};`);
    dark.push(`--rk-c-${id}: ${c.dark}; --rk-c2-${id}: ${s.colors[id] ? c.dark : d.dark2 ?? c.dark};`);
    const sel = id === "quote" ? ".rk-quote" : `.rk-fam-${id}`;
    rules.push(`${sel} { --rk-c: var(--rk-c-${id}); --rk-c2: var(--rk-c2-${id}); }`);
  }
  return [
    `body { ${light.join(" ")} }`,
    `body.theme-dark { ${dark.join(" ")} }`,
    // Higher specificity than the stylesheet's own defaults, whatever order they load in.
    `body.rk-mode-writing:not(#rk) { --rk-strength: ${s.writingStrength ?? 0.35}; }`,
    `body:not(#rk) { --rk-source-opacity: ${s.sourceOpacity ?? 0.72}; }`,
    ...rules,
  ].join("\n");
}
