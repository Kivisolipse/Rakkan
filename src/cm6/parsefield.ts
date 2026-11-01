// The parse of the current document, kept as editor state. Only depends on
// @codemirror/state, so logic built on it can run (and be tested) without a DOM.

import { StateField } from "@codemirror/state";
import { Parser, type ParseResult } from "../core";

const parser = new Parser();

export const parseField = StateField.define<ParseResult>({
  create: (s) => parser.parse(s.doc.toString()),
  update: (v, tr) => (tr.docChanged ? parser.parse(tr.state.doc.toString()) : v),
});
