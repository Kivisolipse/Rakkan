import type { Signature } from "./types";

/** Parse `显示名 (标识)`; full-width parentheses are accepted. */
export function parseSignature(raw: string): Signature {
  const s = raw.trim();
  const last = s[s.length - 1];
  if (last === ")" || last === "）") {
    // Walk back to the matching opening parenthesis.
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      const c = s[i];
      if (c === ")" || c === "）") depth++;
      else if (c === "(" || c === "（") {
        depth--;
        if (depth === 0) {
          const id = s.slice(i + 1, s.length - 1).trim();
          const name = s.slice(0, i).trim();
          if (!id) break;
          return { raw: s, ...(name ? { name } : {}), id };
        }
      }
    }
  }
  return { raw: s, name: s };
}

export interface Family {
  id: string;
  label: string;
}

const FAMILIES: Array<[prefixes: string[], family: Family]> = [
  [["claude"], { id: "claude", label: "Claude" }],
  [["gpt", "chatgpt", "o1", "o3", "o4"], { id: "gpt", label: "GPT" }],
  [["gemini"], { id: "gemini", label: "Gemini" }],
  [["deepseek"], { id: "deepseek", label: "DeepSeek" }],
  [["grok"], { id: "grok", label: "Grok" }],
  [["llama"], { id: "llama", label: "Llama" }],
  [["qwen"], { id: "qwen", label: "Qwen" }],
  [["mistral", "mixtral"], { id: "mistral", label: "Mistral" }],
  [["kimi", "moonshot"], { id: "kimi", label: "Kimi" }],
  [["glm"], { id: "glm", label: "GLM" }],
];

export const BUILTIN_FAMILIES: Family[] = FAMILIES.map(([, f]) => f);

export interface ExtraPrefix {
  prefix: string;
  family: string;
  label?: string;
}

function matchPrefix(s: string, extra: ExtraPrefix[]): Family | null {
  const lower = s.toLowerCase();
  for (const e of extra) {
    if (e.prefix && lower.startsWith(e.prefix.toLowerCase())) {
      return { id: e.family, label: e.label ?? e.family };
    }
  }
  for (const [prefixes, family] of FAMILIES) {
    for (const p of prefixes) {
      if (!lower.startsWith(p)) continue;
      // `o1` must not match `ollama`; require a boundary after short prefixes.
      const next = lower.charAt(p.length);
      if (p.length <= 2 && next && /[a-z]/.test(next)) continue;
      return family;
    }
  }
  return null;
}

/** Detect the model family from a model ID, falling back to a display name. */
export function familyOf(
  idOrName: string | undefined,
  extra: ExtraPrefix[] = [],
): Family | null {
  if (!idOrName) return null;
  const direct = matchPrefix(idOrName.trim(), extra);
  if (direct) return direct;
  // Display names such as "Claude 助手" or "ChatGPT".
  for (const word of idOrName.split(/[\s/·・,，]+/)) {
    const f = matchPrefix(word, extra);
    if (f) return f;
  }
  return null;
}

export function signatureFamily(
  sig: Signature,
  extra: ExtraPrefix[] = [],
): Family | null {
  return familyOf(sig.id, extra) ?? familyOf(sig.name, extra);
}

/** What to show for a signature: the display name, or the family when only an ID is given. */
export function signatureLabel(sig: Signature, extra: ExtraPrefix[] = []): string {
  if (sig.name) return sig.name;
  return signatureFamily(sig, extra)?.label ?? sig.id ?? "AI";
}
