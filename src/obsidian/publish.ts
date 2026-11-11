// Obsidian Publish does not run plugins. A note exported for it carries its
// authorship as HTML classes (exportPublish), and publish.css, written here,
// gives those classes their colours.

import { normalizePath, Notice, TFile, type App } from "obsidian";
import { hueHex, type Attr, type Author, type ParseResult } from "../core";
import { colorCss } from "../cm6/colors";
import { resolve, slug, type StyleSettings } from "../cm6/resolve";
import type { RakkanSettings } from "./settings";
import { t } from "../i18n";

const BEGIN = "/* >>> Rakkan (落款): generated, edit outside these lines >>> */";
const END = "/* <<< Rakkan <<< */";

/** Classes and a name for the exported spans; an author's own colour becomes a class, since styles may not survive a site. */
export function publishDescribe(styles: StyleSettings) {
  return (attr: Attr, r: ParseResult) => {
    const res = resolve(attr, r, styles);
    if (!res) return null;
    let cls = res.cls;
    if (res.style && attr.key) cls += ` rk-own-${slug(attr.key)}`;
    return { cls, label: res.label };
  };
}

/** The stylesheet for a site: the plugin's colours and its reading-view rules, without anything that needs a script. */
export function publishCss(settings: RakkanSettings, authors: Record<string, Author>, pluginCss: string): string {
  const own: string[] = [];
  for (const a of Object.values(authors)) {
    const c = a.color ?? (a.kind === "human" ? hueHex(a.key) : undefined);
    if (c) own.push(`.rk-own-${slug(a.key)} { --rk-c: ${c}; --rk-c2: ${(a.color && a.color2) || c}; }`);
  }
  return [
    BEGIN,
    colorCss(settings),
    ...own,
    pluginCss,
    "/* No script runs on a site: a rainbow runs across its own phrase, and every colour is at full strength. */",
    ".rk-style-rainbow { background-attachment: scroll !important; background-size: 100% 100% !important; background-position: 0 0 !important; }",
    ".rk-block { margin: 1em 0; }",
    ".rk-sig { margin: 0 0 .4em; font-size: .8em; opacity: .7; }",
    "sup.rk-cite { margin-left: .15em; font-size: .7em; opacity: .75; }",
    END,
    "",
  ].join("\n");
}

/** Put the stylesheet into `publish.css` at the vault root: only the part between our markers is replaced. */
export async function writePublishCss(app: App, css: string) {
  const path = normalizePath("publish.css");
  const file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    await app.vault.create(path, css);
    new Notice(t("已新建 publish.css"));
    return;
  }
  if (!(file instanceof TFile)) return;
  await app.vault.process(file, (old) => {
    const a = old.indexOf(BEGIN);
    const b = old.indexOf(END);
    return a >= 0 && b > a ? old.slice(0, a) + css.trimEnd() + old.slice(b + END.length) : old.trimEnd() + "\n\n" + css;
  });
  new Notice(t("已更新 publish.css 中 Rakkan 的部分"));
}
