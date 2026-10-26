// Turns an attribution into CSS classes and a label. Pure: shared by the
// live preview, the reading view and (later) other CodeMirror hosts.

import {
  familyOf,
  parseSignature,
  signatureFamily,
  signatureLabel,
  type Attr,
  type ExtraPrefix,
  type ParseResult,
  type Signature,
} from "../core";

export const STYLES = ["gradient", "solid", "rainbow", "underline", "leftline", "none"] as const;
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
}

export interface Resolved {
  /** Space-separated classes for the text. */
  cls: string;
  /** Who wrote it, for tooltips and badges. */
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

/** Signature of an AI attribution: inline key (via `@key:` definitions) or the block signature. */
export function attrSignature(attr: Attr, doc: Pick<ParseResult, "blocks" | "definitions">): Signature | null {
  if (attr.key) {
    const def = doc.definitions[attr.key];
    if (def) return parseSignature(def);
    // A bare key such as [@gpt-5] or [@claude] still tells the family.
    return { raw: attr.key, id: attr.key };
  }
  if (attr.block !== undefined) return doc.blocks[attr.block]?.signature ?? null;
  return null;
}

export function resolve(
  attr: Attr,
  doc: Pick<ParseResult, "blocks" | "definitions">,
  s: StyleSettings,
): Resolved | null {
  if (attr.kind === "human") {
    // Human text is never decorated; islands only get a hook class.
    return attr.explicit ? { cls: "rk rk-island", label: "亲笔" } : null;
  }

  if (attr.kind === "quote") {
    const key = attr.key ?? "";
    const style = s.forceStyle || s.modelStyle[`@${key}`] || s.quoteStyle;
    return {
      cls: `rk rk-quote rk-author-${slug(key)} rk-style-${style}`,
      label: key ? `@${key}` : "引文",
    };
  }

  const sig = attrSignature(attr, doc);
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
  if (id) out.id = id;
  if (fam) out.family = fam.id;
  return out;
}

/** Classes for a block's signature badge. */
export function resolveBlock(sig: Signature, s: StyleSettings): Resolved {
  const fam = signatureFamily(sig, s.extraPrefixes);
  const famId = s.familyColors && fam ? fam.id : "generic";
  const out: Resolved = { cls: `rk-sig rk-fam-${famId}`, label: signatureLabel(sig, s.extraPrefixes) };
  if (sig.id) out.id = sig.id;
  if (fam) out.family = fam.id;
  return out;
}
