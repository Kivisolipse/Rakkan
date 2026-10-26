// Minimal CodeMirror page for checking the live-preview layer in a browser,
// without Obsidian. Build with `npm run harness`, then open dev/index.html.

import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { pasteWithOwners, rakkanEditor } from "../src/cm6/editor";
import { markSelection } from "../src/obsidian/commands";
import { colorCss } from "../src/cm6/colors";
import type { StyleSettings } from "../src/cm6/resolve";

const styles: StyleSettings = {
  familyColors: true,
  aiStyle: "color",
  quoteStyle: "color",
  familyStyle: {},
  modelStyle: {},
  forceStyle: "",
  extraPrefixes: [],
};

document.getElementById("rk-colors")!.textContent = colorCss({ colors: {}, extraPrefixes: [] });

const doc = [
  "# 分页（示例）",
  "",
  "人写的开头。&&这句是 AI 补的&&[@gpt-5]，然后又回到人。",
  "",
  "书上说「纸短情长」[@fakebook]，我深以为然。",
  "",
  "&& Claude (claude-opus-5-5)",
  "",
  "分页把地址空间切成固定大小的页，@@很好理解。@@每一页映射到一个物理页框，@@x@@ 由页表记录。",
  "",
  "&&",
  "",
  "&& (gemini-3-pro)",
  "",
  "Gemini 写的一段，配色取自它的渐变 logo。",
  "",
  "&&",
  "",
  "预算约 $3.8 万，&&按汇率粗算&& ¥156/$",
  "",
  "后记。",
].join("\n");

const view = new EditorView({
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      drawSelection(),
      keymap.of([]),
      EditorView.lineWrapping,
      rakkanEditor({ styles: () => styles, hideMarkers: () => true, stripOnCopy: () => true }),
    ],
  }),
});

// For poking at it from the devtools console.
Object.assign(window, { view, pasteWithOwners, markSelection });
