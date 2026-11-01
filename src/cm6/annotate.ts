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
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import { diffChanges, rewriteLineDetailed, type InlineSpan, type ParseResult, type TextChange } from "../core";
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

const isIsland = (s: InlineSpan) => s.type === "marker" && s.attr.kind === "human";

/**
 * True when text typed at `pos` is in an AI region and outside any island,
 * so it has to be wrapped. Quotes are left alone until M6.
 */
export function needsWrap(r: ParseResult, lineIdx: number, pos: number): boolean {
  const ctx = r.lineContexts[lineIdx];
  if (!ctx || ctx.mode !== "prose" || ctx.pair === "quote") return false;
  if (pos < r.lines[lineIdx].from + ctx.prefix) return false;
  const span = innermost(spansOnLine(r, lineIdx), pos);
  if (span) return span.type === "marker" && span.attr.kind === "ai";
  return ctx.base.kind === "ai";
}

/** Typed text that is a marker character is the user writing markers by hand. */
const hasMarkerChar = (s: string) => s.includes("@") || s.includes("&");

// ── Wrapping ────────────────────────────────────────────────────────────

/**
 * Rewrite one line so that the characters in `ranges` (line offsets) belong
 * to the user. Returns the text edits (line offsets), or null if the line
 * cannot be rewritten safely.
 */
export function wrapRanges(
  r: ParseResult,
  lineIdx: number,
  lineText: string,
  ranges: Range[],
): TextChange[] | null {
  const ctx = r.lineContexts[lineIdx];
  if (!ctx) return null;
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
    if (ev && ev.startsWith("input.type.compose")) {
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
    const edits = wrapRanges(r, n - 1, line.text, ranges);
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
  if (!ctx || ctx.mode !== "prose") return null;
  const span = innermost(spansOnLine(r, idx), from);
  if (!span || !isIsland(span) || span.attr.key || span.to !== span.contentTo + 2) return null;

  const doc = tr.startState.doc;
  const content = doc.sliceString(span.contentFrom, span.contentTo);
  const before = content.slice(0, from - span.contentFrom);
  const after = content.slice(from - span.contentFrom);
  const head = before ? `@@${before}@@` : "";
  const tail = after ? `@@${after}@@` : "";
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
      if (!text || text.includes("\n") || !text.trim() || hasMarkerChar(text)) return;
      const lineA = oldDoc.lineAt(fromA);
      if (oldDoc.lineAt(toA).number !== lineA.number) return;
      const idx = lineA.number - 1;
      if (usedLines.has(idx) || !needsWrap(r, idx, fromA)) return;
      usedLines.add(idx);
      const lineB = newDoc.lineAt(fromB);
      const edits = wrapRanges(r, idx, lineB.text, [{ from: fromB - lineB.from, to: toB - lineB.from }]);
      if (edits) for (const e of edits) extras.push({ from: lineB.from + e.from, to: lineB.from + e.to, insert: e.insert });
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
  for (const n of [...lines].sort((x, y) => x - y)) spans.push(...spansOnLine(r, n));

  const handled = new Set<InlineSpan>();
  const plain = (s: InlineSpan) =>
    s.type === "marker" && !s.attr.key && s.to === s.contentTo + 2 && s.contentFrom === s.from + 2;
  const markerChar = (s: InlineSpan) => (s.attr.kind === "ai" ? "&" : "@");

  // Islands whose content is gone, with both markers still there.
  for (const s of spans) {
    if (!plain(s) || s.contentTo <= s.contentFrom) continue;
    if (overlaps(tr.changes, s.from, s.contentFrom) || overlaps(tr.changes, s.contentTo, s.to)) continue;
    const cf = tr.changes.mapPos(s.contentFrom, 1);
    if (cf !== tr.changes.mapPos(s.contentTo, -1)) continue;
    extras.push({ from: cf - 2, to: cf + 2, insert: "" });
    handled.add(s);
  }

  // The text between two spans of the same kind is gone: join them.
  for (let i = 0; i + 1 < spans.length; i++) {
    const a = spans[i];
    const b = spans[i + 1];
    if (handled.has(a) || handled.has(b) || !plain(a) || !plain(b)) continue;
    if (a.type !== b.type || a.attr.kind !== b.attr.kind || markerChar(a) !== markerChar(b)) continue;
    if (b.from < a.to || a.contentTo === a.contentFrom || b.contentTo === b.contentFrom) continue;
    if (overlaps(tr.changes, a.contentTo, a.to) || overlaps(tr.changes, b.from, b.contentFrom)) continue;
    const p = tr.changes.mapPos(a.contentTo, -1);
    if (tr.changes.mapPos(a.to, -1) !== p + 2 || tr.changes.mapPos(b.from, 1) !== p + 2) continue;
    // Only when something between them was deleted; spans that already touch are literal.
    if (b.from === a.to) continue;
    extras.push({ from: p, to: p + 4, insert: "" });
    handled.add(a);
    handled.add(b);
  }
  return extras;
}

export function annotateFilter(cfg: AnnotateConfig): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !cfg.enabled()) return tr;
    const ev = tr.annotation(Transaction.userEvent);
    if (!ev) return tr;
    const typing = TYPING_EVENTS.has(ev);
    const deleting = ev.startsWith("delete");
    if (!typing && !deleting) return tr;

    const r = tr.startState.field(parseField, false);
    if (!r) return tr;

    if (typing) {
      const split = splitIsland(tr, r);
      if (split) return split;
    }

    const extras = extrasFor(tr, r, typing);
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
  return [parseField, pendingField, annotateFilter(cfg)];
}
