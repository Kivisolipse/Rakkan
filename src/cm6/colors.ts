// Default family colours and the variables that expose them. Pure, so any CM6
// host can use it. In the app the variables are set on the body (Obsidian
// copies them into popout windows) and styles.css maps each built-in family to
// its own; a family the settings add is mapped on the text itself.

import type { ExtraPrefix } from "../core";

/** A family's colours on a light and a dark theme; `light2` / `dark2` are where a gradient ends. */
export interface ColorPair {
  light: string;
  dark: string;
  light2?: string;
  dark2?: string;
}

/** Each family's colours, and a second one in the same family of hues for gradient text. */
export const DEFAULT_COLORS: Record<string, Required<ColorPair>> = {
  claude: { light: "#d97757", dark: "#e3916f", light2: "#c4517a", dark2: "#e8799d" },
  gpt: { light: "#10a37f", dark: "#2ec79a", light2: "#0e8fa6", dark2: "#38b6d6" },
  gemini: { light: "#4e7ff0", dark: "#7aa2f7", light2: "#9b72cb", dark2: "#b08fe0" },
  deepseek: { light: "#4d6bfe", dark: "#7d93ff", light2: "#7b5cf5", dark2: "#a08cff" },
  grok: { light: "#6b7280", dark: "#a1a1aa", light2: "#374151", dark2: "#d4d4d8" },
  llama: { light: "#0866ff", dark: "#4c8dff", light2: "#8f3cf0", dark2: "#b57aff" },
  muse: { light: "#d6338a", dark: "#f06aa8", light2: "#8b5cf6", dark2: "#b08cff" },
  qwen: { light: "#615ced", dark: "#8b87f5", light2: "#3b82f6", dark2: "#6fa8ff" },
  mistral: { light: "#fa520f", dark: "#ff7a45", light2: "#d98c00", dark2: "#ffc247" },
  kimi: { light: "#0ea5e9", dark: "#38bdf8", light2: "#6366f1", dark2: "#8b8ff8" },
  glm: { light: "#14b8a6", dark: "#2dd4bf", light2: "#0284c7", dark2: "#5cc8f5" },
  generic: { light: "#8b5cf6", dark: "#a78bfa", light2: "#c026d3", dark2: "#e38df5" },
  quote: { light: "#b08d57", dark: "#d4b483", light2: "#8f6a3a", dark2: "#e8c98f" },
};

export interface ColorSettings {
  colors: Record<string, ColorPair>;
  extraPrefixes: ExtraPrefix[];
  /** How strong colours are in writing mode (0–1). */
  writingStrength?: number;
  /** Opacity of quoted sources (0–1). */
  sourceOpacity?: number;
}

/** The colours of family `id` for the text that has them. */
export const familyStyle = (id: string) => `--rk-c: var(--rk-c-${id}); --rk-c2: var(--rk-c2-${id});`;

const familyIds = (s: ColorSettings) => new Set([...Object.keys(DEFAULT_COLORS), ...s.extraPrefixes.map((e) => e.family)]);

/** The colour variables for one theme. */
export function colorVars(s: ColorSettings, dark: boolean): Record<string, string> {
  const theme = dark ? "dark" : "light";
  const vars: Record<string, string> = {
    "--rk-writing-strength": String(s.writingStrength ?? 0.35),
    "--rk-source-opacity": String(s.sourceOpacity ?? 0.72),
  };
  for (const id of familyIds(s)) {
    const d = DEFAULT_COLORS[id] ?? DEFAULT_COLORS.generic;
    const own = s.colors[id];
    const pair = own ?? d;
    vars[`--rk-c-${id}`] = pair[theme];
    // Colours set before there was a second one have none: one colour, as they were.
    vars[`--rk-c2-${id}`] = (dark ? pair.dark2 : pair.light2) ?? pair[theme];
  }
  return vars;
}

/** The same as a stylesheet, for a page outside the app (a Publish site, a saved web page): both themes, and every family mapped. */
export function colorCss(s: ColorSettings): string {
  const decls = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(" ");
  return [
    `body { ${decls(colorVars(s, false))} }`,
    `body.theme-dark { ${decls(colorVars(s, true))} }`,
    ...Array.from(familyIds(s), (id) => `${id === "quote" ? ".rk-quote" : `.rk-fam-${id}`} { ${familyStyle(id)} }`),
  ].join("\n");
}

/** The custom properties of an inline style (`--rk-c: …; --rk-c2: …;`), to set one by one. */
export function styleVars(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of (style ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}
