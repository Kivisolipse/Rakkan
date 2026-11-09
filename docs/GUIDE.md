# Rakkan Guide

**English** · [中文](GUIDE.zh.md)

Each feature in detail: export and conversion, search, and markers in code. The syntax is in [SPEC.md](SPEC.md).

## What the plugin does

- **Colour by model family.** Claude, GPT, Gemini, DeepSeek… each has a default colour, and the text itself is coloured (after iA Writer). Each family or model can have its own style: coloured, gradient or rainbow text, or an underline. Rainbow text is drawn as in iA Writer: the colour follows a character's horizontal position on the page, from orange on the left through red, pink and purple to blue on the right.
- **Live preview.** Markers and the opener and closer lines of blocks hide when the cursor is elsewhere.
- **Reading view.** The same colours, with no markers.
- **Status bar.** `Human 72% · AI 28%`. Hover to see how much each model wrote; click to see warnings (an unclosed code fence, markers swallowed by a formula, a missing blank line…).
- **Auto-marking your own words.** What you type in an AI block is wrapped in `@@…@@`, in the same undo step as the typing. With an IME, the wrap waits until you pause and never touches the document while you compose. Enter doesn't carry a human island onto the next line.
- **Authorship follows moved text.** Swapped lines, drag and drop, dragged list items, sorting plugins: text deleted and inserted again unchanged in one edit keeps its authors, down to the character. When a paste brings in a run as long as a code block's declaration, the declaration grows by one character.
- **Human islands in math.** Starting a formula with `$$ %@@` (a LaTeX comment, which doesn't show) declares islands, so a formula in an AI block can mark individual characters with `@@…@@`. Both reading view and live preview render it again in colour.
- **English and Chinese.** Choose the language in the settings; by default it follows Obsidian. Command names change after the plugin is reloaded.
- **Author book.** A note in the vault with one author per line (`- @key: Name (ID) · kind · #colour`). Quotes take their author's colour: a person has a colour of their own, a source is dimmed, and hovering the status bar shows the authors' names. Typing `[@` (or `【@` with a Chinese IME) opens a list of authors, and **Paste as quote** writes one line of plain text in the line as `「…」[@key]`, and anything else (several lines, or a line holding one of `` ` $ % & @ 「 」 " `` or Markdown that works only at the start of a line) as a blockquote ending in the key. Either way it shows as the original does, and no marker in it gets out. What you type inside a quote is marked as yours too. When the authors grow many, there is no need to edit the note by hand: **Manage** in the settings (or the command **Manage authors**) opens a window where you can search, add, rename, recolour and delete authors, and the changes go straight back to their lines in the author book.
- **Paste revision.** Select the original text, copy the AI's revised version, run **Paste revision** and choose the model. Only the changed words become `&&…&&[@model]`; the rest keep their authors. Useful for keeping a log of mistakes, or for seeing exactly what an AI changed in your text. A change it can't mark (inside a quote or code) isn't pasted: those lines keep the original, and a notice says so.
- **Copy without markers.** Text pasted into another app has no `&&` or `@@`; pasted back into the vault, it gets the markers right for where it lands.
- **Right-click menu.** While editing, right-click → Rakkan for **Mark as AI-generated**, **Mark as human-written**, **Paste revision** and **Remove markers in selection** (with text selected), and **Paste as AI-generated**, **Paste as quote**, **Clarify quote**, **Insert AI block** and **Export as PDF…**.
- **Commands.** Mark as AI-generated, Mark as human-written, Remove markers, Insert AI block, Add blank lines around block fences, Paste as AI-generated, Toggle writing / review display, Search (ignore formatting), Find in current note (ignore formatting), Clarify quote, Go to next unclarified quote, and the export and conversion commands below.

## Clarify quote

Who a quote's words belong to depends only on who wrote its `[@key]`. Where the person wrote it (in their own text, or in a `@@…@@` island), the words are the source's. Where the model wrote it, the words count as the model's, and the `[@key]` is kept as the model's claim, for checking. Who typed the quotation marks makes no difference.

When the parts of one quote were written by different authors (the quotation marks by the person and the words between them by the model, for example), the quote is attributed by the same rule and flagged for clarification: the status bar warnings and lint report it as `mixed-quote`.

**Clarify quote** (in the Rakkan right-click menu and the command palette) works with the cursor on any quote, flagged or not. It offers:

- **Confirm as quote from {name}.** The whole quote is rewritten as written by the person, and the words are the source's. A quote given by the model is confirmed the same way (the manual confirmation in SPEC §4.4).
- **Mark as AI citation.** The whole quote is rewritten as written by the model: the words count as the model's, and the citation is kept.
- **Remove quote markup.** The quotation marks and the `[@key]` are removed, and each word keeps its author.
- **Remove quote markup and mark as human-written.** As above, and the words become an explicit `@@…@@` human island. Offered only in AI text: in human-written text, the words are human-written already.

A cited blockquote is handled the same way: marked as an AI citation, it goes into an AI block; confirmed inside an AI block, it moves out of the block, which continues after it. The result is written back into the note as ordinary markers: it stays with the note and is not lost in another app. **Go to next unclarified quote** moves the cursor to the next flagged quote, and after the last one starts again from the top. In the status bar warnings, a flagged quote has a **Clarify quote** button.

## Export and conversion

**Export as PDF…** opens Rakkan's own export window. Choose **In colour** or **Plain text** (no colour and no markers of any kind), then the page size, **Landscape**, **Margins**, **Page numbers** and **Scale (%)**, and optionally an **Authorship summary** at the end: how many characters are human-written, by each model, and quoted. Headings aren't split from what follows them, and code blocks, tables and blockquotes stay on one page where they can. In plain text, the `[@key]` at the end of a blockquote becomes "— source name". The command is also in the Rakkan right-click menu, in a note's three-dot menu, and in the file explorer's right-click menu (reading view included). **Preview** opens a window laid out at the page width, with red lines where each page ends, so you can look before you export. Footnotes are numbered through the whole note and collected at the end.

Obsidian's own Export to PDF doesn't tell plugins which lines each part came from, so the colours of AI blocks and code blocks would be lost; Rakkan renders the note part by part itself and prints that. On desktop, it writes the PDF directly. A phone can't print to a file, so there it saves a web page instead: open it in a browser and choose Print → Save as PDF. Rainbow and gradient text colour each character by its place on the page, so the PDF shows the rainbow too, and the text is still text.

Then there are the conversion commands. The exports write their result into a new note next to the original, which stays as it is; **Convert from iA Annotations** changes the current note, and Ctrl+Z undoes it in one step.

- **Export as new note: markers removed.** Removes every `&&` and `@@`, the opener and closer lines of blocks, and the declarations on code blocks. The rest of the Markdown is left exactly as it was.
- **Export as new note: Pandoc format.** `&&…&&` becomes `[…]{.rk-ai}`, an AI block becomes a fenced div `::: {.rk-ai model="…"}`, and quotes become `{.rk-quote}`. With [pandoc/rakkan.lua](../pandoc/rakkan.lua), the AI's words keep their colour in HTML and PDF (in Word, they take a style named Rakkan AI):
  ```bash
  pandoc note\ \(Pandoc\).md --lua-filter=pandoc/rakkan.lua -o note.pdf
  pandoc note\ \(Pandoc\).md -M rakkan=plain --lua-filter=pandoc/rakkan.lua -o note.docx   # text only
  ```
- **Export as new note: iA Annotations format.** The text without markers, followed by a block of [iA Writer's Markdown Annotations](https://github.com/iainc/Markdown-Annotations) (`@Human`, `&Model name <ID>`, `*Quoted author`, with ranges counted in graphemes and a SHA-256 hash). iA Writer reads it as is.
- **Export as new note: for Obsidian Publish (with style classes).** Markers become `<span>` and `<div>` elements with class names, since Publish doesn't run plugins. Then **Generate Obsidian Publish styles (publish.css)** writes the colours into `publish.css` at the root of the vault, changing only Rakkan's part of it. Whether Publish keeps these class names hasn't been checked yet.
- **Convert from iA Annotations (current note).** Turns a note with an iA annotation block into Rakkan markers. When the annotations don't match the text (a hash mismatch), nothing is converted. `&` ranges become `&&…&&[@key]`; `*` (reference) ranges become `「…」[@key]` quotes.

A vault has one owner by default: unmarked human text is the owner's. Converting does nothing to the owner's text, and nobody has to be declared the owner beforehand. Other people go by the author book: an `@Name` in the iA block that the author book knows, by name or by key, becomes a `「…」[@key]` quote by that author. For people the author book doesn't know, the conversion asks which of them is the owner (left unmarked), or **None of them**. The others become quotes, with keys made from their names and definitions (`· human`) added at the end of the note. Closing the dialog cancels the conversion.

Author names travel both ways. On export, an author with a `[@key]` is written `&Name <@key>` or `*Name <@key>` (an ID starting with `@` is a Rakkan key, unlike a model ID). On the way back, the key comes from that ID, or else from the name (generic names such as `AI` or `Unknown` get no key), and the name and model ID go into a definition at the end of the note (`- @key: Name (model) · AI`), without repeating one that is already there. When a `*` range is already in corner brackets `「…」`, only `[@key]` is added; one with corner brackets inside that can't be separated stays plain text, and the conversion reports how many characters.

## With Obsidian Web Clipper

A page clipped with [Web Clipper](https://obsidian.md/clipper) has no markers, so Rakkan counts the whole article as your own writing. [clipper/](../clipper/) has two templates that sign the clip as it is saved:

- **rakkan-clip.json** puts the article in a blockquote whose last line is `> [@domain]`, and adds a definition at the end of the note: `@domain: Title (URL) · source`. The whole article counts as quoted. A `|` or `·` in the title becomes `-`, so it isn't read as a separator in the definition.
- **rakkan-clip-ai-summary.json** does the same and opens with an AI block holding a summary from the Interpreter, signed `&& {{model}} ({{modelId}})`: the model the Interpreter actually used. The model ID is only filled in once the Interpreter has run, so turn on **Automatically run** under Web Clipper settings → Interpreter, or run it before you save each clip.

To import one: Web Clipper settings → Templates → Import, and pick the JSON file. Whatever you then write in the clipped note has no marks and counts as yours, as usual.

## Search (ignore formatting)

Markers split words: a search of the source for "word" misses `wo@@rd@@`. **Search method** in the settings offers two ways:

- **Obsidian search** (the default). The search pane (next to **Match case**) and a note's find bar (Ctrl+F) each get an **Ignore formatting** toggle. With it on, formatting characters and `[@key]` citations may come between any two characters. The search box still shows what you typed; `path:`, `file:`, `tag:`, properties and regular expressions work as before, **Match case** still applies, and a phrase in quotation marks still matches whole words. Reading view has no markers to begin with, so its find bar finds words without the toggle. Obsidian has no API for search, so this relies on its internals and may break when Obsidian updates.
- **Rakkan search window.** A separate window that leaves Obsidian unchanged. It searches the notes with their markers removed, shows excerpts without markers, and selects the matched text when it opens a note.

Either way, the commands **Search (ignore formatting)** and **Find in current note (ignore formatting)** open them; with Obsidian's search plugin turned off, **Search (ignore formatting)** opens the Rakkan search window. With Omnisearch installed, **Omnisearch compatibility** lets it find words split by markers too, and its excerpts leave the markers out.

In a terminal, or for an AI, use the same pattern:

```bash
g='(?:[@&*=~`\[\]]|\[@[^\s@&*=~`\[\]][^\s\[\]]*\])*'
rg -i "w${g}o${g}r${g}d"
```

## Why there is `@@` in code

Code blocks parse no markers by default. To mark which characters of the code a person changed, declare the marker after the language name:

````
```ts @@
let count = @@0@@
```
````

Only runs exactly as long as the declaration count as markers in the block. If the code already contains `@@` (in a diff, say), declare `@@@`.

You don't have to write declarations yourself. When you type in code inside an AI block, the plugin adds the declaration to the code block, picks a marker long enough, and wraps what you type. When an island is emptied, its markers go too, and so does a declaration no longer needed. The copy button at the top right of a code block (in reading view and live preview) copies the code without markers, and so does copying a selection. Hovering a declaration shows "This code block uses the `@@` marker; it is removed when you copy". Without the plugin, remove the markers by their declaration; for `@@`:

```bash
perl -pe 's/(?<!@)@@(?!@)//g'
```

## Development

```bash
npm install
npm test          # core unit tests
npm run build     # writes main.js
npm run demo      # builds and installs into demo-vault/; open that folder in Obsidian to try it
npm run stats -- path/to/notes             # the human, AI and quote share of each note
npm run stats -- path/to/notes --verbose   # also lists every warning as file:line
node skills/rakkan/scripts/rakkan.mjs lint path/to/notes   # the checks an agent runs (see skills/rakkan)
```

The code has three layers: `src/core` (a parser in plain TypeScript), `src/cm6` (depends only on CodeMirror 6) and `src/obsidian` (settings, commands, reading view). `cli/rakkan.ts` is the `rakkan` command, which `npm run build` bundles into `skills/rakkan/scripts/rakkan.mjs`. The plan is in [PLAN.md](PLAN.md) (Chinese).

## License

MIT
