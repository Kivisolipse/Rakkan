// Two languages, Chinese and English. The Chinese text is the key: `t("保存")`
// is the Chinese itself when the language is Chinese, and a lookup in `en`
// otherwise. A missing English entry falls back to the Chinese, and a test
// checks that no entry is missing.

import { en } from "./i18n/en";

export type Language = "auto" | "zh" | "en";

let current: "zh" | "en" = "zh";

/** `system` is the language Obsidian is set to (`getLanguage()`), followed when `pref` is "auto". */
export function setLanguage(pref: Language, system = "en") {
  current = pref !== "auto" ? pref : system.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const language = (): "zh" | "en" => current;

/** Translate `zh`; `{name}` in the text is replaced from `vars`. */
export function t(zh: string, vars?: Record<string, string | number>): string {
  const text = current === "en" ? (en[zh] ?? zh) : zh;
  return vars ? text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")) : text;
}
