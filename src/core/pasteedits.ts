// "Paste edits": the clipboard holds an edited version of the selected text
// (an essay corrected by an AI, say). Only the words that changed are
// attributed to the editor; everything that was kept keeps its owner.

export interface PasteEdits {
  /** The edited text. */
  plain: string;
  /** One character per character of `plain`: `A` for what the edit changed, otherwise the old owner. */
  owners: string;
  /** How many separate places were changed. */
  changed: number;
}

interface Token {
  text: string;
  start: number;
}

/** Latin words (with inner apostrophes and hyphens), runs of whitespace, or one character (CJK, punctuation). */
const TOKEN_RE = /[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*|\s+|[\s\S]/gu;

function tokenize(s: string): Token[] {
  return Array.from(s.matchAll(TOKEN_RE), (m) => ({ text: m[0], start: m.index }));
}

/** Beyond this many table cells, give up on a fine diff and treat the text as rewritten. */
const MAX_CELLS = 6_000_000;

/**
 * @param original the selected text, markers removed
 * @param owners   its owner for every character (`A` or `H`), same length as `original`
 * @param edited   the clipboard
 */
export function pasteEdits(original: string, owners: string, edited: string): PasteEdits {
  let text = edited.replace(/\r\n/g, "\n");
  // A trailing line break or indent that the original did not have is noise from the copy.
  if (!/\s$/.test(original)) text = text.replace(/\s+$/, "");
  if (!/^\s/.test(original)) text = text.replace(/^\s+/, "");

  const a = tokenize(original);
  const b = tokenize(text);
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_CELLS) {
    return { plain: text, owners: "A".repeat(text.length), changed: text === original ? 0 : 1 };
  }

  // Longest common subsequence of tokens.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].text === b[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let out = "";
  let own = "";
  let changed = 0;
  let inChange = false;
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && a[i].text === b[j].text && dp[i][j] === dp[i + 1][j + 1] + 1) {
      out += b[j].text;
      own += owners.slice(a[i].start, a[i].start + a[i].text.length);
      inChange = false;
      i++;
      j++;
    } else if (i < n && (dp[i + 1][j] >= dp[i][j + 1] || j >= m)) {
      i++; // deleted
    } else {
      const t = b[j].text;
      if (/\S/.test(t)) {
        if (!inChange) changed++;
        inChange = true;
        own += "A".repeat(t.length);
      } else {
        // Spaces inserted next to a change belong with it; elsewhere they take the neighbour's owner.
        own += inChange ? "A".repeat(t.length) : (own.slice(-1) || "H").repeat(t.length);
      }
      out += t;
      j++;
    }
  }
  return { plain: out, owners: own, changed };
}
