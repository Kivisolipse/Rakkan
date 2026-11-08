// The authorship archive: what removing every marker from a vault takes out of
// each note, so the markers can be put back later. It holds no text of the
// notes, only where each marker was and the hash of the note without them.
// A note edited after its markers were removed no longer matches its hash and
// cannot be restored: there is no telling where its markers would go.

import { plainWithMap, type PlainOptions } from "./export";
import { sha256Hex } from "./ia";

/** The archive's place, at the root of the vault. */
export const ARCHIVE_PATH = "rakkan-authorship.json";

const FORMAT = "rakkan-authorship";
const VERSION = 1;

/** Replace `length` characters of the plain text at `at` with `text`. Offsets are UTF-16 code units. */
export type ArchiveEdit = [at: number, length: number, text: string];

export interface ArchiveEntry {
  /** Where the note was when its markers were removed. */
  path: string;
  /** SHA-256 of the note without markers, line breaks as `\n`. */
  sha256: string;
  /** Turn the plain note back into the marked one, in order of `at`. */
  edits: ArchiveEdit[];
}

export interface Archive {
  format: typeof FORMAT;
  version: typeof VERSION;
  about: string;
  /** Oldest first. */
  notes: ArchiveEntry[];
}

export interface ArchivedNote {
  /** The note to write, without markers. */
  plain: string;
  sha256: string;
  edits: ArchiveEdit[];
}

const ABOUT =
  "Rakkan authorship archive: the markers removed from these notes. With the Rakkan plugin installed, run “从署名存档恢复标记” (Restore markers from the authorship archive). A note changed since then cannot be restored.";

const lf = (s: string) => s.replace(/\r\n/g, "\n");

/** The hash an archive entry keeps for this text. */
export function plainHash(text: string): string {
  return sha256Hex(new TextEncoder().encode(lf(text)));
}

export function applyArchiveEdits(plain: string, edits: ArchiveEdit[]): string {
  let out = plain;
  for (let i = edits.length - 1; i >= 0; i--) {
    const [at, length, text] = edits[i];
    out = out.slice(0, at) + text + out.slice(at + length);
  }
  return out;
}

/**
 * The note without markers, and what puts them back; null when it has none.
 * Line breaks become `\n`, in the plain note and in the one restored.
 */
export function archiveNote(text: string, opts: PlainOptions = {}): ArchivedNote | null {
  const original = lf(text);
  const { text: plain, map } = plainWithMap(original, opts);
  if (plain === original) return null;

  // Each plain character is either the original's character at map[i] (in
  // order) or part of a replacement (-1); the gaps between are what was removed.
  const edits: ArchiveEdit[] = [];
  let next = 0;
  let replaced = -1;
  for (let i = 0; i <= plain.length; i++) {
    const k = i < plain.length ? map[i] : original.length;
    if (k < 0) {
      if (replaced < 0) replaced = i;
      continue;
    }
    const from = replaced < 0 ? i : replaced;
    if (k > next || from < i) edits.push([from, i - from, original.slice(next, k)]);
    replaced = -1;
    next = k + 1;
  }
  if (applyArchiveEdits(plain, edits) !== original) throw new Error("archive edits do not restore the note");
  return { plain, sha256: plainHash(plain), edits };
}

/** The marked note again, or null when `text` is not the plain note the entry was made from. */
export function restoreNote(text: string, entry: ArchiveEntry): string | null {
  if (plainHash(text) !== entry.sha256) return null;
  return applyArchiveEdits(lf(text), entry.edits);
}

export function emptyArchive(): Archive {
  return { format: FORMAT, version: VERSION, about: ABOUT, notes: [] };
}

export function serializeArchive(a: Archive): string {
  // One note per line keeps a large archive readable and its diffs small.
  const notes = a.notes.map((n) => "    " + JSON.stringify(n)).join(",\n");
  const head = JSON.stringify({ format: a.format, version: a.version, about: a.about }, null, 2).slice(0, -2);
  return `${head},\n  "notes": [${notes ? "\n" + notes + "\n  " : ""}]\n}\n`;
}

const isEdit = (e: unknown): e is ArchiveEdit =>
  Array.isArray(e) && e.length === 3 && Number.isInteger(e[0]) && e[0] >= 0 && Number.isInteger(e[1]) && e[1] >= 0 && typeof e[2] === "string";

const isEntry = (n: unknown): n is ArchiveEntry => {
  if (!n || typeof n !== "object") return false;
  const e = n as Record<string, unknown>;
  return typeof e.path === "string" && typeof e.sha256 === "string" && /^[0-9a-f]{64}$/.test(e.sha256) && Array.isArray(e.edits) && e.edits.every(isEdit);
};

/** The archive in `json`, or null when it is not one this version can read. */
export function parseArchive(json: string): Archive | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.format !== FORMAT || d.version !== VERSION || !Array.isArray(d.notes) || !d.notes.every(isEntry)) return null;
  return { format: FORMAT, version: VERSION, about: ABOUT, notes: d.notes };
}

export interface RestorePlan {
  /** Entries that match a note, with that note's path now. */
  restore: Array<{ entry: ArchiveEntry; path: string }>;
  /** The note is still there but has changed. */
  changed: ArchiveEntry[];
  /** No note has this path or this content. */
  missing: ArchiveEntry[];
  /** Moved, but several notes have its content. */
  ambiguous: ArchiveEntry[];
}

/**
 * Which note each entry belongs to: the one at its path when the hash agrees,
 * otherwise the only unclaimed note with its hash (moved or renamed). A note
 * goes to one entry, the newest that matches.
 */
export function planRestore(archive: Archive, notes: Array<{ path: string; hash: string }>): RestorePlan {
  const byPath = new Map(notes.map((n) => [n.path, n.hash]));
  const byHash = new Map<string, string[]>();
  for (const n of notes) byHash.set(n.hash, [...(byHash.get(n.hash) ?? []), n.path]);

  const plan: RestorePlan = { restore: [], changed: [], missing: [], ambiguous: [] };
  const claimed = new Set<string>();
  const rest: ArchiveEntry[] = [];
  const newest = [...archive.notes].reverse();
  for (const entry of newest) {
    if (byPath.get(entry.path) === entry.sha256 && !claimed.has(entry.path)) {
      claimed.add(entry.path);
      plan.restore.push({ entry, path: entry.path });
    } else rest.push(entry);
  }
  for (const entry of rest) {
    const free = (byHash.get(entry.sha256) ?? []).filter((p) => !claimed.has(p));
    if (free.length === 1) {
      claimed.add(free[0]);
      plan.restore.push({ entry, path: free[0] });
    } else if (free.length > 1) plan.ambiguous.push(entry);
    else if (byPath.has(entry.path)) plan.changed.push(entry);
    else plan.missing.push(entry);
  }
  return plan;
}
