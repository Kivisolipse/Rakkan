// Usage: npm run stats -- <folder or file> [...more] [--verbose]
// Prints the human / AI / quote share of every Markdown file; with --verbose,
// every warning after the table as `file:line  code  message`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Parser } from "../src/core";

function* walk(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    if (path.endsWith(".md")) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    yield* walk(join(path, name));
  }
}

const pct = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : "-");

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const roots = args.filter((a) => a !== "--verbose");
if (!roots.length) {
  console.error("usage: npm run stats -- <folder or file> [...] [--verbose]");
  process.exit(1);
}

const parser = new Parser();
const totals = { human: 0, ai: 0, quote: 0 };
const rows: string[][] = [];
const notes: string[][] = [];
let warnings = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    const r = parser.parse(readFileSync(file, "utf8"));
    const { human, ai, quote } = r.stats;
    const total = human + ai + quote;
    totals.human += human;
    totals.ai += ai;
    totals.quote += quote;
    warnings += r.diagnostics.length;
    const name = relative(process.cwd(), file);
    if (verbose) for (const d of r.diagnostics) notes.push([`${name}:${d.line + 1}`, d.code, d.message]);
    rows.push([
      name,
      pct(human, total),
      pct(ai, total),
      pct(quote, total),
      String(total),
      r.diagnostics.length ? String(r.diagnostics.length) : "",
    ]);
  }
}

/** Rows as columns two spaces apart. */
function table(all: string[][]): string[] {
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => [...r[i]].length)));
  return all.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  "));
}

for (const line of table([["file", "原创", "AI", "引用", "chars", "warn"], ...rows])) console.log(line);
if (notes.length) {
  console.log();
  for (const line of table(notes)) console.log(line.trimEnd());
}
const t = totals.human + totals.ai + totals.quote;
console.log(
  `\n合计 ${rows.length} 篇：原创 ${pct(totals.human, t)} · AI ${pct(totals.ai, t)} · 引用 ${pct(totals.quote, t)}` +
    (warnings ? ` · ${warnings} 处提醒` : ""),
);
