// Paste revision: the clipboard holds an edited version of the selected text
// (an essay corrected by an AI, say). Only the words that changed are
// attributed to the editor; everything that was kept keeps its owner. The
// plugin and the rakkan command's `sign` both go through signRevision, which
// carries the owners with this diff.

/** Latin words (with inner apostrophes and hyphens), runs of whitespace, or one character (CJK, punctuation). */
const TOKEN_RE = /[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*|\s+|[\s\S]/gu;

const tokenize = (s: string) => Array.from(s.matchAll(TOKEN_RE), (m) => m[0]);

/** Lines with their line breaks. */
const splitLines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Beyond this much work, give up on a fine diff and treat the text as rewritten. */
const MAX_CELLS = 6_000_000;

/**
 * Index pairs of a longest common subsequence, in order, or null when the two
 * differ in too many places. Myers' diff: the work grows with the number of
 * differences, so a few edits in a long note stay cheap.
 */
function lcs(a: string[], b: string[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(n + m, 2000, Math.floor(MAX_CELLS / (n + m + 1)));
  const off = maxD + 1;
  // v[off + k]: how far along x the path on diagonal k = x - y has come.
  const v = new Int32Array(2 * off + 1);
  // Before each round d, v for k in [-d - 1, d + 1], to walk back the path.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return walkBack(trace, n, m);
    }
  }
  return null;
}

function walkBack(trace: Int32Array[], n: number, m: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const at = (k: number) => v[k + d + 1];
    const k = x - y;
    const prev = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(prev);
    const py = px - prev;
    while (x > px && y > py) pairs.push([--x, --y]);
    if (d > 0) {
      x = px;
      y = py;
    }
  }
  return pairs.reverse();
}

/** Owners for `edited` within one changed stretch, word by word; `before` is the owner of the character before it. */
function carryWords(original: string, owners: string, edited: string, before: string): { owners: string; changed: number } {
  const a = tokenize(original);
  const b = tokenize(edited);
  const pairs = lcs(a, b);
  if (!pairs) return { owners: "A".repeat(edited.length), changed: edited === original ? 0 : 1 };
  const start: number[] = [];
  let at = 0;
  for (const t of a) {
    start.push(at);
    at += t.length;
  }
  const kept = new Map(pairs.map(([i, j]) => [j, i]));
  let own = "";
  let changed = 0;
  let inChange = false;
  for (let j = 0; j < b.length; j++) {
    const t = b[j];
    const i = kept.get(j);
    if (i !== undefined) {
      own += owners.slice(start[i], start[i] + t.length);
      inChange = false;
    } else if (/\S/.test(t)) {
      if (!inChange) changed++;
      inChange = true;
      own += "A".repeat(t.length);
    } else {
      // Spaces inserted next to a change belong with it; elsewhere they take the neighbour's owner.
      own += inChange ? "A".repeat(t.length) : (own.slice(-1) || before).repeat(t.length);
    }
  }
  return { owners: own, changed };
}

/**
 * Lines that may pair up: only those that occur once on each side, as in
 * patience diff. A blank line or a repeated one could pair with the wrong
 * copy and push the lines after it out of line; such lines are left to the
 * word diff between the anchors.
 */
function anchors(a: string[], b: string[]): [string[], string[]] {
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const keep = (l: string) => ca.get(l) === 1 && cb.get(l) === 1 && /\S/.test(l);
  return [a.map((l, i) => (keep(l) ? l : `\u0000a${i}`)), b.map((l, i) => (keep(l) ? l : `\u0000b${i}`))];
}

/**
 * Owners for `edited`, one character each: `A` where the edit changed the
 * text, elsewhere the owner of the same character in `original`. Lines are
 * matched first, so that edits far apart in a long note stay cheap, then the
 * words of the lines in between.
 */
export function carryOwners(original: string, owners: string, edited: string): { owners: string; changed: number } {
  const a = splitLines(original);
  const b = splitLines(edited);
  const start: number[] = [];
  let at = 0;
  for (const l of a) {
    start.push(at);
    at += l.length;
  }
  start.push(at);
  const pairs = lcs(...anchors(a, b)) ?? [];
  pairs.push([a.length, b.length]);
  let own = "";
  let changed = 0;
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    if (pj > j) {
      const r = carryWords(a.slice(i, pi).join(""), owners.slice(start[i], start[pi]), b.slice(j, pj).join(""), own.slice(-1) || "H");
      own += r.owners;
      changed += r.changed;
    }
    if (pi < a.length) own += owners.slice(start[pi], start[pi + 1]);
    i = pi + 1;
    j = pj + 1;
  }
  return { owners: own, changed };
}

/** The clipboard as the selection's replacement: a line break or indent at either end that the selection did not have is noise from the copy. */
export function trimPaste(selected: string, edited: string): string {
  let text = edited.replace(/\r\n/g, "\n");
  if (!/\s$/.test(selected)) text = text.replace(/\s+$/, "");
  if (!/^\s/.test(selected)) text = text.replace(/^\s+/, "");
  return text;
}
