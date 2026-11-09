# Rakkan Specification v0.2

**English** · [中文](SPEC.zh.md)

> Every character, signed.

Rakkan marks, in plain text, which characters of a Markdown note a person wrote, which an AI wrote, and which were quoted from elsewhere, down to a single character. This document is the syntax; the Obsidian plugin is one implementation of it.

Every example here is fictional.

> **When in doubt, not the person's.** Unmarked text counts as a person's (principle 2), so whatever fails to be marked falls on a person by default. An implementation that writes or changes marks and can't be sure who wrote something may therefore only err away from the person: keep the text as it was, credit it to the model, or report it. A character becomes the person's only if a person wrote it before or has just typed it.

## 1. Principles

1. **Plain text first.** The file reads fine without the plugin, and a few regular expressions reproduce the distinction.
2. **Human by default.** Unmarked text counts as written by a person. Marking is the AI's job.
3. **Short enough to type by hand.** The markers belong to the same family as `**` and `~~`.
4. **Styles are yours to choose.** By default each model family has its own colour, and every family or model can have a style of its own.
5. **No lock-in.** Notes convert to and from iA Writer's Markdown Annotations.
6. **Down to the character.** Even one character by another author can be marked.
7. **Warnings where authorship is at stake.** An implementation warns about problems that would silently lose or misattribute authorship, not about problems of display alone.

## 2. At a glance

```
Unmarked words are the person's. &&This sentence is the AI's&&[@gpt], and then the person again.
The book says "ink outlasts memory"[@fakebook], and I agree.

&& Claude (claude-opus-5-5)

A whole AI block, which can hold headings, lists, tables and code blocks.
In the middle, @@a sentence the author added@@, and a quote, "less is more"[@mies].

&&

> A quoted passage goes in a blockquote, with its source on the last line.
> [@fakebook]
```

| Write | Meaning |
|---|---|
| `&&text&&` | Inline AI text |
| `@@text@@` | Text by a person, inside AI text and attributed quotes (a human island) |
| A line `&& signature` (at shortest `&& AI`) | Opens an AI block |
| A line with only `&&` | Closes an AI block, and only that |
| `"text"[@key]`, `「text」[@key]` | A quote: the text inside the quotation marks belongs to the author `key` |
| `&&text&&[@key]` | Inline AI text, naming the model |
| `\&&`, `\@@` | Escapes |

## 3. Markers

A line ends at CR LF, CR or LF, as in CommonMark. An implementation reads the line ends as they are and writes them back unchanged: it does not turn a note's line ends into one kind.

### 3.1 Length

A marker in prose is **exactly two** of the same character: `&&` or `@@`. Runs of three or more, such as `&&&` or `@@@`, show as they are. A single `&` or `@` (an email address, an @mention) is not a marker.

A pair after an odd number of backslashes is escaped: `\&&` shows as `&&` and is not a marker. Backslashes pair up first, as in CommonMark: `\\` is one literal backslash, so in `\\&&` the backslash shows and the `&&` is a marker, while `\\\&&` shows as `\&&`.

When an HTML entity follows `&&` directly (`&&amp;`), the entity wins and the two `&` are not a marker.

### 3.2 Regions and context

A note is made of three kinds of region:

- **Human regions**, the default. Here `&&` is a marker and `@@` shows as it is.
- **AI regions**: AI blocks, and inline `&&…&&`. Here `@@` is a marker and `&&` shows as it is.
- **Attributed quotes.** Both `&&` and `@@` are markers here, to mark the words changed in quoting.

Nesting goes one level deep:

| Outside | Markers in effect | Inside |
|---|---|---|
| Human region | `&&` | Inline AI |
| Inline AI | `@@` | Human island |
| AI block | `@@` | Human island |
| Quote | `&&`, `@@` | Inline AI (which can hold `@@`), human island |
| Human island | none | — |

### 3.3 Pairing

- Inline markers don't span lines.
- On one line, markers of the same kind pair up from left to right, whatever characters sit on either side. CommonMark's flanking rules don't apply: `word&&"quote"&&word` still counts.
- A marker without its pair shows as it is.
- When the two kinds cross (`&&A@@B&&C@@`), the pair opened later shows as it is: here `&&A@@B&&` is inline AI, and the `@@` inside it shows as it is.

### 3.4 AI blocks

```
&& Claude (claude-opus-5-5)

The block's content

&&
```

- **Opener:** a line that starts with `&&`, followed by whitespace and a signature. A signature can't contain `&&`, so `&& a sentence &&` is inline, not a block. Escapes work as in prose (§3.1): `&& Name \&& Co (id)` opens a block signed `Name && Co`. `&&a sentence` (no whitespace) doesn't open a block either.
- **Closer:** a line with only `&&`. It **only ever closes**.
- Blocks don't nest. An opener inside a block means the previous block lost its closer: the previous block ends there, and the implementation should warn.
- A lone `&&` with no opener shows as it is, and the implementation should warn.
- An opener that never meets a closer before the end of the file shows as it is, and the implementation should warn.
- The opener and closer lines **must have a blank line before and after**. Without one, a `&&` right below a table would be read as a row of the table. One exception: an opener right below the frontmatter needs no blank line above, though it still needs one below. The implementation should warn and be able to add the blank lines.
- The opener and closer lines may be indented by at most 3 spaces. Inside a blockquote or a list they don't count.

### 3.5 Signatures

A block's signature is written `Display name (ID)`. Either part may be left out, not both:

| Signature | Display name | ID |
|---|---|---|
| `&& Claude (claude-opus-5-5)` | Claude | claude-opus-5-5 |
| `&& (gpt-5)` | (the family name from the ID: GPT) | gpt-5 |
| `&& AI` | AI | — |
| `&& Assistant（claude-sonnet-5-5）` | Assistant | claude-sonnet-5-5 |

- An AI's ID is its model ID, spelled as in the provider's API.
- Full-width parentheses work too.
- The ID takes no angle brackets: Markdown would swallow `<claude-opus-5-5>` as an HTML tag.
- The author of the whole note is still the frontmatter's `author`.

### 3.6 Model families

The family comes from the prefix of the model ID, or from the display name when the ID doesn't tell:

| Prefix | Family |
|---|---|
| `claude` | Claude |
| `gpt`, `chatgpt`, `o1`, `o3`, `o4` | GPT |
| `gemini` | Gemini |
| `deepseek` | DeepSeek |
| `grok` | Grok |
| `llama` | Llama |
| `muse` | Muse |
| `qwen` | Qwen |
| `mistral`, `mixtral` | Mistral |
| `kimi`, `moonshot` | Kimi |
| `glm` | GLM |

`muse` must be followed by the end, `-` or a digit: `muse-spark-1.3` is Muse, `museum` is not.

## 4. Quotes and authors

### 4.1 `[@key]`

The syntax follows Pandoc's citations. A key is a run of characters with no whitespace or square brackets.

`[@key]` names an author only **right after a closing mark** (at most one space between):

- A closing quotation mark, `」` `』` `”` or `"`: the text inside the quotation marks belongs to `key`. The opening mark is searched for backwards on the same line only; `"` has no left or right, so the nearest one on the line is taken. Single quotation marks aren't supported, since they can't be told from apostrophes.
- The end of an inline marker: `&&text&&[@key]` names the model of that AI text; `@@text@@[@key]` names the person who wrote those words.

A `[@key]` after anything else is an ordinary Pandoc citation and changes no authorship. One followed directly by `(` or `:` doesn't count (it is a link or a link definition).

The quotation marks themselves belong to the text around them; `[@key]` is a marker.

### 4.2 Blockquotes

A quoted passage goes in a blockquote whose **last line** is only `[@key]`:

```
> The first quoted line
> The second quoted line
> [@fakebook]
```

All the text in the blockquote belongs to `key`, and both `&&` and `@@` are markers inside it.

### 4.3 The author book and definitions

Each author a `[@key]` points at is defined on a line of its own:

```
- @key: Name (ID) · kind · #colour
```

| Part | How to write it |
|---|---|
| Name | The display name. As in a block signature, it may be left out, leaving only the ID |
| ID | In parentheses: a model ID, URL, ISBN… Full-width parentheses work too |
| Kind | `human`, `AI` or `source` (also `人`, `来源`; any case). Without one, an ID with a known model family makes it AI, and anything else human |
| Colour | `#rrggbb` or `#rgb`, optional |
| Separator | `·` (also `•` or `\|`). After the name, the parts come in any order, and each may be left out |

The key is everything from `@` up to the first whitespace, less one colon at its end. A key may hold colons, as in Pandoc: `@doe:2006: Jane Doe · source` defines `doe:2006`. The line is not split at the last `: `, so `@doe: Re: a letter` defines `doe`.

The leading `- ` is optional. What the kinds mean: a `human` has a colour of their own, computed from the key when none is given; an `AI` takes the colour of its model family; a `source` is for a work whose author isn't known (a book, a web page), and is shown dimmed.

The **author book** is a note in the vault with one author per line. Everything else in it (headings, notes) is ignored, and when a key appears twice, the first wins. The author book doubles as a bibliography.

A note can carry the same definitions **at its end**, so they travel with the file when it is sent on its own. Where they disagree with the author book, the note's own win:

```
@opus: Claude (claude-opus-5-5) · AI
@fakebook: A Book That Does Not Exist · source
```

Definitions take no square brackets: `[@key]: …` is a Markdown link definition, and the whole line would vanish. A key with no definition still makes an attributed quote, only without a colour of its own.

## 5. Skipped regions

`&&` and `@@` are not markers in these places:

| Place | Details |
|---|---|
| Frontmatter | From the `---` that opens the file to the next `---` |
| Code blocks | Fences pair as in CommonMark: at least 3 `` ` `` or `~`, closed by the same character, no fewer of them than opened. They may be indented in a list or sit in a blockquote |
| Inline code | Backticks pair by count, on the same line only |
| Math | `$$…$$` blocks. Inline `$…$` follows Pandoc: no whitespace after the opening `$`, none before the closing `$`, and no digit right after it. `\$` is an escape |
| Obsidian comments | `%%…%%`, which may span lines |
| Link URLs | The URL in `[text](URL)`, and bare URLs `https://…` |
| iA annotation blocks | The part after a final `---` followed by `Annotations:` |

**A bare URL** runs to the next whitespace, as in GFM, which leaves trailing sentence punctuation (`.,;:!?`) out of it. A live marker at its end is left out the same way and closes the span around it: in `&&see https://example.com/&&` the URL is `https://example.com/` and the `&&` closes the inline AI text, with or without a `[@key]` after it. A pair that closes nothing there stays part of the URL: one that would open a span, as in `https://example.com/&& more&&`, and `\&&` or `&&&`.

Skipped regions don't change authorship: code in an AI block is AI-written as a whole, and so is the whole formula in `&&$x^2$&&`.

**An unclosed code fence** turns the rest of the note into code, and every marker after it silently stops working. The implementation should warn.

**`&&` or `@@` inside math** most likely means amounts of money were taken for a formula. The implementation should warn and suggest `\$`.

## 6. Authorship in code

Code blocks parse no markers by default. To mark individual characters in code, **declare** the markers in the info string:

````
```ts @@
let total = 0
let count = @@0@@
```
````

- A declaration is a word after the language name made only of `@` or only of `&`, at least two characters long. Both kinds can be declared together: ```` ```ts @@ &&& ````.
- Only runs exactly as long as the declaration count as markers in the block. If the code already uses `&&`, declare `&&&`:

  ````
  ```c &&&
  if (a && b) return &&&fallback()&&&;
  ```
  ````

- The context rules are those of prose: in code inside an AI block, declare `@@` to mark human islands; in code in a human region, declare `&&&` to mark AI text.
- To strip the markers, one regular expression per declaration is enough.

## 7. Counting

Human, AI and quoted text are counted in Unicode code points, leaving out whitespace, markers, frontmatter, comments, definitions, iA annotation blocks, code fence lines, the `>` of blockquotes, and line syntax.

**Whitespace** is every character with the Unicode property White_Space (no-break spaces, U+2028, U+0085 included). Characters with the property Default_Ignorable_Code_Point (a byte order mark, zero-width spaces and joiners, variation selectors, soft hyphens) aren't counted either: what can't be seen isn't written.

**Line syntax** is Markdown that doesn't show as text once rendered: the leader of a heading, list item, task or footnote (`## `, `- `, `1. `, `- [x] `, `[^1]: `), and in a line that starts with `|`, its pipes, or all of it for a delimiter row (`|---|:-:|`). It belongs to no one.

**Known limitation:** a task's box is line syntax, so who ticked or unticked it isn't recorded. An implementation that signs a revision reports the tasks the model ticked or unticked.

## 8. Programs that read the source

Markers split words, so a search of the source misses them. A loose search puts a "gap" between every two characters:

```
[@&*=~`\[\]]*
```

So "word" becomes `` w[@&*=~`\[\]]*o[@&*=~`\[\]]*r[@&*=~`\[\]]*d ``. The gap is a character class with no nested quantifiers, so the search runs in linear time.

## 9. Rejected designs

- A default author for the whole note (frontmatter making the whole note AI)
- Markers hidden in zero-width characters
- Character positions recorded at the end of the file, checked by a hash
- `++text++` as a quote marker
- `&&[opus]…&&`, `[&opus]: …`
