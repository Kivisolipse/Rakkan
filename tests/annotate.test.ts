import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { annotate, flushSpec, pendingField } from "../src/cm6/annotate";
import { diffChanges } from "../src/core";

const cfg = { enabled: () => true };

/** A state with the cursor at `|` (removed from the text). */
function make(doc: string, on = true) {
  const head = Math.max(0, doc.indexOf("|"));
  const text = doc.replace("|", "");
  return EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(head),
    extensions: [annotate(on ? cfg : { enabled: () => false })],
  });
}

function type(state: EditorState, insert: string, event = "input.type", at?: { from: number; to?: number }) {
  const sel = state.selection.main;
  const from = at?.from ?? sel.from;
  const to = at ? (at.to ?? at.from) : sel.to;
  return state.update({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length), userEvent: event }).state;
}

/** The document with `|` at the cursor. */
function show(state: EditorState): string {
  const t = state.doc.toString();
  const h = state.selection.main.head;
  return t.slice(0, h) + "|" + t.slice(h);
}

const BLOCK = (body: string) => `&& Claude\n\n${body}\n\n&&`;

describe("typing in AI regions", () => {
  it("wraps typed text in an island and keeps the cursor inside it", () => {
    const s = type(make(BLOCK("AI 写的|")), "我");
    expect(show(s)).toBe(BLOCK("AI 写的@@我|@@"));
  });

  it("keeps extending the same island", () => {
    let s = make(BLOCK("AI|"));
    for (const ch of "我写的") s = type(s, ch);
    expect(show(s)).toBe(BLOCK("AI@@我写的|@@"));
  });

  it("allows spaces and punctuation inside the island", () => {
    let s = make(BLOCK("AI|"));
    for (const ch of "a b, c") s = type(s, ch);
    expect(show(s)).toBe(BLOCK("AI@@a b, c|@@"));
  });

  it("does not wrap leading spaces", () => {
    expect(show(type(make(BLOCK("AI|")), " "))).toBe(BLOCK("AI |"));
  });

  it("merges with an island that sits right before the cursor", () => {
    const s = type(make(BLOCK("AI @@ab@@|")), "c");
    expect(show(s)).toBe(BLOCK("AI @@abc|@@"));
  });

  it("merges with an island right after the cursor", () => {
    const s = type(make(BLOCK("AI |@@cd@@")), "b");
    expect(show(s)).toBe(BLOCK("AI @@b|cd@@"));
  });

  it("types inside an existing island without touching it", () => {
    const s = type(make(BLOCK("AI @@a|c@@")), "b");
    expect(show(s)).toBe(BLOCK("AI @@ab|c@@"));
  });

  it("splits an inline AI span around text typed in its middle", () => {
    // Same ownership as an island inside the span, with the same number of markers.
    const s = type(make("人 &&AI |写的&& 人"), "我");
    expect(show(s)).toBe("人 &&AI&& 我|&&写的&& 人");
  });

  it("writes text typed at the end of an inline AI span as plain human text after it", () => {
    // Same ownership as `&&AI 写的@@我@@&&`, with fewer markers.
    const s = type(make("人 &&AI 写的|&& 人"), "我");
    expect(show(s)).toBe("人 &&AI 写的&&我| 人");
  });

  it("leaves human text alone", () => {
    expect(show(type(make("人写的|"), "我"))).toBe("人写的我|");
  });

  it("leaves a quote alone for now", () => {
    expect(show(type(make("「引」[@a] 外|"), "我"))).toBe("「引」[@a] 外我|");
  });

  it("leaves marker characters the user types by hand", () => {
    expect(show(type(make(BLOCK("AI|")), "@"))).toBe(BLOCK("AI@|"));
  });

  it("wraps links as a whole when typing inside them", () => {
    const s = type(make(BLOCK("见 [[笔记|]] 吧")), "2");
    expect(show(s)).toBe(BLOCK("见 @@[[笔记2|]]@@ 吧"));
  });

  it("puts markers outside bold text", () => {
    const s = type(make(BLOCK("这是**加粗|**哦")), "字");
    expect(show(s)).toBe(BLOCK("这是@@**加粗字|**@@哦"));
  });

  it("wraps text typed over a selection", () => {
    const s = make(BLOCK("AI 写的话"));
    const from = s.doc.toString().indexOf("写的");
    const next = type(s, "我", "input.type", { from, to: from + 2 });
    expect(next.doc.toString()).toBe(BLOCK("AI @@我@@话"));
  });

  it("is one undo step with the typed text", () => {
    const s = make(BLOCK("AI|"));
    const tr = s.update({ changes: { from: s.selection.main.head, insert: "我" }, userEvent: "input.type" });
    expect(tr.state.doc.toString()).toBe(BLOCK("AI@@我@@"));
    // One transaction: the markers are part of the same change as the typed text.
    expect(tr.changes.empty).toBe(false);
    expect(tr.annotation(Transaction.userEvent)).toBe("input.type");
  });

  it("does nothing when switched off", () => {
    expect(show(type(make(BLOCK("AI|"), false), "我"))).toBe(BLOCK("AI我|"));
  });

  it("ignores events that are not typing", () => {
    expect(show(type(make(BLOCK("AI|")), "我", "input.paste"))).toBe(BLOCK("AI我|"));
    expect(show(type(make(BLOCK("AI|")), "我", "input.rakkan"))).toBe(BLOCK("AI我|"));
  });

  it("keeps working in a blockquote inside an AI block", () => {
    const s = type(make(BLOCK("> AI|")), "我");
    expect(show(s)).toBe(BLOCK("> AI@@我|@@"));
  });
});

describe("Enter inside an island", () => {
  it("closes the island before the line break", () => {
    const s = type(make(BLOCK("AI @@我写的|@@")), "\n", "input");
    expect(show(s)).toBe(BLOCK("AI @@我写的@@\n|"));
  });

  it("splits an island in the middle", () => {
    const s = type(make(BLOCK("AI @@我|写的@@")), "\n", "input");
    expect(show(s)).toBe(BLOCK("AI @@我@@\n|@@写的@@"));
  });

  it("moves a line break at the very start out of the island", () => {
    const s = type(make(BLOCK("AI @@|我写的@@")), "\n", "input");
    expect(show(s)).toBe(BLOCK("AI \n|@@我写的@@"));
  });

  it("leaves Enter alone outside islands", () => {
    expect(show(type(make(BLOCK("AI|")), "\n", "input"))).toBe(BLOCK("AI\n|"));
  });
});

describe("deleting", () => {
  const del = (state: EditorState, from: number, to: number, event = "delete.backward") =>
    state.update({ changes: { from, to }, selection: EditorSelection.cursor(from), userEvent: event }).state;

  it("removes the markers of an island that was emptied", () => {
    const s = make(BLOCK("AI @@我|@@"));
    const h = s.selection.main.head;
    expect(show(del(s, h - 1, h))).toBe(BLOCK("AI |"));
  });

  it("removes the markers when a selection covers the whole content", () => {
    const s = make(BLOCK("AI @@我写的@@"));
    const t = s.doc.toString();
    const a = t.indexOf("我");
    expect(del(s, a, a + 3, "delete.selection").doc.toString()).toBe(BLOCK("AI "));
  });

  it("keeps islands that still have content", () => {
    const s = make(BLOCK("AI @@我写|的@@"));
    const h = s.selection.main.head;
    expect(show(del(s, h - 1, h))).toBe(BLOCK("AI @@我|的@@"));
  });

  it("joins two islands when the text between them is deleted", () => {
    const s = make(BLOCK("@@甲@@xy@@乙@@"));
    const t = s.doc.toString();
    const a = t.indexOf("xy");
    expect(del(s, a, a + 2, "delete.selection").doc.toString()).toBe(BLOCK("@@甲乙@@"));
  });

  it("joins islands when a line break between them is deleted", () => {
    const s = make(BLOCK("@@甲@@\n@@乙@@"));
    const t = s.doc.toString();
    const a = t.indexOf("\n@@乙");
    expect(del(s, a, a + 1).doc.toString()).toBe(BLOCK("@@甲乙@@"));
  });

  it("does not join islands that were separated by something else", () => {
    const s = make(BLOCK("@@甲@@x@@乙@@"));
    const t = s.doc.toString();
    const a = t.indexOf("乙");
    expect(del(s, a, a + 1).doc.toString()).toBe(BLOCK("@@甲@@x"));
  });

  it("joins inline AI spans too", () => {
    const s = make("&&甲&&xy&&乙&&");
    expect(del(s, 5, 7, "delete.selection").doc.toString()).toBe("&&甲乙&&");
  });
});

describe("IME composition", () => {
  const compose = (state: EditorState, from: number, to: number, insert: string) =>
    state.update({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + insert.length),
      userEvent: "input.type.compose",
    }).state;

  it("does not touch the document while composing, and remembers the text", () => {
    let s = make(BLOCK("AI|"));
    const at = s.selection.main.head;
    s = compose(s, at, at, "ni");
    expect(show(s)).toBe(BLOCK("AIni|"));
    s = compose(s, at, at + 2, "你");
    expect(show(s)).toBe(BLOCK("AI你|"));
    expect(s.field(pendingField)).toEqual([{ from: at, to: at + 1 }]);
  });

  it("wraps the composed text after the pause, outside the undo history", () => {
    let s = make(BLOCK("AI|"));
    const at = s.selection.main.head;
    s = compose(s, at, at, "你好");
    const spec = flushSpec(s, cfg)!;
    expect(spec).toBeTruthy();
    const tr = s.update(spec);
    expect(show(tr.state)).toBe(BLOCK("AI@@你好|@@"));
    expect(tr.annotation(Transaction.addToHistory)).toBe(false);
    expect(tr.state.field(pendingField)).toEqual([]);
  });

  it("follows later edits with the pending range", () => {
    let s = make(BLOCK("AI|"));
    const at = s.selection.main.head;
    s = compose(s, at, at, "你好");
    s = s.update({ changes: { from: 0, insert: "前" }, userEvent: "input.type.compose" }).state; // before it
    expect(s.field(pendingField)[0].from).toBe(at + 1 + 0);
  });

  it("does not track composition inside an island", () => {
    let s = make(BLOCK("AI @@我|@@"));
    const at = s.selection.main.head;
    s = compose(s, at, at, "你");
    expect(s.field(pendingField)).toEqual([]);
    expect(show(s)).toBe(BLOCK("AI @@我你|@@"));
  });

  it("just clears the pending range when switched off", () => {
    let s = make(BLOCK("AI|"));
    const at = s.selection.main.head;
    s = compose(s, at, at, "你");
    const spec = flushSpec(s, { enabled: () => false })!;
    const next = s.update(spec).state;
    expect(next.doc.toString()).toBe(BLOCK("AI你"));
    expect(next.field(pendingField)).toEqual([]);
  });
});

describe("diffChanges", () => {
  const apply = (a: string, changes: ReturnType<typeof diffChanges>) => {
    let out = a;
    for (const c of [...changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
    return out;
  };

  it("reproduces the target", () => {
    for (const [a, b] of [
      ["ab c", "ab @@c@@"],
      ["@@ab@@c", "@@abc@@"],
      ["x@@a@@@@b@@y", "x@@ab@@y"],
      ["", "abc"],
      ["abc", ""],
    ]) {
      expect(apply(a, diffChanges(a, b))).toBe(b);
    }
  });

  it("keeps typed text in place when joining islands", () => {
    // The typed `c` must not be deleted and re-inserted.
    const changes = diffChanges("@@ab@@c", "@@abc@@");
    expect(changes).toEqual([
      { from: 4, to: 6, insert: "" },
      { from: 7, to: 7, insert: "@@" },
    ]);
  });
});

// ── Invariant: an edit never changes who owns the other characters ─────

import { parse, type ParseResult } from "../src/core";

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** Visible non-space characters with their owner kind, and their source offsets. */
function visible(r: ParseResult): Array<{ ch: string; kind: string; at: number }> {
  const out: Array<{ ch: string; kind: string; at: number }> = [];
  for (const s of r.segments) {
    if (s.role !== "text") continue;
    for (let k = s.from; k < s.to; k++) {
      const ch = r.text[k];
      if (/\s/.test(ch)) continue;
      out.push({ ch, kind: s.attr.kind, at: k });
    }
  }
  return out;
}

describe("random typing and deleting", () => {
  const BASES = [
    BLOCK("AI 写的一段话，@@我补的@@，又是 AI 写的。"),
    BLOCK("第一行 AI\n\n第二行 @@我@@ AI\n\n- 列表 @@项@@"),
    "人写的 &&AI 写的&& 人写的 &&又一段 @@人@@ AI&&",
    BLOCK("> 引用里的 AI @@人@@") + "\n\n人写的",
    BLOCK("见 [[笔记]] 和 **加粗** 以及 `code` 的 AI @@我@@"),
  ];
  const ALPHABET = "abc你好我的 ";

  it("typing keeps every other character's owner and makes the typed one human", () => {
    const rand = rng(7);
    for (let round = 0; round < 300; round++) {
      // Links and bold are wrapped as a whole on purpose, so they stay out of this check.
      let s = make(BASES[round % (BASES.length - 1)]);
      for (let step = 0; step < 6; step++) {
        const before = parse(s.doc.toString());
        const chars = visible(before);
        // Cursor right after a random visible character. (Typing inside a `&&` line
        // edits the marker itself, which changes the structure on purpose.)
        const letters = chars.map((c, k) => (/[\p{L}\p{N}]/u.test(c.ch) ? k : -1)).filter((k) => k >= 0);
        const i = letters[Math.floor(rand() * letters.length)] + 1;
        const pos = chars[i - 1].at + 1;
        const ch = ALPHABET[Math.floor(rand() * ALPHABET.length)];
        s = type(s, ch, "input.type", { from: pos });
        const after = parse(s.doc.toString());
        if (ch === " ") {
          expect(visible(after).map((c) => c.ch + c.kind)).toEqual(chars.map((c) => c.ch + c.kind));
          continue;
        }
        const expected = chars.map((c) => c.ch + c.kind);
        // In human text the typed char is human; in AI text it must be human as well.
        expected.splice(i, 0, ch + "human");
        expect(visible(after).map((c) => c.ch + c.kind), `${JSON.stringify(before.text)} + ${ch} at ${pos}`).toEqual(expected);
      }
    }
  });

  it("deleting a visible character keeps every other owner", () => {
    const rand = rng(11);
    for (let round = 0; round < 300; round++) {
      let s = make(BASES[round % BASES.length]);
      for (let step = 0; step < 4; step++) {
        const before = parse(s.doc.toString());
        const chars = visible(before);
        if (!chars.length) break;
        const i = Math.floor(rand() * chars.length);
        const at = chars[i].at;
        s = s.update({ changes: { from: at, to: at + 1 }, userEvent: "delete.backward" }).state;
        const after = parse(s.doc.toString());
        const expected = chars.map((c) => c.ch + c.kind);
        expected.splice(i, 1);
        expect(visible(after).map((c) => c.ch + c.kind), `${JSON.stringify(before.text)} - ${at}`).toEqual(expected);
      }
    }
  });
});
