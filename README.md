<h1 align="center">Rakkan</h1>

<p align="center">
  <b>Every character, signed.</b><br>
  An Obsidian plugin that shows, in colour, which words of a note you wrote, which an AI wrote, and which you quoted.
</p>

<p align="center">
  <b>English</b> · <a href="README.zh.md">中文</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/screenshot-en-dark.png">
  <img alt="A note in Obsidian: Chaucer's lines in blue as a quote, Eliot's lines in plain text, a paragraph marked as AI in rainbow text" src="docs/images/screenshot-en-light.png">
</picture>

## Markers

| Write | Meaning |
|---|---|
| Plain text | Written by you |
| `&&text&&` | Written by an AI; `&&text&&[@gpt]` names the model |
| `&& Claude (claude-opus-5-5)` … `&&` | A whole AI block, each marker on a line of its own |
| `@@text@@` | Your own words inside AI text |
| `"text"[@key]`, `「text」[@key]` | A quote, credited to an author |

Without the plugin, the note still reads as ordinary Markdown. The full syntax is in [docs/SPEC.md](docs/SPEC.md) (Chinese).

## Features

- **Colour by model.** Each model family has its own colour. Any family or model can use gradient, rainbow (as in iA Writer) or underline instead.
- **Live preview and reading view.** Markers hide when the cursor leaves the line; reading view shows only the colours.
- **Status bar.** `Human 37% · AI 38% · Quotes 25%`; hover for the count by model and by author.
- **Signing as you write.** Text you type inside AI text is wrapped in `@@…@@`. Moved lines keep their authors. Copied text leaves the markers behind.
- **Paste revision.** Paste an AI's revision of your text; only the changed words are credited to the model.
- **Author book.** One note lists every author: `- @key: Name (id) · human / AI / source · #colour`. Quotes take their author's colour.
- **Search that ignores markers,** in Obsidian's search, the find bar and Omnisearch.
- **Export** to PDF in colour or plain text, to a note without markers, to Pandoc, to Obsidian Publish, and to and from iA Writer's Markdown Annotations.
- **English and Chinese** interface.

A detailed guide, in Chinese, is in [docs/GUIDE.md](docs/GUIDE.md).

## Install

Requires Obsidian 1.8.7 or later, on desktop or mobile.

Until Rakkan is listed in Community plugins, install it by hand: download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest), put them in `<vault>/.obsidian/plugins/rakkan/`, and enable Rakkan in **Settings → Community plugins**.

## Privacy

Rakkan makes no network requests and collects no data. **Export as PDF** saves the file where you choose in the save dialog, which may be outside your vault.

## Development

```bash
npm install
npm test
npm run build   # writes main.js
npm run demo    # builds and installs into demo-vault/
```

## License

[MIT](LICENSE). Inspired by iA Writer's Authorship.
