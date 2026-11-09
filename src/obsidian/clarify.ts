// Clarify quote: a choice of what a quote is, written back to the note as markers (core/clarify.ts).

import { Notice, SuggestModal, type App } from "obsidian";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { clarifications, clarifyQuote, nextMixedQuote, quoteAt, type Clarification, type QuoteRef } from "../core";
import { parseField } from "../cm6/editor";
import { t } from "../i18n";

/** The choice as the menu shows it; `{name}` is the source's name. */
function label(how: Clarification, name: string): string {
  switch (how) {
    case "confirm":
      return t("确认为 {name} 的引文", { name });
    case "ai":
      return t("标为 AI 的出处声明");
    case "remove":
      return t("移除引用标记");
    case "human":
      return t("移除引用标记并标为人写");
  }
}

class ClarifyModal extends SuggestModal<Clarification> {
  constructor(
    app: App,
    private q: QuoteRef,
    private name: string,
    private onPick: (how: Clarification) => void,
  ) {
    super(app);
    this.setPlaceholder(t("澄清引文"));
  }

  getSuggestions(query: string): Clarification[] {
    const s = query.trim().toLowerCase();
    return clarifications(this.q).filter((how) => label(how, this.name).toLowerCase().includes(s));
  }

  renderSuggestion(how: Clarification, el: HTMLElement): void {
    el.createDiv({ text: label(how, this.name) });
  }

  onChooseSuggestion(how: Clarification): void {
    this.onPick(how);
  }
}

export interface ClarifyDeps {
  /** The display name of a key, from the author book or the note. */
  nameOf: (key: string) => string | undefined;
  /** The opening line for an AI block around a blockquote marked as the model's citation. */
  blockOpener: () => string;
}

/** Ask what the quote at the cursor is, and write the answer into the note. */
export function clarifyAtCursor(app: App, view: EditorView, deps: ClarifyDeps) {
  const r = view.state.field(parseField);
  const q = quoteAt(r, view.state.selection.main.head);
  if (!q) {
    new Notice(t("光标不在引文上"));
    return;
  }
  new ClarifyModal(app, q, deps.nameOf(q.key) ?? q.key, (how) => {
    // The note may have changed while the menu was open: read it again.
    const now = view.state.field(parseField);
    const same = quoteAt(now, view.state.selection.main.head);
    const change = same && same.from === q.from && same.to === q.to ? clarifyQuote(now, same, how, { blockOpener: deps.blockOpener() }) : null;
    if (!change) {
      new Notice(t("无法按所选方式改写这段引文"));
      return;
    }
    view.dispatch({ changes: change, userEvent: "input.rakkan", scrollIntoView: true });
  }).open();
}

/** Move the cursor to the next quote that waits to be clarified. */
export function gotoNextMixedQuote(view: EditorView) {
  const r = view.state.field(parseField);
  const q = nextMixedQuote(r, view.state.selection.main.head);
  if (!q) {
    new Notice(t("没有待澄清的引文"));
    return;
  }
  view.dispatch({ selection: EditorSelection.cursor(q.from + 1), scrollIntoView: true });
  view.focus();
}
