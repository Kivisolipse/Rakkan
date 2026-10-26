// Live preview: colour by author, hide markers away from the cursor, turn
// block lines into small signature badges, and keep attribution through
// copy and paste. Depends only on @codemirror/* so other CM6 hosts can reuse it.

import { ChangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  Parser,
  minimalChange,
  rewriteLine,
  stripMarkers,
  type Attr,
  type InlineSpan,
  type Owner,
  type ParseResult,
  type Segment,
} from "../core";
import { resolve, resolveBlock, type Resolved, type StyleSettings } from "./resolve";

export interface RakkanEditorConfig {
  styles(): StyleSettings;
  /** Hide markers away from the cursor (live preview). */
  hideMarkers(state: EditorState): boolean;
  stripOnCopy(): boolean;
}

/** Dispatch to force a redraw after settings change. */
export const refreshEffect = StateEffect.define<null>();

const parser = new Parser();

export const parseField = StateField.define<ParseResult>({
  create: (s) => parser.parse(s.doc.toString()),
  update: (v, tr) => (tr.docChanged ? parser.parse(tr.state.doc.toString()) : v),
});

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

// ── Widgets ─────────────────────────────────────────────────────────────

class SignatureWidget extends WidgetType {
  constructor(
    readonly res: Resolved,
    readonly end: boolean,
  ) {
    super();
  }
  override eq(o: SignatureWidget) {
    return o.res.cls === this.res.cls && o.res.label === this.res.label && o.res.id === this.res.id && o.end === this.end;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `${this.res.cls} ${this.end ? "rk-sig-end" : "rk-sig-start"}`;
    if (this.end) {
      el.setAttribute("aria-label", `${this.res.label} 结束`);
    } else {
      const name = document.createElement("span");
      name.className = "rk-sig-name";
      name.textContent = this.res.label;
      el.appendChild(name);
      if (this.res.id && this.res.id !== this.res.label) {
        const id = document.createElement("span");
        id.className = "rk-sig-id";
        id.textContent = this.res.id;
        el.appendChild(id);
      }
    }
    return el;
  }
  override ignoreEvent() {
    return false;
  }
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
          const line = state.doc.lineAt(s.from);
          const b = s.attr.block !== undefined ? r.blocks[s.attr.block] : undefined;
          if (hide && b && !touches(state, line.from, line.to)) {
            const res = resolveBlock(b.signature, styles);
            out.push(
              Decoration.replace({ widget: new SignatureWidget(res, s.mark === "block-close") }).range(s.from, s.to),
            );
          } else out.push(markDeco("rk-mark rk-mark-block").range(s.from, s.to));
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

export function rakkanEditor(cfg: RakkanEditorConfig): Extension {
  return [
    parseField,
    decorations(cfg),
    EditorView.domEventHandlers({
      copy: copyHandler(cfg, false),
      cut: copyHandler(cfg, true),
      paste: pasteHandler,
    }),
  ];
}
