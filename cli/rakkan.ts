// The rakkan command. `npm run build` bundles it into the agent skill
// (skills/rakkan/scripts/rakkan.mjs), so an agent can check and sign what it
// wrote without installing anything.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { lint, parseBook, Parser, signRevision, type Author, type ExtraPrefix } from "../src/core";
import { setLanguage, t } from "../src/i18n";

const USAGE = `Usage:
  rakkan lint <file or folder>... [--book <author book>]
  rakkan sign [--model <model ID>] <original> <revised>

lint   Checks Markdown notes for Rakkan markers that don't do what they look
       like: AI blocks without a closer or blank lines, markers without a
       partner, and [@key] that neither the note nor the author book defines.
       The author book is found through the Obsidian vault the note is in, or
       given with --book. Prints file:line:column, a code and a message for
       each problem.

sign   Compares <revised> with <original> and marks only what changed as
       written by the model, as Paste revision does in Obsidian. Every
       character that was kept keeps its author; markers the revision dropped
       are put back. Writes the result into <revised>.

Both exit with 1 when something needs a look, and with 2 on a usage error.`;

function* walk(path: string): Generator<string> {
  if (statSync(path).isFile()) {
    if (path.endsWith(".md")) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    yield* walk(join(path, name));
  }
}

interface Vault {
  authors: Record<string, Author>;
  extra: ExtraPrefix[];
}

const vaults = new Map<string, Vault>();

/** The author book and model prefixes of the vault holding `file`: the nearest folder above it with `.obsidian`. */
function vaultOf(file: string): Vault {
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".obsidian"))) {
      let vault = vaults.get(dir);
      if (!vault) vaults.set(dir, (vault = loadVault(dir)));
      return vault;
    }
    if (dirname(dir) === dir) return { authors: {}, extra: [] };
  }
}

function loadVault(root: string): Vault {
  let settings: { bookPath?: string; extraPrefixes?: ExtraPrefix[] } = {};
  try {
    settings = JSON.parse(readFileSync(join(root, ".obsidian/plugins/rakkan/data.json"), "utf8")) as typeof settings;
  } catch {
    // Not installed in this vault, or never configured: the defaults.
  }
  const extra = settings.extraPrefixes ?? [];
  const book = join(root, settings.bookPath ?? "AUTHORS.md");
  return { authors: existsSync(book) ? parseBook(readFileSync(book, "utf8"), extra) : {}, extra };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function lintCommand(paths: string[], bookFile?: string): number {
  setLanguage("en");
  const book = bookFile ? parseBook(readFileSync(bookFile, "utf8")) : undefined;
  const parser = new Parser();
  let notes = 0;
  let problems = 0;
  for (const path of paths) {
    for (const file of walk(path)) {
      notes++;
      const r = parser.parse(readFileSync(file, "utf8"));
      const vault = vaultOf(file);
      const name = relative(process.cwd(), file);
      for (const i of lint(r, book ?? vault.authors, vault.extra)) {
        problems++;
        console.log(`${name}:${i.line + 1}:${i.from - r.lines[i.line].from + 1}  ${i.code}  ${t(i.message, i.vars)}`);
      }
    }
  }
  const of = plural(notes, "note");
  console.log(problems ? `\n${plural(problems, "problem")} in ${of}.` : `No problems in ${of}.`);
  return problems ? 1 : 0;
}

function signCommand(original: string, revised: string, model?: string): number {
  const before = readFileSync(revised, "utf8");
  const r = signRevision(readFileSync(original, "utf8"), before, model);
  const name = relative(process.cwd(), revised);
  if (r.text !== before) writeFileSync(revised, r.text);
  const notes = [
    ...r.unmarked.map((n) => [n, "unmarked", "This line changed, but it holds a quote or code that sign can't mark; mark it by hand."] as const),
    ...r.foreign.map((n) => [n, "foreign-block", "Your changes here are inside an AI block another model signed, so they count as that model's."] as const),
    ...r.tasks.map((n) => [n, "task", "You ticked or unticked this task. A task's box is syntax, so who ticked it isn't recorded."] as const),
  ].sort((x, y) => x[0] - y[0]);
  for (const [n, code, message] of notes) console.log(`${name}:${n + 1}  ${code}  ${message}`);
  console.log(
    r.changed
      ? `${notes.length ? "\n" : ""}Signed ${plural(r.changed, "change")} in ${name}${model ? ` as ${model}` : ""}.`
      : `No changes from ${relative(process.cwd(), original)}.`,
  );
  return notes.length ? 1 : 0;
}

/** `--name value` taken out of `args`; null when the flag has no value. */
function option(args: string[], name: string): string | undefined | null {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value && !value.startsWith("--") ? value : null;
}

function main(args: string[]): number {
  const [command, ...rest] = args;
  if (command === "-h" || command === "--help") {
    console.log(USAGE);
    return 0;
  }
  const book = option(rest, "--book");
  const model = option(rest, "--model");
  const usable =
    command === "lint"
      ? rest.length > 0 && book !== null && model === undefined
      : command === "sign" && rest.length === 2 && book === undefined && model !== null && !/[\s[\]]/.test(model ?? "");
  if (!usable) {
    console.error(USAGE);
    return 2;
  }
  const missing = [...rest, ...(book ? [book] : [])].filter((p) => !existsSync(p));
  if (missing.length) {
    console.error(`rakkan: no such file or folder: ${missing.join(", ")}`);
    return 2;
  }
  return command === "lint" ? lintCommand(rest, book ?? undefined) : signCommand(rest[0], rest[1], model ?? undefined);
}

process.exitCode = main(process.argv.slice(2));
