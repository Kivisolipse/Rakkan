// Auto-annotation: whatever the user types inside an AI region (an AI block
// or an inline `&&…&&`) is theirs, so it is wrapped in `@@…@@` as they type.
//
// - Plain typing is rewritten inside the same transaction, so one Ctrl+Z
//   removes the typed text together with its markers.
// - IME composition must not be touched while it runs. Composed text is
//   remembered as a pending range and wrapped after a pause, as a separate
//   change that is kept out of the undo history.
// - Enter inside an island closes it before the line break and reopens it
//   after (islands never span lines).
// - Deleting the last character of an island removes its markers; deleting
//   the text between two islands of the same kind joins them.
//
// Only depends on @codemirror/state.

import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type ChangeDesc,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import {
  diffChanges,
  parse,
  rewriteCodeLine,
  rewriteLineDetailed,
  type InlineSpan,
  type LineContext,
  type ParseResult,
  type TextChange,
} from "../core";
import { parseField } from "./parsefield";

export interface AnnotateConfig {
  enabled(): boolean;
}

/** Pause after the last composed character before the text is wrapped. */
export const IME_PAUSE_MS = 600;

const TYPING_EVENTS = new Set(["input.type", "input.complete", "input"]);

interface Range {
  from: number;
  to: number;
}

// ── Where does typed text belong? ───────────────────────────────────────

/** Inline spans that start on a line. Spans are sorted by `from`. */
function spansOnLine(r: ParseResult, lineIdx: number): InlineSpan[] {
  const line = r.lines[lineIdx];
  let lo = 0;
  let hi = r.spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.spans[mid].from < line.from) lo = mid + 1;
    else hi = mid;
  }
  const out: InlineSpan[] = [];
  for (let i = lo; i < r.spans.length && r.spans[i].from <= line.to; i++) out.push(r.spans[i]);
  return out;
}

/** Innermost span whose content contains `pos` (ends included). */
function innermost(spans: InlineSpan[], pos: number): InlineSpan | null {
  let best: InlineSpan | null = null;
  for (const s of spans) {
    if (pos >= s.contentFrom && pos <= s.contentTo && (!best || s.contentFrom >= best.contentFrom)) best = s;
  }
  return best;
}

/** A marker pair with the same opener and closer length and no cite after it. */
const plainSpan = (s: InlineSpan) =>
  s.type === "marker" && !s.attr.key && s.contentFrom - s.from === s.to - s.contentTo && s.contentFrom - s.from >= 2;

const isIsland = (s: InlineSpan) => s.type === "marker" && s.attr.kind === "human";

/** Where typed text lands, when it has to be wrapped. */
export type Zone =
  /** An AI block or an inline AI span: the whole line is rewritten. */
  | { kind: "line" }
  /** Inside `「…」[@key]` on this line: only the quote's content is rewritten. */
  | { kind: "quote"; contentFrom: number; contentTo: number }
  /** A line of a cited blockquote: everything after the `> ` prefix is quote content. */
  | { kind: "quoteLine" }
  /** A line of a code block whose fence already declares `@@`. */
  | { kind: "code" }
  /** A line of a code block in an AI block that does not declare `@@` yet: declare it, then wrap. */
  | { kind: "codeDeclare"; fenceLine: number; len: number };

/**
 * The zone text typed at `pos` belongs to when it must be wrapped in `@@…@@`,
 * or null when it needs nothing (human text, or already inside an island).
 */
export function zoneAt(r: ParseResult, lineIdx: number, pos: number): Zone | null {
  const ctx = r.lineContexts[lineIdx];
  if (!ctx) return null;
  if (ctx.codeFence !== undefined) {
    // Code inside an AI block: the typed text is the user's, written with the block's declared marker.
    if (ctx.base.kind !== "ai" || ctx.pair !== "ai-block") return null;
    if (ctx.mode === "code") {
      if (ctx.atLen < 2 || innermost(spansOnLine(r, lineIdx), pos)) return null;
      return { kind: "code" };
    }
    return { kind: "codeDeclare", fenceLine: ctx.codeFence, len: declaredLength(r, ctx.codeFence) };
  }
  if (ctx.mode !== "prose") return null;
  if (pos < r.lines[lineIdx].from + ctx.prefix) return null;
  const span = innermost(spansOnLine(r, lineIdx), pos);
  if (ctx.pair === "quote") {
    // A cited blockquote line: quote text unless an island or AI span says otherwise.
    return span && span.type === "marker" ? null : { kind: "quoteLine" };
  }
  if (span) {
    if (span.type === "quote") return { kind: "quote", contentFrom: span.contentFrom, contentTo: span.contentTo };
    return span.attr.kind === "ai" ? { kind: "line" } : null;
  }
  return ctx.base.kind === "ai" ? { kind: "line" } : null;
}

/** The marker length to declare for a code block: one more than the longest run of `@` in it (at least 2). */
function declaredLength(r: ParseResult, fenceLine: number): number {
  let longest = 0;
  for (let i = fenceLine + 1; i < r.lineContexts.length && r.lineContexts[i].codeFence === fenceLine; i++) {
    const line = r.lines[i];
    for (const m of r.text.slice(line.from, line.to).matchAll(/@+/g)) longest = Math.max(longest, m[0].length);
  }
  return Math.max(2, longest + 1);
}

export const needsWrap = (r: ParseResult, lineIdx: number, pos: number): boolean => zoneAt(r, lineIdx, pos) !== null;

/** Typed text that is a marker character is the user writing markers by hand. */
const hasMarkerChar = (s: string) => s.includes("@") || s.includes("&");

// ── Wrapping ────────────────────────────────────────────────────────────

/** Inside a quote the unmarked text belongs to the quoted author and `@@` islands are the user's. */
const QUOTE_CTX: LineContext = {
  mode: "prose",
  base: { kind: "ai", explicit: false },
  pair: "ai-block",
  prefix: 0,
  inComment: false,
  ampLen: 2,
  atLen: 2,
};

/**
 * Rewrite one line so that the characters in `ranges` (line offsets) belong
 * to the user. `delta` is how much the line changed in length since `zone`
 * was measured. Returns the text edits (line offsets), or null if the line
 * cannot be rewritten safely.
 */
export function wrapRanges(
  r: ParseResult,
  lineIdx: number,
  lineText: string,
  ranges: Range[],
  zone: Zone = { kind: "line" },
  delta = 0,
): TextChange[] | null {
  const ctx = r.lineContexts[lineIdx];
  if (!ctx) return null;

  // Rewrite only `[from, to)` of the line, as if it were a line of its own.
  const inner = (from: number, to: number, sub: LineContext): TextChange[] | null => {
    const text = lineText.slice(from, to);
    const res = rewriteLineDetailed(text, sub, (chars) => {
      for (const c of chars) {
        const at = c.at + from;
        if (ranges.some((x) => at >= x.from && at < x.to)) {
          c.owner = "human";
          delete c.key;
        }
      }
    });
    if (!res) return null;
    return diffChanges(text, res.text).map((e) => ({ from: e.from + from, to: e.to + from, insert: e.insert }));
  };

  if (zone.kind === "quote") {
    const line = r.lines[lineIdx];
    const from = zone.contentFrom - line.from;
    const to = zone.contentTo - line.from + delta;
    // The change must sit inside the quote, or the quote's own marks are involved.
    if (ranges.some((x) => x.from < from || x.to > to)) return null;
    return inner(from, to, QUOTE_CTX);
  }
  if (zone.kind === "quoteLine") return inner(ctx.prefix, lineText.length, QUOTE_CTX);

  if (zone.kind === "code" || zone.kind === "codeDeclare") {
    const sub: LineContext = zone.kind === "code" ? ctx : { ...ctx, mode: "code", pair: "ai-block", ampLen: 0, atLen: zone.len };
    const res = rewriteCodeLine(lineText, sub, (chars) => {
      for (const c of chars) {
        if (ranges.some((x) => c.at >= x.from && c.at < x.to)) {
          c.owner = "human";
          delete c.key;
        }
      }
    });
    return res ? diffChanges(lineText, res.text) : null;
  }

  const res = rewriteLineDetailed(lineText, ctx, (chars) => {
    for (const c of chars) {
      const at = c.at + ctx.prefix;
      if (ranges.some((x) => at >= x.from && at < x.to)) {
        c.owner = "human";
        delete c.key;
      }
    }
  });
  if (!res) return null;
  return diffChanges(lineText, res.text);
}

// ── Pending IME text ────────────────────────────────────────────────────

export const clearPending = StateEffect.define<null>();

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((x) => x.to > x.from).sort((a, b) => a.from - b.from);
  const out: Range[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else out.push({ ...x });
  }
  return out;
}

/** Composed text that is waiting to be wrapped. */
export const pendingField = StateField.define<readonly Range[]>({
  create: () => [],
  update(value, tr) {
    let out: Range[] = value.slice();
    if (tr.effects.some((e) => e.is(clearPending))) out = [];
    if (!tr.docChanged) return out;
    out = out.map((p) => ({ from: tr.changes.mapPos(p.from, 1), to: tr.changes.mapPos(p.to, -1) }));
    const ev = tr.annotation(Transaction.userEvent);
    // Redo puts back composed text that the wrap step (outside the history) never covered.
    if (ev && (ev.startsWith("input.type.compose") || ev === "redo")) {
      const r = tr.startState.field(parseField, false);
      if (r) {
        tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          const text = inserted.toString();
          if (!text || text.includes("\n") || hasMarkerChar(text)) return;
          const doc = tr.startState.doc;
          const line = doc.lineAt(fromA);
          if (doc.lineAt(toA).number !== line.number) return;
          if (needsWrap(r, line.number - 1, fromA)) out.push({ from: fromB, to: toB });
        });
      }
    }
    return mergeRanges(out);
  },
});

/** The change that wraps everything pending, or null when nothing is. */
export function flushSpec(state: EditorState, cfg: AnnotateConfig): TransactionSpec | null {
  const pending = state.field(pendingField, false);
  if (!pending || !pending.length) return null;
  const clear = clearPending.of(null);
  if (!cfg.enabled()) return { effects: clear, annotations: Transaction.addToHistory.of(false) };

  const r = state.field(parseField);
  const { doc } = state;
  const byLine = new Map<number, Range[]>();
  for (const p of pending) {
    const first = doc.lineAt(p.from).number;
    const last = doc.lineAt(Math.max(p.from, p.to - 1)).number;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      const x = { from: Math.max(p.from, line.from) - line.from, to: Math.min(p.to, line.to) - line.from };
      if (x.to > x.from) byLine.set(n, [...(byLine.get(n) ?? []), x]);
    }
  }
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const [n, ranges] of byLine) {
    const line = doc.line(n);
    const zone = zoneAt(r, n - 1, line.from + ranges[0].from);
    const edits = zone ? wrapRanges(r, n - 1, line.text, ranges, zone) : null;
    if (edits) for (const e of edits) changes.push({ from: line.from + e.from, to: line.from + e.to, insert: e.insert });
  }
  return {
    changes,
    effects: clear,
    // Kept out of the undo history: undo takes back the typed text, and the
    // leftover empty island is cleaned up like any other.
    annotations: [Transaction.addToHistory.of(false), Transaction.userEvent.of("input.rakkan.wrap")],
  };
}

/**
 * After an undo: the wrap step is not in the undo history, so undoing composed
 * text takes back the characters and leaves their markers behind as `@@@@`.
 * Remove such empty pairs next to the changed ranges, in AI regions only.
 */
export function cleanupSpec(state: EditorState, changes: ChangeDesc): TransactionSpec | null {
  const r = state.field(parseField, false);
  if (!r) return null;
  const { doc } = state;
  const found = new Map<number, { from: number; to: number; insert: string }>();
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const line = doc.lineAt(fromB);
    if (doc.lineAt(toB).number !== line.number) return;
    const a = fromB - line.from;
    const b = toB - line.from;
    const ctx = r.lineContexts[line.number - 1];
    const len = ctx?.mode === "code" ? ctx.atLen : 2;
    const re = /@+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line.text))) {
      if (m[0].length !== 2 * len || m.index > b || m.index + 2 * len < a) continue;
      if (!needsWrap(r, line.number - 1, line.from + m.index + len)) continue;
      const from = line.from + m.index;
      found.set(from, { from, to: from + 2 * len, insert: "" });
    }
  });
  if (!found.size) return null;
  return {
    changes: [...found.values()],
    annotations: [Transaction.addToHistory.of(false), Transaction.userEvent.of("input.rakkan.cleanup")],
  };
}

// ── The transaction filter ──────────────────────────────────────────────

/** The annotations that decide how a transaction is treated, for a replacement spec. */
function carry(tr: Transaction): Annotation<unknown>[] {
  const out: Annotation<unknown>[] = [];
  const ev = tr.annotation(Transaction.userEvent);
  if (ev) out.push(Transaction.userEvent.of(ev));
  const history = tr.annotation(Transaction.addToHistory);
  if (history !== undefined) out.push(Transaction.addToHistory.of(history));
  return out;
}

const overlaps = (changes: ChangeSet, a: number, b: number): boolean => {
  let hit = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA < b && toA > a) hit = true;
    else if (fromA === toA && fromA > a && fromA < b) hit = true;
  });
  return hit;
};

/** Enter inside an island: close it before the line break and reopen it after. */
function splitIsland(tr: Transaction, r: ParseResult): TransactionSpec | null {
  let only: { from: number; to: number; text: string } | null = null;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    count++;
    only = { from: fromA, to: toA, text: inserted.toString() };
  });
  if (count !== 1 || !only) return null;
  const { from, to, text } = only as { from: number; to: number; text: string };
  if (from !== to || !text.includes("\n")) return null;

  const idx = tr.startState.doc.lineAt(from).number - 1;
  const ctx = r.lineContexts[idx];
  if (!ctx || (ctx.mode !== "prose" && ctx.mode !== "code")) return null;
  const span = innermost(spansOnLine(r, idx), from);
  if (!span || !isIsland(span) || span.attr.key || !plainSpan(span)) return null;

  const doc = tr.startState.doc;
  const mark = "@".repeat(span.contentFrom - span.from);
  const content = doc.sliceString(span.contentFrom, span.contentTo);
  const before = content.slice(0, from - span.contentFrom);
  const after = content.slice(from - span.contentFrom);
  const head = before ? mark + before + mark : "";
  const tail = after ? mark + after + mark : "";
  return {
    changes: { from: span.from, to: span.to, insert: head + text + tail },
    selection: EditorSelection.cursor(span.from + head.length + text.length),
    annotations: carry(tr),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
  };
}

/** Wrap typed text and tidy islands after a deletion. Returns extra changes (new document coordinates). */
function extrasFor(tr: Transaction, r: ParseResult, typing: boolean): TextChange[] {
  const extras: TextChange[] = [];
  const oldDoc = tr.startState.doc;
  const newDoc = tr.newDoc;
  const usedLines = new Set<number>();

  if (typing) {
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      const text = inserted.toString();
      if (!text || text.includes("\n") || !text.trim()) return;
      const lineA = oldDoc.lineAt(fromA);
      if (oldDoc.lineAt(toA).number !== lineA.number) return;
      const idx = lineA.number - 1;
      const zone = usedLines.has(idx) ? null : zoneAt(r, idx, fromA);
      if (!zone) return;
      // Typed marker characters are the user writing markers by hand. In code only the human marker is one.
      const isCode = zone.kind === "code" || zone.kind === "codeDeclare";
      if (isCode ? text.includes("@") : hasMarkerChar(text)) return;
      usedLines.add(idx);
      const lineB = newDoc.lineAt(fromB);
      const delta = toB - fromB - (toA - fromA);
      const edits = wrapRanges(r, idx, lineB.text, [{ from: fromB - lineB.from, to: toB - lineB.from }], zone, delta);
      if (!edits) return;
      for (const e of edits) extras.push({ from: lineB.from + e.from, to: lineB.from + e.to, insert: e.insert });
      if (zone.kind === "codeDeclare" && edits.length) {
        // The fence now says which marker the block uses.
        const fence = newDoc.line(zone.fenceLine + 1);
        extras.push({ from: fence.to, to: fence.to, insert: " " + "@".repeat(zone.len) });
      }
    });
    return extras;
  }

  // Deletions: look at spans on the lines around each change.
  const lines = new Set<number>();
  tr.changes.iterChangedRanges((fromA, toA) => {
    const a = oldDoc.lineAt(fromA).number - 1;
    const b = oldDoc.lineAt(toA).number - 1;
    for (let n = Math.max(0, a - 1); n <= Math.min(r.lines.length - 1, b + 1); n++) lines.add(n);
  });
  const spans: InlineSpan[] = [];
  const spanLine = new Map<InlineSpan, number>();
  for (const n of [...lines].sort((x, y) => x - y)) {
    for (const sp of spansOnLine(r, n)) {
      spans.push(sp);
      spanLine.set(sp, n);
    }
  }

  const handled = new Set<InlineSpan>();
  const plain = plainSpan;
  const markerChar = (s: InlineSpan) => (s.attr.kind === "ai" ? "&" : "@");

  // Islands whose content is gone, with both markers still there.
  for (const s of spans) {
    if (!plain(s) || s.contentTo <= s.contentFrom) continue;
    if (overlaps(tr.changes, s.from, s.contentFrom) || overlaps(tr.changes, s.contentTo, s.to)) continue;
    const cf = tr.changes.mapPos(s.contentFrom, 1);
    if (cf !== tr.changes.mapPos(s.contentTo, -1)) continue;
    const len = s.contentFrom - s.from;
    extras.push({ from: cf - len, to: cf + len, insert: "" });
    handled.add(s);
  }

  // Islands that were deleted whole, markers and all.
  const dead = new Set(handled);
  for (const s of spans) {
    if (dead.has(s) || !isIsland(s) || s.to <= s.from) continue;
    if (tr.changes.mapPos(s.from, 1) === tr.changes.mapPos(s.to, -1)) dead.add(s);
  }

  // The last island of a code block is gone: the fence no longer needs its declaration.
  const fences = new Set<number>();
  for (const s of dead) {
    const fence = r.lineContexts[spanLine.get(s)!]?.codeFence;
    if (fence !== undefined) fences.add(fence);
  }
  for (const fence of fences) {
    let others = false;
    let atLen = 0;
    for (let i = fence + 1; i < r.lineContexts.length && r.lineContexts[i].codeFence === fence; i++) {
      atLen = Math.max(atLen, r.lineContexts[i].atLen);
      if (spansOnLine(r, i).some((sp) => isIsland(sp) && !dead.has(sp))) others = true;
    }
    if (others || atLen < 2) continue;
    const fl = r.lines[fence];
    if (overlaps(tr.changes, fl.from, fl.to)) continue;
    const m = new RegExp("\\s@{" + atLen + "}(?=\\s|$)").exec(r.text.slice(fl.from, fl.to));
    if (!m) continue;
    extras.push({
      from: tr.changes.mapPos(fl.from + m.index, 1),
      to: tr.changes.mapPos(fl.from + m.index + m[0].length, -1),
      insert: "",
    });
  }

  // The text between two spans of the same kind is gone: join them.
  for (let i = 0; i + 1 < spans.length; i++) {
    const a = spans[i];
    const b = spans[i + 1];
    if (handled.has(a) || handled.has(b) || !plain(a) || !plain(b)) continue;
    if (a.type !== b.type || a.attr.kind !== b.attr.kind || markerChar(a) !== markerChar(b)) continue;
    if (b.from < a.to || a.contentTo === a.contentFrom || b.contentTo === b.contentFrom) continue;
    if (overlaps(tr.changes, a.contentTo, a.to) || overlaps(tr.changes, b.from, b.contentFrom)) continue;
    const len = a.to - a.contentTo;
    if (b.contentFrom - b.from !== len) continue;
    const p = tr.changes.mapPos(a.contentTo, -1);
    if (tr.changes.mapPos(a.to, -1) !== p + len || tr.changes.mapPos(b.from, 1) !== p + len) continue;
    // Only when something between them was deleted; spans that already touch are literal.
    if (b.from === a.to) continue;
    extras.push({ from: p, to: p + 2 * len, insert: "" });
    handled.add(a);
    handled.add(b);
  }
  return extras;
}

// ── Moving text ─────────────────────────────────────────────────────────

/** Who wrote the visible character at `pos` of a parsed note; null where it is not plain text. */
function ownerAt(r: ParseResult, pos: number): { owner: "ai" | "human"; key?: string } | null {
  let lo = 0;
  let hi = r.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (r.segments[mid].from <= pos) lo = mid;
    else hi = mid - 1;
  }
  const s = r.segments[lo];
  if (!s || s.role !== "text" || pos < s.from || pos >= s.to) return null;
  return s.attr.kind === "ai" ? { owner: "ai", ...(s.attr.key ? { key: s.attr.key } : {}) } : { owner: "human" };
}

interface Piece {
  from: number;
  to: number;
  text: string;
}

/**
 * Moving text across an AI block's edge changes what its unmarked words mean:
 * out of a block they would turn into the user's, into one into the AI's. Find
 * the text that was cut and put back elsewhere in the same transaction (the
 * move-line command, a drag and drop, a sorting plugin) and re-mark it so each
 * character keeps its owner.
 *
 * Whole lines are matched line by line, and the lines they jumped over shift
 * with them (a block closer that moved above a line changes that line's
 * region too). A piece of one line is matched character by character.
 */
function relocateExtras(tr: Transaction, r: ParseResult): TextChange[] {
  const oldDoc = tr.startState.doc;
  const newDoc = tr.newDoc;
  const cuts: Piece[] = [];
  const puts: Piece[] = [];
  const mixed: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const added = inserted.toString();
    if (toA > fromA && added) mixed.push({ fromA, toA, fromB, toB });
    else if (toA > fromA) cuts.push({ from: fromA, to: toA, text: oldDoc.sliceString(fromA, toA) });
    else if (added) puts.push({ from: fromB, to: toB, text: added });
  });

  // New line index → old line index, for every line whose place changed.
  const from = new Map<number, number>();
  let odd = false;
  const set = (n: number, o: number) => {
    if (from.has(n)) odd = true;
    from.set(n, o);
  };
  const fragments: Array<{ cut: Piece; put: Piece }> = [];

  if (mixed.length === 1 && !cuts.length && !puts.length) {
    // One replacement that only reorders whole lines (a sort).
    const { fromA, toA, fromB, toB } = mixed[0];
    if (toA - fromA !== toB - fromB) return [];
    const old = oldDoc.sliceString(fromA, toA).split("\n");
    const now = newDoc.sliceString(fromB, toB).split("\n");
    const whole =
      oldDoc.lineAt(fromA).from === fromA && oldDoc.lineAt(toA).to === toA && newDoc.lineAt(fromB).from === fromB && newDoc.lineAt(toB).to === toB;
    if (!whole || old.length !== now.length || old.length < 2) return [];
    const a0 = oldDoc.lineAt(fromA).number - 1;
    const b0 = newDoc.lineAt(fromB).number - 1;
    const used = new Set<number>();
    for (let j = 0; j < now.length; j++) {
      const i = old[j] === now[j] && !used.has(j) ? j : old.findIndex((t, k) => t === now[j] && !used.has(k));
      if (i < 0) return [];
      used.add(i);
      set(b0 + j, a0 + i);
    }
  } else {
    if (mixed.length || !puts.length || puts.length !== cuts.length) return [];
    for (const put of puts) {
      // The move-line command cuts a line together with one of its line breaks, and puts it back with the other.
      const core = (t: string) => t.replace(/^\n|\n$/, "");
      const lead = (t: string) => (t.startsWith("\n") ? 1 : 0);
      const k = cuts.findIndex((c) => core(c.text) === core(put.text));
      if (k < 0) return [];
      const cut = cuts.splice(k, 1)[0];
      const body = core(cut.text);
      const a = cut.from + lead(cut.text);
      const b = put.from + lead(put.text);
      const wholeLines =
        oldDoc.lineAt(a).from === a &&
        oldDoc.lineAt(a + body.length).to === a + body.length &&
        newDoc.lineAt(b).from === b &&
        newDoc.lineAt(b + body.length).to === b + body.length;
      if (!wholeLines) {
        if (!body || /[\n&@]/.test(body)) return [];
        fragments.push({ cut: { from: a, to: a + body.length, text: body }, put: { from: b, to: b + body.length, text: body } });
        continue;
      }
      const count = body.split("\n").length;
      const ao = oldDoc.lineAt(a).number - 1;
      const bn = newDoc.lineAt(b).number - 1;
      for (let i = 0; i < count; i++) set(bn + i, ao + i);
      if (ao > bn) for (let i = bn; i < ao; i++) set(i + count, i);
      else for (let i = ao + count; i < bn + count; i++) set(i - count, i);
    }
  }
  if (odd) return [];

  const nr = parse(newDoc.toString());
  const extras: TextChange[] = [];
  for (const [n, o] of from) {
    const oc = r.lineContexts[o];
    const nc = nr.lineContexts[n];
    if (!oc || !nc || oc.mode !== "prose" || nc.mode !== "prose" || oc.pair === "quote" || nc.pair === "quote") continue;
    if (oc.pair === nc.pair) continue;
    const text = nr.text.slice(nr.lines[n].from, nr.lines[n].to);
    if (!text.trim() || text !== r.text.slice(r.lines[o].from, r.lines[o].to)) continue;

    type Kept = { ch: string; owner: "ai" | "human"; key?: string };
    const found: { kept?: Kept[] } = {};
    rewriteLineDetailed(text, oc, (chars) => {
      found.kept = chars.map((c) => ({ ch: c.ch, owner: c.owner, key: c.key }));
    });
    const kept = found.kept;
    if (!kept) continue;

    // Islands only mean something inside an AI region, so start from the bare characters.
    if (oc.prefix !== nc.prefix) continue;
    const bare = text.slice(0, nc.prefix) + kept.map((c) => c.ch).join("");
    let aligned = true;
    const res = rewriteLineDetailed(bare, nc, (chars) => {
      if (chars.length !== kept.length || chars.some((c, i) => c.ch !== kept[i].ch)) {
        aligned = false;
        return;
      }
      chars.forEach((c, i) => {
        c.owner = kept[i].owner;
        if (kept[i].key === undefined) delete c.key;
        else c.key = kept[i].key;
      });
    });
    if (!res || !aligned) continue;
    for (const e of diffChanges(text, res.text)) {
      extras.push({ from: nr.lines[n].from + e.from, to: nr.lines[n].from + e.to, insert: e.insert });
    }
  }

  // A piece of a line: only its own characters carry the owner they had.
  for (const { cut, put } of fragments) {
    const index = newDoc.lineAt(put.from).number - 1;
    const line = nr.lines[index];
    const nc = nr.lineContexts[index];
    if (!nc || nc.mode !== "prose" || nc.pair === "quote") continue;
    const text = nr.text.slice(line.from, line.to);
    const res = rewriteLineDetailed(text, nc, (chars) => {
      for (const c of chars) {
        const pos = line.from + nc.prefix + c.at;
        if (pos < put.from || pos >= put.to) continue;
        const was = ownerAt(r, cut.from + (pos - put.from));
        if (!was) continue;
        c.owner = was.owner;
        if (was.key) c.key = was.key;
        else delete c.key;
      }
    });
    if (!res) continue;
    for (const e of diffChanges(text, res.text)) extras.push({ from: line.from + e.from, to: line.from + e.to, insert: e.insert });
  }
  return extras;
}

// ── Pasting a run that looks like the code's marker ─────────────────────

/**
 * A code block's declaration says how long its `@` marker is; any other length
 * is code. Pasted code that holds a run of exactly that length (a diff's
 * `@@ -1 +1 @@`) would turn into islands, so make the marker one longer
 * instead: the declaration and the islands already there grow by the same
 * amount.
 */
function bumpExtras(tr: Transaction, r: ParseResult): TextChange[] {
  const oldDoc = tr.startState.doc;
  const newDoc = tr.newDoc;
  const fences = new Map<number, number>();
  tr.changes.iterChanges((fromA, _toA, fromB, toB, inserted) => {
    if (!inserted.length || !inserted.toString().includes("@")) return;
    const ctx = r.lineContexts[oldDoc.lineAt(fromA).number - 1];
    if (!ctx || ctx.codeFence === undefined || ctx.mode !== "code" || ctx.pair !== "ai-block" || ctx.atLen < 2) return;
    const from = newDoc.lineAt(fromB).from;
    const to = newDoc.lineAt(toB).to;
    for (const m of newDoc.sliceString(from, to).matchAll(/@+/g)) {
      const at = from + m.index!;
      if (m[0].length === ctx.atLen && at < toB && at + m[0].length > fromB) fences.set(ctx.codeFence, ctx.atLen);
    }
  });

  const extras: TextChange[] = [];
  for (const [fence, atLen] of fences) {
    let last = fence;
    while (last + 1 < r.lineContexts.length && r.lineContexts[last + 1].codeFence === fence) last++;
    const body = newDoc.sliceString(tr.changes.mapPos(r.lines[fence + 1].from, -1), tr.changes.mapPos(r.lines[last].to, 1));
    let longest = atLen;
    for (const m of body.matchAll(/@+/g)) longest = Math.max(longest, m[0].length);
    const more = "@".repeat(longest + 1 - atLen);

    const fl = r.lines[fence];
    const decl = new RegExp("\\s@{" + atLen + "}(?=\\s|$)").exec(r.text.slice(fl.from, fl.to));
    if (!decl || overlaps(tr.changes, fl.from, fl.to)) continue;
    extras.push({ from: tr.changes.mapPos(fl.from + decl.index + decl[0].length, -1), to: tr.changes.mapPos(fl.from + decl.index + decl[0].length, -1), insert: more });
    for (let i = fence + 1; i <= last; i++) {
      for (const s of spansOnLine(r, i)) {
        if (!isIsland(s) || !plainSpan(s) || s.contentFrom - s.from !== atLen) continue;
        if (overlaps(tr.changes, s.from, s.contentFrom) || overlaps(tr.changes, s.contentTo, s.to)) continue;
        const open = tr.changes.mapPos(s.from, 1);
        const close = tr.changes.mapPos(s.contentTo, -1);
        extras.push({ from: open, to: open, insert: more }, { from: close, to: close, insert: more });
      }
    }
  }
  return extras;
}

/**
 * Chinese input methods turn `[` into 「【」. Typing `@` right after one makes
 * it `[@`, so author keys can be written without switching input method.
 */
export function bracketFix(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(Transaction.userEvent) !== "input.type") return tr;
    let at = -1;
    let count = 0;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      count++;
      if (fromA === toA && inserted.toString() === "@") at = fromA;
    });
    if (count !== 1 || at < 1 || tr.startState.doc.sliceString(at - 1, at) !== "【") return tr;
    return {
      changes: { from: at - 1, to: at, insert: "[@" },
      selection: EditorSelection.cursor(at + 1),
      annotations: carry(tr),
      scrollIntoView: tr.scrollIntoView,
    };
  });
}

export function annotateFilter(cfg: AnnotateConfig): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !cfg.enabled()) return tr;
    const ev = tr.annotation(Transaction.userEvent);
    // Text moved by another plugin carries no event; undo, redo and remote changes put things back as they were.
    const moving = ev === undefined ? tr.annotation(Transaction.addToHistory) !== false && !tr.annotation(Transaction.remote) : ev.startsWith("move");
    if (ev === undefined && !moving) return tr;
    const typing = ev !== undefined && TYPING_EVENTS.has(ev);
    const deleting = ev !== undefined && ev.startsWith("delete");
    const pasting = ev === "input.paste" || ev === "input.drop";
    if (!typing && !deleting && !moving && !pasting) return tr;

    const r = tr.startState.field(parseField, false);
    if (!r) return tr;

    if (typing) {
      const split = splitIsland(tr, r);
      if (split) return split;
    }

    const extras = moving ? relocateExtras(tr, r) : pasting ? bumpExtras(tr, r) : extrasFor(tr, r, typing);
    if (!extras.length) return tr;

    const extraSet = ChangeSet.of(extras, tr.newDoc.length);
    const selection = tr.newSelection;
    return {
      changes: tr.changes.compose(extraSet),
      selection: EditorSelection.create(
        selection.ranges.map((x) => x.map(extraSet, -1)),
        selection.mainIndex,
      ),
      annotations: carry(tr),
      effects: tr.effects,
      scrollIntoView: tr.scrollIntoView,
    };
  });
}

export function annotate(cfg: AnnotateConfig): Extension {
  return [parseField, pendingField, bracketFix(), annotateFilter(cfg)];
}
