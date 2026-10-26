import type { EditorView } from "@codemirror/view";
import { minimalChange, setOwner, stripMarkers, type Owner } from "../core";
import { parseField, pasteWithOwners } from "../cm6/editor";

type Change = { from: number; to: number; insert: string };

const BLANK = /^\s*$/;

/**
 * Mark the selection as AI or human. Whole human paragraphs marked as AI
 * become a signed block; everything else is rewritten line by line.
 * Returns the number of lines that could not be rewritten (quotes, code).
 */
export function markSelection(view: EditorView, owner: Owner, signature: string): number {
  const { state } = view;
  const { doc } = state;
  const r = state.field(parseField);
  const changes: Change[] = [];
  let skipped = 0;

  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const first = doc.lineAt(range.from);
    let last = doc.lineAt(range.to);
    if (range.to === last.from && last.number > first.number) last = doc.line(last.number - 1);

    const lineNos: number[] = [];
    for (let n = first.number; n <= last.number; n++) lineNos.push(n);
    const wholeLines = range.from === first.from && range.to >= last.to;
    const allHumanProse = lineNos.every((n) => {
      const c = r.lineContexts[n - 1];
      return BLANK.test(doc.line(n).text) || (c.mode === "prose" && c.pair === "human" && c.prefix === 0);
    });

    if (owner === "ai" && wholeLines && allHumanProse && lineNos.some((n) => !BLANK.test(doc.line(n).text))) {
      // Turn the paragraphs into a signed block; inline markers inside would show literally, so strip them.
      for (const n of lineNos) {
        const line = doc.line(n);
        const plain = stripMarkers(r, line.from, line.to).text;
        if (plain !== line.text) changes.push({ from: line.from, to: line.to, insert: plain });
      }
      const before = first.number > 1 && !BLANK.test(doc.line(first.number - 1).text) ? "\n" : "";
      const after = last.number < doc.lines && !BLANK.test(doc.line(last.number + 1).text) ? "\n" : "";
      changes.push({ from: first.from, to: first.from, insert: `${before}&& ${signature}\n\n` });
      changes.push({ from: last.to, to: last.to, insert: `\n\n&&${after}` });
      continue;
    }

    for (const n of lineNos) {
      const line = doc.line(n);
      const a = Math.max(range.from, line.from) - line.from;
      const b = Math.min(range.to, line.to) - line.from;
      if (b <= a) continue;
      const next = setOwner(line.text, r.lineContexts[n - 1], a, b, owner);
      if (next === null) {
        if (!BLANK.test(line.text.slice(a, b))) skipped++;
        continue;
      }
      const ch = minimalChange(line.text, next);
      if (ch) changes.push({ from: line.from + ch.from, to: line.from + ch.to, insert: ch.insert });
    }
  }

  if (changes.length) view.dispatch({ changes, userEvent: "input", scrollIntoView: true });
  return skipped;
}

/** Remove markers from the selection, or from the whole note when nothing is selected. */
export function stripSelection(view: EditorView) {
  const { state } = view;
  const r = state.field(parseField);
  const ranges = state.selection.ranges.filter((x) => !x.empty);
  const targets = ranges.length ? ranges : [{ from: 0, to: state.doc.length }];
  const changes: Change[] = [];
  for (const t of targets) {
    const text = stripMarkers(r, t.from, t.to).text;
    const ch = minimalChange(state.sliceDoc(t.from, t.to), text);
    if (ch) changes.push({ from: t.from + ch.from, to: t.from + ch.to, insert: ch.insert });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "delete" });
}

/** Insert an empty signed block at the cursor, with the closing line already in place. */
export function insertBlock(view: EditorView, signature: string) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const atEmpty = BLANK.test(line.text);
  const pos = atEmpty ? line.from : line.to;
  const lead = atEmpty ? (line.number > 1 && !BLANK.test(state.doc.line(line.number - 1).text) ? "\n" : "") : "\n\n";
  const open = `${lead}&& ${signature}\n\n`;
  const insert = `${open}\n\n&&\n`;
  view.dispatch({
    changes: { from: pos, to: atEmpty ? line.to : pos, insert },
    selection: { anchor: pos + open.length },
    userEvent: "input",
    scrollIntoView: true,
  });
}

/** Add the blank lines that block lines require. */
export function fixBlankLines(view: EditorView): number {
  const { state } = view;
  const { doc } = state;
  const r = state.field(parseField);
  const changes: Change[] = [];
  for (const b of r.blocks) {
    for (const l of [b.openLine, b.closeLine]) {
      if (l === null) continue;
      const line = doc.line(l + 1);
      if (line.number > 1 && !BLANK.test(doc.line(line.number - 1).text))
        changes.push({ from: line.from, to: line.from, insert: "\n" });
      if (line.number < doc.lines && !BLANK.test(doc.line(line.number + 1).text))
        changes.push({ from: line.to, to: line.to, insert: "\n" });
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input" });
  return changes.length;
}

export function pasteAsAI(view: EditorView, text: string) {
  const plain = text.replace(/\r\n/g, "\n");
  pasteWithOwners(view, { plain, owners: "A".repeat(plain.length) });
}
