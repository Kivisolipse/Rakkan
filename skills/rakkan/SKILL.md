---
name: rakkan
description: Sign the text you write into Markdown notes with Rakkan markers, so the author can see which words an AI wrote and which model wrote them. Use whenever you write or edit a Markdown note in an Obsidian vault that uses the Rakkan plugin, or any note that already contains `&&` or `@@` markers, `&& Name (model-id)` block lines, or `[@key]` after quotation marks.
license: MIT
compatibility: The checker in scripts/ needs Node.js 18 or later.
---

# Signing text with Rakkan

Rakkan marks, in plain text, which characters of a note a person wrote, which an AI wrote, and which were quoted. Unmarked text counts as the person's. So every word you write into a note carries a mark, and every mark the note already has survives your edit.

`scripts/rakkan.mjs` in this skill's folder does the fiddly parts: `sign` marks your changes to someone else's words, and `lint` checks a note when you are done. Below, `rakkan` stands for `node <this skill's folder>/scripts/rakkan.mjs`. Without the folder, `npx rakkan` runs the same thing.

## Your model ID

Sign with your model ID as your provider's API spells it, such as `claude-opus-5-5` or `gpt-5`, not a product name. If you don't know your exact ID, use your model family alone (`Claude`, `GPT`, `Gemini`, …), or `AI`.

## New paragraphs: an AI block

```
&& Claude (claude-opus-5-5)

Your paragraphs. Headings, lists, tables and code blocks can go inside.

&&
```

- The opener is a line `&& Name (model-id)`. Either part may go, not both: `&& (claude-opus-5-5)`, `&& Claude`, `&& AI`.
- The closer is a line with only `&&`.
- Leave a blank line before and after each of the two lines. Right below the frontmatter, the opener needs no blank line above.
- Blocks don't nest. Inside a block, don't write `&&` at all.
- The two lines can't sit inside a blockquote or a list item. Put the whole blockquote or list inside the block instead.

## Changing someone else's words: run sign

Copy the note before you edit it, edit the note writing only plain words, then let `sign` mark exactly the characters you changed:

```bash
cp note.md /tmp/note.orig.md        # before your first edit; anywhere outside the vault
# … edit note.md, adding no marks of your own …
rakkan sign --model claude-opus-5-5 /tmp/note.orig.md note.md
```

`sign` writes the marks into `note.md`. Words you kept keep their author, the author's `@@` islands and other models' `[@key]` included, even where your edit dropped their markers. Deleting needs no mark. Two kinds of line come back for you to look at: `unmarked` (the line holds a quote, code, or a link or the like with words by two authors, that `sign` can't mark) and `foreign-block` (your words landed in an AI block another model signed, so they count as that model's).

You may also mark small edits by hand, `the &&quick&&[@claude-opus-5-5] brown fox`; `sign` is for marks exact to the character.

## A few words of your own: inline

```
The author's sentence, with &&a few words of yours&&[@claude-opus-5-5] in it.
```

- `[@model-id]` right after the closing `&&` names the model. It may be left out: `&&your words&&`.
- An inline mark stays on one line. For words on several lines, mark each line.
- Inside an AI block there is nothing to mark: the block is already yours.

## Keep what is there

- **An existing AI block** keeps its opener and closer. Paragraphs of your own go in a new block, signed by you.
- **`@@…@@`** inside AI text are the author's own words. Keep them, and don't put your words inside them.
- **Every existing mark stays:** `&&`, `@@`, block lines, `[@key]`, and definition lines such as `@key: Name (id) · AI` at the end of the note. Remove marks only when the user asks you to.

## Quoting

Credit a source you quote word for word: `"quoted words"[@key]` or `「…」[@key]`, with `[@key]` right after the closing quotation mark. For a passage, use a blockquote whose last line is only `> [@key]`. If the vault doesn't define the key yet, define it on a line at the very end of the note: `@key: Title or author · source` (use `· human` for a person).

## Where marks don't apply

- Marks are exactly two characters: `&&&` and `@@@` are plain text. Escape a literal pair in prose as `\&&` or `\@@`.
- Nothing is parsed in frontmatter, code blocks, inline code, math, `%%comments%%` or URLs, so `a && b` in code is fine. Code inside an AI block counts as AI-written as a whole.

## Before you finish: run lint

```bash
rakkan lint note.md
```

It prints `file:line:column  code  message` for each problem and exits with 1 if there is any: an AI block without its closer or blank lines, a marker without a partner, a marker that does nothing where it is, a `[@key]` that nothing defines. Fix the problems your edit caused, run it again, and tell the user about any that were there before you began.

`lint` can't know who wrote what, so check that yourself: nothing you wrote is unmarked, and nothing the author wrote is newly marked.

## Searching notes

Marks split words, so a plain search for `word` misses `wo@@rd@@`. Allow marks between the characters:

```bash
g='(?:[@&*=~`\[\]]|\[@[^\s@&*=~`\[\]][^\s\[\]]*\])*'
rg -i "w${g}o${g}r${g}d"
```

The full syntax, including marks inside code: https://github.com/Kivisolipse/Rakkan/blob/main/docs/SPEC.md
