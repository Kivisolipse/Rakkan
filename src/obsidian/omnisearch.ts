// Omnisearch compatibility. Omnisearch splits words at punctuation, so a word
// split by markers (分页@@机制@@, pagi@@nation@@) is indexed in pieces and a
// search for the whole word misses it. Omnisearch has no API for what it
// indexes, so this patches its instances through monkey-around, each patch
// checking its target first:
//   - the tokenizer also yields the words of the note without markers;
//   - matches are found across markers in the note as written, so opening a
//     result still lands on the hit;
//   - excerpts are cut from the note without markers.
// Notes indexed before the patch are added again once Omnisearch is ready.

import { around } from "monkey-around";
import { Component, type App } from "obsidian";
import { dropMarkerRuns, findPlain, mayHaveMarkers, parse, stripMarkers, type Stripped } from "../core";

interface Match {
  match: string;
  offset: number;
}

interface Tokens {
  tokenizeWords(text: string, opts?: object): string[];
  tokenizeTokens(text: string, opts?: object): string[];
}

interface Texts {
  getMatches(text: string, words: string[], query?: unknown): Match[];
  makeExcerpt(content: string, offset: number): string;
  highlightText(text: string, matches: Match[]): string;
}

interface OmnisearchPlugin {
  searchEngine?: { tokenizer?: Partial<Tokens>; addFromPaths?(paths: string[]): Promise<void> };
  textProcessor?: Partial<Texts>;
}

interface OmnisearchApi {
  registerOnIndexed(cb: () => void): void;
  unregisterOnIndexed(cb: () => void): void;
}

function omnisearch(app: App): OmnisearchPlugin | undefined {
  return (app as unknown as { plugins?: { getPlugin?(id: string): unknown } }).plugins?.getPlugin?.("omnisearch") as OmnisearchPlugin | undefined;
}

export function hasOmnisearch(app: App): boolean {
  return !!(app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins?.has("omnisearch");
}

/** Notes without markers, by text: Omnisearch asks about the same note several times per search. */
const plainCache = new Map<string, Stripped>();
function plainOf(text: string): Stripped {
  let p = plainCache.get(text);
  if (!p) {
    p = stripMarkers(parse(text));
    if (plainCache.size >= 64) plainCache.delete(plainCache.keys().next().value!);
    plainCache.set(text, p);
  }
  return p;
}

/** The first character of the text without markers at or after source `offset`. */
function plainIndex(p: Stripped, offset: number): number {
  let lo = 0;
  let hi = p.map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.map[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Tokens of the text, plus those of the same text without markers. */
const withPlainWords = (next: (text: string, opts?: object) => string[]) =>
  function (this: Tokens, text: string, opts?: object): string[] {
    const out = next.call(this, text, opts);
    if (!mayHaveMarkers(text)) return out;
    const plain = plainOf(text).text;
    if (plain === text) return out;
    const seen = new Set(out);
    return out.concat(next.call(this, plain, opts).filter((w) => !seen.has(w)));
  };

export class OmnisearchCompat extends Component {
  private live = false;

  constructor(private app: App) {
    super();
  }

  override onload() {
    this.live = true;
    this.app.workspace.onLayoutReady(() => this.hook());
  }

  override onunload() {
    this.live = false;
  }

  private hook() {
    if (!this.live) return;
    const plugin = omnisearch(this.app);
    const tokenizer = plugin?.searchEngine?.tokenizer;
    const texts = plugin?.textProcessor;
    if (typeof tokenizer?.tokenizeWords !== "function" || typeof tokenizer.tokenizeTokens !== "function") return;
    if (typeof texts?.getMatches !== "function" || typeof texts.makeExcerpt !== "function" || typeof texts.highlightText !== "function") return;

    this.register(around(tokenizer as Tokens, { tokenizeWords: withPlainWords, tokenizeTokens: withPlainWords }));
    this.register(
      around(texts as Texts, {
        getMatches(next) {
          return function (this: Texts, text: string, words: string[], query?: unknown) {
            const found = next.call(this, text, words, query);
            if (!mayHaveMarkers(text)) return found;
            // The hits across markers, the longest at each place.
            const p = plainOf(text);
            const ours = new Map<number, Match>();
            for (const w of words) {
              for (const h of findPlain(p, w, 100)) {
                if (h.to - h.from > (ours.get(h.from)?.match.length ?? 0)) ours.set(h.from, { match: text.slice(h.from, h.to), offset: h.from });
              }
            }
            // Omnisearch's order stays (its first match is the one a note opens
            // on), but a piece of a word split by markers gives way to the word.
            const seen = new Set<number>();
            const out = found.map((m) => {
              seen.add(m.offset);
              const longer = ours.get(m.offset);
              return longer && longer.match.length > m.match.length ? longer : m;
            });
            const rest = Array.from(ours.values()).filter((m) => !seen.has(m.offset));
            return out.concat(rest.sort((a, b) => a.offset - b.offset));
          };
        },
        makeExcerpt(next) {
          return function (this: Texts, content: string, offset: number) {
            if (!mayHaveMarkers(content)) return next.call(this, content, offset);
            const p = plainOf(content);
            return next.call(this, p.text, offset < 0 ? offset : plainIndex(p, offset));
          };
        },
        highlightText(next) {
          return function (this: Texts, text: string, matches: Match[]) {
            // An empty match would highlight everywhere.
            return next.call(this, text, matches.map((m) => ({ ...m, match: dropMarkerRuns(m.match) })).filter((m) => m.match));
          };
        },
      }),
    );

    const api = (globalThis as { omnisearch?: Partial<OmnisearchApi> }).omnisearch;
    const engine = plugin?.searchEngine;
    if (typeof api?.registerOnIndexed !== "function" || typeof engine?.addFromPaths !== "function") return;
    const reindex = () => void this.reindex((paths) => engine.addFromPaths!(paths));
    api.registerOnIndexed(reindex);
    this.register(() => api.unregisterOnIndexed?.(reindex));
  }

  /** Add the notes with markers again, so the index has their whole words. */
  private async reindex(add: (paths: string[]) => Promise<void>) {
    const marked: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (mayHaveMarkers(await this.app.vault.cachedRead(file))) marked.push(file.path);
    }
    if (this.live && marked.length) await add(marked);
  }
}
