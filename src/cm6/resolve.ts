// Turns an attribution into CSS classes and a label. Pure: shared by the
// live preview, the reading view and (later) other CodeMirror hosts.

import {
  familyOf,
  hueHex,
  parseAuthor,
  signatureFamily,
  signatureLabel,
  type Attr,
  type Author,
  type ExtraPrefix,
  type ParseResult,
  type Signature,
} from "../core";
import { t } from "../i18n";

/** How AI and quoted text is shown. The text itself is coloured; nothing is highlighted. */
export const STYLES = ["color", "gradient", "rainbow", "underline", "none"] as const;
export type StyleName = (typeof STYLES)[number];

export interface StyleSettings {
  /** 按模型家族上色; off → every AI uses the generic AI colour. */
  familyColors: boolean;
  /** Layer 1: per kind. */
  aiStyle: StyleName;
  quoteStyle: StyleName;
  /** Layer 2: per family id. */
  familyStyle: Record<string, StyleName>;
  /** Layer 3: per model id or per signature / key. */
  modelStyle: Record<string, StyleName>;
  /** Master switch: one style for everything ("" = off). */
  forceStyle: StyleName | "";
  extraPrefixes: ExtraPrefix[];
  /** The author book. A note's own `@key:` lines win over it. */
  authors: Record<string, Author>;
}

type Doc = Pick<ParseResult, "blocks" | "definitions">;

export interface Resolved {
  /** Space-separated classes for the text. */
  cls: string;
  /** Inline CSS (colour variables) for per-author colours. */
  style?: string;
  /** Who wrote it, for tooltips. */
  label: string;
  /** Model ID when known. */
  id?: string;
  family?: string;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-|-$/g, "") || "x";

/** The author a key points at: the note's own definition first, then the book. */
export function authorOf(key: string, doc: Pick<ParseResult, "definitions">, s: Pick<StyleSettings, "authors" | "extraPrefixes">): Author | undefined {
  const def = doc.definitions[key];
  return def ? parseAuthor(key, def, s.extraPrefixes) : s.authors[key];
}

/** Signature of an AI attribution: an inline key (via an author) or the block signature. */
export function attrSignature(attr: Attr, doc: Doc, s?: Pick<StyleSettings, "authors" | "extraPrefixes">): Signature | null {
  if (attr.key) {
    const a = s ? authorOf(attr.key, doc, s) : undefined;
    if (a) {
      const sig: Signature = { raw: a.name ?? a.id ?? attr.key };
      if (a.name) sig.name = a.name;
      if (a.id) sig.id = a.id;
      return sig;
    }
    // A bare key such as [@gpt-5] or [@claude] still tells the family.
    return { raw: attr.key, id: attr.key };
  }
  if (attr.block !== undefined) return doc.blocks[attr.block]?.signature ?? null;
  return null;
}

const colorStyle = (c: string) => `--rk-c: ${c}; --rk-c2: ${c};`;

export function resolve(attr: Attr, doc: Doc, s: StyleSettings): Resolved | null {
  if (attr.kind === "human") {
    // Human text is never decorated; islands only get a hook class.
    return attr.explicit ? { cls: "rk rk-island", label: t("亲笔") } : null;
  }

  if (attr.kind === "quote") {
    const key = attr.key ?? "";
    const style = s.forceStyle || s.modelStyle[`@${key}`] || s.quoteStyle;
    const author = key ? authorOf(key, doc, s) : undefined;
    const out: Resolved = {
      cls: `rk rk-quote rk-author-${slug(key)} rk-style-${style}`,
      label: author?.name ?? (key ? `@${key}` : t("引文")),
    };
    if (!author) return out;
    if (author.id) out.id = author.id;
    if (author.kind === "source") out.cls += " rk-source";
    if (author.color) out.style = colorStyle(author.color);
    else if (author.kind === "source") out.style = undefined;
    else if (author.kind === "human") out.style = colorStyle(hueHex(key));
    else {
      // An AI being quoted: its family colour.
      const fam = signatureFamily({ raw: "", ...(author.name ? { name: author.name } : {}), ...(author.id ? { id: author.id } : {}) }, s.extraPrefixes);
      if (fam) out.style = `--rk-c: var(--rk-c-${fam.id}); --rk-c2: var(--rk-c2-${fam.id});`;
    }
    return out;
  }

  const sig = attrSignature(attr, doc, s);
  const fam = sig ? signatureFamily(sig, s.extraPrefixes) ?? familyOf(attr.key, s.extraPrefixes) : null;
  const famId = s.familyColors && fam ? fam.id : "generic";
  const id = sig?.id;
  const style =
    s.forceStyle ||
    (id && s.modelStyle[id]) ||
    (attr.key && s.modelStyle[`@${attr.key}`]) ||
    (fam && s.familyStyle[fam.id]) ||
    s.aiStyle;
  let cls = `rk rk-ai rk-fam-${famId} rk-style-${style}`;
  if (id) cls += ` rk-model-${slug(id)}`;
  const label = sig ? signatureLabel(sig, s.extraPrefixes) : "AI";
  const out: Resolved = { cls, label };
  const own = attr.key ? authorOf(attr.key, doc, s)?.color : undefined;
  if (own) out.style = colorStyle(own);
  if (id) out.id = id;
  if (fam) out.family = fam.id;
  return out;
}
