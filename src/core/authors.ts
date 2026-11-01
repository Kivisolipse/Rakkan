// Authors: who a `[@key]` points at. Defined one per line,
//
//   - @key: 名字 (标识) · 种类 · #颜色
//
// either in the author book (a note in the vault) or at the end of a single
// note (the leading `- ` is optional there). 种类 is 人 / AI / 来源; 标识 is a
// model ID, URL or ISBN; every part after the name is optional.

import { parseSignature, signatureFamily, type ExtraPrefix } from "./signature";

export type AuthorKind = "human" | "ai" | "source";

export interface Author {
  key: string;
  name?: string;
  /** Model ID, URL, ISBN … */
  id?: string;
  kind: AuthorKind;
  /** `#rrggbb`, when given. */
  color?: string;
}

const KIND_WORDS: Record<string, AuthorKind> = {
  人: "human",
  人类: "human",
  human: "human",
  ai: "ai",
  模型: "ai",
  来源: "source",
  source: "source",
  reference: "source",
  ref: "source",
};

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** One definition line without its key: `名字 (标识) · 种类 · #颜色`. */
export function parseAuthor(key: string, raw: string, extra: ExtraPrefix[] = []): Author {
  const parts = raw.split(/\s*[·•|｜]\s*/).map((p) => p.trim());
  const sig = parseSignature(parts[0] ?? "");
  const author: Author = { key, kind: "human" };
  if (sig.name) author.name = sig.name;
  if (sig.id) author.id = sig.id;
  let kind: AuthorKind | undefined;
  for (const p of parts.slice(1)) {
    if (COLOR_RE.test(p)) author.color = p;
    else kind ??= KIND_WORDS[p.toLowerCase()];
  }
  // Without a stated kind, a model ID makes it an AI.
  author.kind = kind ?? (signatureFamily(sig, extra) && sig.id ? "ai" : "human");
  return author;
}

const LINE_RE = /^\s*(?:[-*+]\s+)?@([^\s:\[\]]+):\s+(.+?)\s*$/;

/** Read the author book: every `- @key: …` line; the first definition of a key wins. */
export function parseBook(text: string, extra: ExtraPrefix[] = []): Record<string, Author> {
  const out: Record<string, Author> = {};
  for (const line of text.split("\n")) {
    const m = LINE_RE.exec(line.replace(/\r$/, ""));
    if (m && !(m[1] in out)) out[m[1]] = parseAuthor(m[1], m[2], extra);
  }
  return out;
}

/** The template for a new author book. All names here are made up. */
export const BOOK_TEMPLATE = `# 署名簿

一行一个作者：\`- @key: 名字 (标识) · 种类 · #颜色\`。种类写 人、AI 或 来源，颜色可以不写。
正文里用 \`「引文」[@key]\` 或 \`&&AI 写的&&[@key]\` 指向这里。

- @claude: Claude (claude-opus-5-5) · AI
- @gpt: GPT (gpt-5) · AI
- @ada: Ada Example · 人 · #3b82f6
- @fakebook: 《一本不存在的书》 (ISBN 000-0-00-000000-0) · 来源
`;

/** A stable colour for a human author who has none: a hue taken from the key. */
export function hueOf(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** The default colour of a human author without one, as `#rrggbb` (so a colour picker can show it). */
export function hueHex(key: string): string {
  const h = hueOf(key) / 360;
  const s = 0.52;
  const l = 0.48;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Set or remove the `#colour` on a key's line of the book, keeping the rest of
 * the line (and the file) as it was. Unknown keys leave the text unchanged.
 */
export function setBookColor(text: string, key: string, color: string | null): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const cr = lines[i].endsWith("\r") ? "\r" : "";
    const m = LINE_RE.exec(lines[i].replace(/\r$/, ""));
    if (!m || m[1] !== key) continue;
    let body = m[2].replace(/\s*[·•|｜]\s*#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/gi, "");
    if (color) body += ` · ${color}`;
    lines[i] = lines[i].slice(0, lines[i].indexOf("@")) + `@${key}: ${body}` + cr;
    break;
  }
  return lines.join("\n");
}
