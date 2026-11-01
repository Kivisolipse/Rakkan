// Live preview: colour the text by author, hide markers and block lines away
// from the cursor, and keep attribution through copy and paste. Depends only on @codemirror/* so other CM6 hosts can reuse it.

import { ChangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  minimalChange,
  rewriteLine,
  stripMarkers,
  type Attr,
  type InlineSpan,
  type Owner,
  type ParseResult,
  type Segment,
} from "../core";
import { annotate, flushSpec, IME_PAUSE_MS, pendingField } from "./annotate";
import { parseField } from "./parsefield";
import { resolve, type Resolved, type StyleSettings } from "./resolve";

export interface RakkanEditorConfig {
  styles(): StyleSettings;
  /** Hide markers away from the cursor (live preview). */
  hideMarkers(state: EditorState): boolean;
  stripOnCopy(): boolean;
  /** Wrap what the user types inside AI regions in `@@…@@`. */
  autoAnnotate(): boolean;
}

/** Dispatch to force a redraw after settings change. */
export const refreshEffect = StateEffect.define<null>();

export { parseField };

// ── Lookups cached per parse result ────────────────────────────────────

interface Index {
  /** Marker start offset → span it belongs to. */
  spanAt: Map<number, InlineSpan>;
  resolved: Map<Attr, Resolved | null>;
  styles: StyleSettings | null;
}
const indexes = new WeakMap<ParseResult, Index>();

function indexOf(r: ParseResult, styles: StyleSettings): Index {
  let ix = indexes.get(r);
  if (!ix || ix.styles !== styles) {
    const spanAt = new Map<number, InlineSpan>();
    for (const s of r.spans) {
      spanAt.set(s.from, s);
      spanAt.set(s.contentTo, s);
      if (s.to > s.contentTo) {
        // Cite after the closing marker / quote, possibly after one space.
        for (let k = s.contentTo + 1; k < s.to; k++) if (r.text[k] === "[") spanAt.set(k, s);
      }
    }
    ix = { spanAt, resolved: new Map(), styles };
    indexes.set(r, ix);
  }
  return ix;
}

function resolvedFor(ix: Index, r: ParseResult, attr: Attr, styles: StyleSettings) {
  if (!ix.resolved.has(attr)) ix.resolved.set(attr, resolve(attr, r, styles));
  return ix.resolved.get(attr)!;
}

/** First segment that ends after `pos`. */
function firstSegment(segs: Segment[], pos: number): number {
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].to <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── Decorations ─────────────────────────────────────────────────────────

const markCache = new Map<string, Decoration>();
const markDeco = (cls: string, title?: string) => {
  const k = cls + "\u0000" + (title ?? "");
  let d = markCache.get(k);
  if (!d) {
    d = Decoration.mark(title ? { class: cls, attributes: { title } } : { class: cls });
    markCache.set(k, d);
  }
  return d;
};
const hidden = Decoration.replace({});

function touches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function build(view: EditorView, cfg: RakkanEditorConfig): DecorationSet {
  const { state } = view;
  const r = state.field(parseField);
  const styles = cfg.styles();
  const ix = indexOf(r, styles);
  const hide = cfg.hideMarkers(state);
  const out: Range<Decoration>[] = [];

  for (const vr of view.visibleRanges) {
    for (let i = firstSegment(r.segments, vr.from); i < r.segments.length; i++) {
      const s = r.segments[i];
      if (s.from >= vr.to) break;
      if (s.role === "text") {
        const res = resolvedFor(ix, r, s.attr, styles);
        if (!res) continue;
        let cls = res.cls;
        if (s.attr.kind === "human" && s.to - s.from === 1) cls += " rk-island-dot";
        out.push(markDeco(cls).range(s.from, s.to));
        continue;
      }
      if (s.role !== "mark") continue;
      switch (s.mark) {
        case "open":
        case "close":
        case "cite": {
          const span = ix.spanAt.get(s.from);
          const show = !hide || !span || touches(state, span.from, span.to);
          out.push((show ? markDeco("rk-mark") : hidden).range(s.from, s.to));
          break;
        }
        case "block-open":
        case "block-close": {
          // Collapsed together with its blank lines by collapseField; only style it when shown.
          if (!collapsedAt(state, s.from)) out.push(markDeco("rk-mark rk-mark-block").range(s.from, s.to));
          break;
        }
        case "decl":
          out.push(
            markDeco(
              "rk-mark rk-decl",
              `这个代码块启用了 ${state.sliceDoc(s.from, s.to)} 标记，复制时会自动去掉`,
            ).range(s.from, s.to),
          );
          break;
      }
    }
  }

  for (const d of r.diagnostics) {
    if (d.to <= d.from) continue;
    if (!view.visibleRanges.some((vr) => d.from < vr.to && d.to > vr.from)) continue;
    out.push(markDeco("rk-warn", d.message).range(d.from, d.to));
  }

  return Decoration.set(out, true);
}

function decorations(cfg: RakkanEditorConfig) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      hide: boolean;
      constructor(view: EditorView) {
        this.hide = cfg.hideMarkers(view.state);
        this.decorations = build(view, cfg);
      }
      update(u: ViewUpdate) {
        const hide = cfg.hideMarkers(u.state);
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          hide !== this.hide ||
          u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect)))
        ) {
          this.hide = hide;
          this.decorations = build(u.view, cfg);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ── Copy and paste ──────────────────────────────────────────────────────

const MIME = "application/x-rakkan";

interface ClipPayload {
  plain: string;
  /** One character per plain character: A (AI) or H (human). */
  owners: string;
}

function ownerAt(r: ParseResult, pos: number): Owner {
  const i = firstSegment(r.segments, pos);
  const s = r.segments[i];
  return s && s.from <= pos && s.attr.kind === "ai" ? "ai" : "human";
}

function copyHandler(cfg: RakkanEditorConfig, cut: boolean) {
  return (e: ClipboardEvent, view: EditorView) => {
    if (!cfg.stripOnCopy() || !e.clipboardData) return false;
    const ranges = view.state.selection.ranges.filter((rg) => !rg.empty);
    if (!ranges.length) return false;
    const r = view.state.field(parseField);
    let plain = "";
    let owners = "";
    ranges.forEach((rg, n) => {
      if (n) {
        plain += "\n";
        owners += "H";
      }
      const st = stripMarkers(r, rg.from, rg.to);
      plain += st.text;
      for (const pos of st.map) owners += ownerAt(r, pos) === "ai" ? "A" : "H";
    });
    const raw = ranges.map((rg) => view.state.sliceDoc(rg.from, rg.to)).join("\n");
    if (plain === raw && !owners.includes("A")) return false;
    e.clipboardData.setData("text/plain", plain);
    e.clipboardData.setData(MIME, JSON.stringify({ plain, owners } satisfies ClipPayload));
    lastCopy = { plain, owners };
    e.preventDefault();
    if (cut) view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut", scrollIntoView: true });
    return true;
  };
}

/** iOS may drop custom clipboard formats; remember the last copy in memory. */
let lastCopy: ClipPayload | null = null;

/** Insert `plain` at the selection and re-mark it according to `owners`, in one undo step. */
export function pasteWithOwners(view: EditorView, payload: ClipPayload) {
  const { state } = view;
  const sel = state.selection.main;
  const insert = ChangeSet.of({ from: sel.from, to: sel.to, insert: payload.plain }, state.doc.length);
  const mid = state.update({ changes: insert }).state;
  const r = mid.field(parseField);
  const start = sel.from;
  const end = start + payload.plain.length;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const firstLine = mid.doc.lineAt(start).number;
  const lastLine = mid.doc.lineAt(end).number;
  for (let n = firstLine; n <= lastLine; n++) {
    const line = mid.doc.line(n);
    const ctx = r.lineContexts[n - 1];
    const next = rewriteLine(line.text, ctx, (chars) => {
      for (const c of chars) {
        const pos = line.from + ctx.prefix + c.at;
        if (pos < start || pos >= end) continue;
        c.owner = payload.owners[pos - start] === "A" ? "ai" : "human";
        delete c.key;
      }
    });
    if (next === null) continue;
    const ch = minimalChange(line.text, next);
    if (ch) changes.push({ from: line.from + ch.from, to: line.from + ch.to, insert: ch.insert });
  }
  const rewrite = ChangeSet.of(changes, mid.doc.length);
  const all = insert.compose(rewrite);
  // `end` is a position in the intermediate document.
  const cursor = rewrite.mapPos(end, 1);
  view.dispatch({ changes: all, selection: { anchor: cursor }, userEvent: "input.paste", scrollIntoView: true });
}

function pasteHandler(e: ClipboardEvent, view: EditorView) {
  const data = e.clipboardData;
  if (!data) return false;
  const text = data.getData("text/plain");
  let payload: ClipPayload | null = null;
  try {
    const raw = data.getData(MIME);
    if (raw) payload = JSON.parse(raw) as ClipPayload;
  } catch {
    payload = null;
  }
  if (!payload && lastCopy && lastCopy.plain === text) payload = lastCopy;
  if (!payload || payload.plain !== text || payload.owners.length !== text.length) return false;
  e.preventDefault();
  pasteWithOwners(view, payload);
  return true;
}

// ── Collapsing block lines ──────────────────────────────────────────────

const BLANK = /^s*$/;

/**
 * Ranges to collapse away from the cursor: each block opener with the blank
 * lines after it, and each closer with the blank lines before it. The blank
 * line on the outer side stays as the paragraph break, so the text around a
 * block keeps its normal spacing.
 */
function collapsibleRanges(state: EditorState): Array<{ from: number; to: number }> {
  const { doc } = state;
  const r = state.field(parseField);
  const out: Array<{ from: number; to: number }> = [];
  const blank = (n: number) => BLANK.test(doc.line(n).text);
  for (const b of r.blocks) {
    const open = b.openLine + 1;
    const limit = b.closeLine !== null ? b.closeLine + 1 : b.lastLine + 1;
    let end = open;
    while (end + 1 < limit && blank(end + 1)) end++;
    out.push({ from: doc.line(open).from, to: doc.line(end).to });
    if (b.closeLine !== null) {
      const close = b.closeLine + 1;
      let start = close;
      while (start - 1 > end && blank(start - 1)) start--;
      out.push({ from: doc.line(start).from, to: doc.line(close).to });
    }
  }
  // Merge ranges that touch (an empty block collapses as one piece).
  out.sort((a, b) => a.from - b.from);
  const merged: typeof out = [];
  for (const x of out) {
    const last = merged[merged.length - 1];
    if (last && x.from <= last.to + 1) last.to = Math.max(last.to, x.to);
    else merged.push({ ...x });
  }
  return merged;
}

const collapsedCache = new WeakMap<EditorState, DecorationSet>();

function collapsedAt(state: EditorState, pos: number): boolean {
  const set = collapsedCache.get(state);
  if (!set) return false;
  let hit = false;
  set.between(pos, pos, () => {
    hit = true;
    return false;
  });
  return hit;
}

function collapseField(cfg: RakkanEditorConfig) {
  const compute = (state: EditorState): DecorationSet => {
    let set = Decoration.none;
    if (cfg.hideMarkers(state)) {
      const ranges = collapsibleRanges(state).filter((x) => !touches(state, x.from, x.to));
      set = Decoration.set(ranges.map((x) => Decoration.replace({ block: true }).range(x.from, x.to)));
    }
    collapsedCache.set(state, set);
    return set;
  };
  return StateField.define<DecorationSet>({
    create: compute,
    update: (_v, tr) => compute(tr.state),
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * Composed (IME) text is wrapped once the user pauses: the document is not
 * touched while a composition is running. Also flushed when the editor loses focus.
 */
function imeFlush(cfg: RakkanEditorConfig) {
  return ViewPlugin.fromClass(
    class {
      timer: number | undefined;
      constructor(readonly view: EditorView) {}
      schedule() {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.flush(false), IME_PAUSE_MS);
      }
      flush(force: boolean) {
        window.clearTimeout(this.timer);
        if (this.view.composing && !force) {
          this.schedule();
          return;
        }
        const spec = flushSpec(this.view.state, { enabled: cfg.autoAnnotate });
        if (spec) this.view.dispatch(spec);
      }
      update(u: ViewUpdate) {
        if (u.docChanged && u.state.field(pendingField, false)?.length) this.schedule();
      }
      destroy() {
        window.clearTimeout(this.timer);
      }
    },
    {
      eventHandlers: {
        compositionend() {
          this.schedule();
        },
        blur() {
          this.flush(false);
        },
      },
    },
  );
}

export function rakkanEditor(cfg: RakkanEditorConfig): Extension {
  return [
    parseField,
    annotate({ enabled: cfg.autoAnnotate }),
    imeFlush(cfg),
    collapseField(cfg),
    decorations(cfg),
    EditorView.domEventHandlers({
      copy: copyHandler(cfg, false),
      cut: copyHandler(cfg, true),
      paste: pasteHandler,
    }),
  ];
}
