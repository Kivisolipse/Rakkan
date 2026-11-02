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

- @claude: Claude (claude-opus-5-5) · AI
- @gpt: GPT (gpt-5) · AI
- @ada: Ada Example · 人 · #3b82f6
- @fakebook: 《一本不存在的书》 (ISBN 000-0-00-000000-0) · 来源
`;

/** The same template in English. */
export const BOOK_TEMPLATE_EN = `# Authors

- @claude: Claude (claude-opus-5-5) · AI
- @gpt: GPT (gpt-5) · AI
- @ada: Ada Example · human · #3b82f6
- @fakebook: "A Book That Does Not Exist" (ISBN 000-0-00-000000-0) · source
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

/** The word for each kind as written in a book line (人 / AI / 来源, or human / AI / source). */
export type KindWords = Record<AuthorKind, string>;

/** A key made from a name: lower case, spaces to hyphens, without the characters a key cannot hold. */
export function keyFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[@:[\]「」『』“”"]/g, "");
}

/** `名字 (标识) · 种类 · #颜色` for one author. */
function bodyOf(a: Author, words: KindWords): string {
  const name = (a.name ?? "").replace(/[·•|｜]/g, " ").replace(/\s+/g, " ").trim();
  const head = a.id ? `${name} (${a.id})`.trim() : name;
  return [head, words[a.kind], a.color].filter(Boolean).join(" · ");
}

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

/** Add `- @key: …` at the end of the book. */
export function addBookAuthor(text: string, a: Author, words: KindWords): string {
  const eol = eolOf(text);
  return text.replace(/\s*$/, "") + `${eol}- @${a.key}: ${bodyOf(a, words)}${eol}`;
}

/** Change the name and/or kind of an author; the model ID, colour and the rest of the line stay. */
export function updateBookAuthor(
  text: string,
  key: string,
  patch: { name?: string; kind?: AuthorKind },
  words: KindWords,
): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const cr = lines[i].endsWith("\r") ? "\r" : "";
    const m = LINE_RE.exec(lines[i].replace(/\r$/, ""));
    if (!m || m[1] !== key) continue;
    const a = { ...parseAuthor(key, m[2]), ...patch };
    lines[i] = lines[i].slice(0, lines[i].indexOf("@")) + `@${key}: ${bodyOf(a, words)}` + cr;
    break;
  }
  return lines.join("\n");
}

/** Remove the first definition of `key`. */
export function removeBookAuthor(text: string, key: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => LINE_RE.exec(l.replace(/\r$/, ""))?.[1] === key);
  if (at >= 0) lines.splice(at, 1);
  return lines.join("\n");
}
