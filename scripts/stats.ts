// Usage: npm run stats -- <folder or file> [...more]
// Prints the human / AI / quote share of every Markdown file.

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

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error("usage: npm run stats -- <folder or file> [...]");
  process.exit(1);
}

const parser = new Parser();
const totals = { human: 0, ai: 0, quote: 0 };
const rows: string[][] = [];
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
    rows.push([
      relative(process.cwd(), file),
      pct(human, total),
      pct(ai, total),
      pct(quote, total),
      String(total),
      r.diagnostics.length ? String(r.diagnostics.length) : "",
    ]);
  }
}

const header = ["file", "原创", "AI", "引用", "chars", "warn"];
const all = [header, ...rows];
const widths = header.map((_, i) => Math.max(...all.map((r) => [...r[i]].length)));
for (const r of all) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  "));
const t = totals.human + totals.ai + totals.quote;
console.log(
  `\n合计 ${rows.length} 篇：原创 ${pct(totals.human, t)} · AI ${pct(totals.ai, t)} · 引用 ${pct(totals.quote, t)}` +
    (warnings ? ` · ${warnings} 处提醒` : ""),
);
