// rakkan-mcp: the rakkan command's sign and lint as MCP tools, in front of a
// filesystem MCP server.
//
//   rakkan-mcp [--keep-human] [--deny-dir NAME]... [--book PATH] -- <command> [args...]
//
// Starts <command> as a stdio MCP server and passes every message through,
// adding two tools to its list:
//
//   rakkan_sign  edit a note and mark exactly what changed, as `rakkan sign` does
//   rakkan_lint  what `rakkan lint` reports, with the note's authorship shares
//
// Notes are read and written through the wrapped server's own read_text_file
// and write_file, so its allowed directories and filters apply. The agent
// skill in skills/rakkan describes how agents sign; the server's instructions
// say the same in short.

import { spawn } from "node:child_process";
import readline from "node:readline";
import { carryOwners, lint, parse, parseAuthor, parseBook, signRevision, stripMarkers, type Author, type ParseResult } from "../src/core";
import { setLanguage, t } from "../src/i18n";

setLanguage("en");

// ── Options ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) {
  process.stderr.write("usage: rakkan-mcp [--keep-human] [--deny-dir NAME]... [--book PATH] -- <command> [args...]\n");
  process.exit(2);
}
const own = argv.slice(0, sep);
const [command, ...commandArgs] = argv.slice(sep + 1);
const keepHuman = own.includes("--keep-human");
const denyDirs: string[] = [];
let bookPath: string | undefined;
for (let i = 0; i < own.length; i++) {
  if (own[i] === "--deny-dir" && own[i + 1]) denyDirs.push(own[++i]);
  else if (own[i] === "--book" && own[i + 1]) bookPath = own[++i];
}

// ── Plumbing ────────────────────────────────────────────────────────────

type Id = string | number;
interface Message {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "inherit"] });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (e) => {
  process.stderr.write(`rakkan-mcp: cannot start ${command}: ${e.message}\n`);
  process.exit(1);
});
for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => child.kill(s));

const toChild = (line: string) => child.stdin.write(line + "\n");
const toParent = (line: string) => process.stdout.write(line + "\n");
const idKey = (id: Id) => JSON.stringify(id);

const pending = new Map<string, { resolve: (m: Message) => void }>();
const listing = new Set<string>();
const initializing = new Set<string>();
let innerTools: Set<string> | null = null;
let seq = 0;

function request(method: string, params: Record<string, unknown>): Promise<Message> {
  const id = `rakkan:${++seq}`;
  return new Promise((resolve) => {
    pending.set(idKey(id), { resolve });
    toChild(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function callInner(name: string, args: Record<string, unknown>): Promise<string> {
  const m = await request("tools/call", { name, arguments: args });
  if (m.error) throw new Error(m.error.message);
  const res = m.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: { content?: unknown } };
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  if (res.isError) throw new Error(text || `${name} failed`);
  return typeof res.structuredContent?.content === "string" ? res.structuredContent.content : text;
}

async function tools(): Promise<Set<string>> {
  if (!innerTools) {
    const m = await request("tools/list", {});
    innerTools = new Set(((m.result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name));
  }
  return innerTools;
}

async function readNote(path: string): Promise<string> {
  const have = await tools();
  return callInner(have.has("read_text_file") || !have.has("read_file") ? "read_text_file" : "read_file", { path });
}

async function writeNote(path: string, content: string): Promise<void> {
  await callInner("write_file", { path, content });
}

// ── Tools ───────────────────────────────────────────────────────────────

const SKILL = "https://github.com/Kivisolipse/Rakkan/blob/main/skills/rakkan/SKILL.md";

const INSTRUCTIONS = [
  `Notes here are signed with Rakkan markers (${SKILL}): unmarked text is human, so every word you write carries a mark and every mark already there survives your edit. Sign with your model ID as the API spells it, e.g. claude-opus-5-5.`,
  "New paragraphs: put them in an AI block of your own, a line `&& Name (model-id)` before and a line `&&` after, each with a blank line around it (none needed above the opener right below the frontmatter). Blocks don't nest; a list or blockquote goes inside the block whole.",
  "Changing someone else's words: use rakkan_sign with plain newText; it marks exactly the characters you changed and keeps every other author's marks. A few words of your own inside their text may also be marked by hand as `&&words&&[@model-id]`.",
  "Keep every existing mark: `&&`, `@@…@@` (the author's own words inside AI text), block lines, `[@key]` and definition lines at the end of a note. Quote word for word as `「…」[@key]`.",
  "Before you finish, run rakkan_lint on each note you wrote and fix the problems your edit caused.",
  keepHuman ? "Human-written text is kept as written here: rakkan_sign refuses edits that delete or replace it, so add your words next to it." : "",
  "If the folder has an AGENTS.md, it sets local rules, such as the name to sign blocks with.",
]
  .filter(Boolean)
  .join("\n");

const RAKKAN_TOOLS = [
  {
    name: "rakkan_sign",
    title: "Edit and sign (Rakkan)",
    description:
      "Edit a Markdown note and let Rakkan mark exactly the characters you changed as your model's, like `rakkan sign`: words you kept keep their author, `@@` islands and other models' [@key] included, even where your newText dropped their markers. Write newText as plain words; a new paragraph may come in your own AI block. Use this instead of edit_file to change prose that someone else wrote. Reports lines it could not mark (quotes, code) and changes that landed in another model's AI block." +
      (keepHuman ? " Human-written text cannot be deleted or replaced here." : ""),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The note to edit." },
        edits: {
          type: "array",
          description: "Replacements, applied in order to the note as it reads after the previous one.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "The passage to replace, copied from the note. Markers may be included or left out. It must occur once." },
              newText: { type: "string", description: "What the passage should read, in plain words." },
            },
            required: ["oldText", "newText"],
          },
        },
        model: { type: "string", description: "Your model ID as your provider's API spells it, e.g. claude-opus-5-5. If you don't know it, your model family (Claude, GPT, …)." },
        name: { type: "string", description: "The name you sign blocks with, if the folder's rules give you one. An AI block signed with this name and no model ID counts as yours." },
        dryRun: { type: "boolean", description: "Show the result without writing it.", default: false },
      },
      required: ["path", "edits", "model"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "rakkan_lint",
    title: "Lint (Rakkan)",
    description:
      "Check a note's Rakkan markers, like `rakkan lint`: AI blocks without a closer or blank lines, markers without a partner or that do nothing where they are, [@key] that neither the note nor the author book defines, markers swallowed by math. Prints line:column, a code and a message for each problem, then the share of human, AI and quoted text and the AI text by author. Run it on every note you wrote before you finish.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "The note to check." } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function denied(path: string): string | null {
  const parts = path.split(/[\\/]+/);
  const hit = denyDirs.find((d) => parts.includes(d));
  return hit ? `Rakkan tools do not open files in «${hit}».` : null;
}

async function loadBook(): Promise<Record<string, Author>> {
  if (!bookPath) return {};
  try {
    return parseBook(await readNote(bookPath));
  } catch {
    return {};
  }
}

function countOf(s: string, sub: string): number[] {
  const hits: number[] = [];
  for (let i = s.indexOf(sub); i >= 0; i = s.indexOf(sub, i + 1)) hits.push(i);
  return hits;
}

const clip = (s: string, max = 60) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
};

/** Where `oldText` is in the note: as written, or in the text without markers. */
function locate(doc: string, oldText: string): { from: number; to: number } {
  if (!oldText) throw new Error("oldText is empty; copy the passage to replace from the note");
  const unique = (hits: number[]) => {
    if (hits.length > 1) throw new Error(`oldText occurs ${hits.length} times; include more of the text around it`);
    return hits.length === 1;
  };
  const raw = countOf(doc, oldText);
  if (unique(raw)) return { from: raw[0], to: raw[0] + oldText.length };
  const plain = stripMarkers(parse(doc));
  for (const q of [oldText, stripMarkers(parse(oldText)).text]) {
    if (!q) continue;
    const hits = countOf(plain.text, q);
    if (unique(hits)) return { from: plain.map[hits[0]], to: plain.map[hits[0] + q.length - 1] + 1 };
  }
  throw new Error(`oldText not found: «${clip(oldText)}»`);
}

/** One code per character of the note without markers: H for human-written text, x for anything else. */
function humanCodes(r: ParseResult, map: number[]): string {
  const kind = new Uint8Array(r.text.length);
  for (const s of r.segments) if (s.role === "text" && s.attr.kind === "human") kind.fill(1, s.from, s.to);
  return map.map((pos) => (kind[pos] ? "H" : "x")).join("");
}

/** Human-written characters (not whitespace) that `revised` no longer has. */
function humanLost(original: string, revised: string): number {
  const a = stripMarkers(parse(original));
  const b = stripMarkers(parse(revised));
  const codes = humanCodes(parse(original), a.map);
  const carried = carryOwners(a.text, codes, b.text);
  const count = (text: string, owners: string) => [...text].filter((ch, i) => owners[i] === "H" && /\S/.test(ch)).length;
  return Math.max(0, count(a.text, codes) - count(b.text, carried.owners));
}

const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 1000) / 10}%` : "-");

function lintLines(r: ParseResult, book: Record<string, Author>): string[] {
  return lint(r, book).map((i) => `- ${i.line + 1}:${i.from - r.lines[i.line].from + 1}  ${i.code}  ${t(i.message, i.vars)}`);
}

function shares(r: ParseResult): string[] {
  const { human, ai, quote, quoteByKey } = r.stats;
  const total = human + ai + quote;
  const out = [`Human ${pct(human, total)} · AI ${pct(ai, total)} · quotes ${pct(quote, total)} (${total} characters)`];
  // AI text by who signed it: the block signature, or the author behind `[@key]`.
  const by = new Map<string, number>();
  for (const s of r.segments) {
    if (s.role !== "text" || s.attr.kind !== "ai") continue;
    const a = s.attr;
    let who = "AI";
    if (a.key) {
      const def = r.definitions[a.key];
      const au = def ? parseAuthor(a.key, def) : undefined;
      who = au?.name && au.id ? `${au.name} (${au.id})` : (au?.name ?? au?.id ?? a.key);
    } else if (a.block !== undefined) who = r.blocks[a.block]?.signature.raw ?? "AI";
    const n = Array.from(r.text.slice(s.from, s.to)).filter((c) => /\S/.test(c)).length;
    if (n) by.set(who, (by.get(who) ?? 0) + n);
  }
  const authors = [...by].sort((x, y) => y[1] - x[1]);
  if (authors.length) out.push(`AI by author: ${authors.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const quotes = Object.entries(quoteByKey).sort((x, y) => y[1] - x[1]);
  if (quotes.length) out.push(`Quotes by source: ${quotes.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  return out;
}

async function rakkanSign(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "");
  const block = denied(path);
  if (block) throw new Error(block);
  const edits = args.edits as Array<{ oldText: string; newText: string }> | undefined;
  if (!Array.isArray(edits) || !edits.length) throw new Error("edits must be a non-empty array of { oldText, newText }");
  if (edits.some((e) => typeof e?.oldText !== "string" || typeof e?.newText !== "string")) throw new Error("every edit needs oldText and newText strings");
  const model = typeof args.model === "string" ? args.model.trim() : "";
  if (!model || /[\s[\]]/.test(model)) throw new Error("model must be your model ID without spaces or brackets, e.g. claude-opus-5-5");
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const dryRun = args.dryRun === true;

  const before = await readNote(path);
  const crlf = before.includes("\r\n");
  const original = crlf ? before.replace(/\r\n/g, "\n") : before;
  let revised = original;
  edits.forEach((e, i) => {
    try {
      const { from, to } = locate(revised, e.oldText.replace(/\r\n/g, "\n"));
      revised = revised.slice(0, from) + e.newText.replace(/\r\n/g, "\n") + revised.slice(to);
    } catch (err) {
      throw new Error(`edit ${i + 1}: ${(err as Error).message}. Nothing was written.`);
    }
  });
  if (keepHuman) {
    const lost = humanLost(original, revised);
    if (lost) {
      throw new Error(
        `these edits would delete or replace ${lost} human-written character${lost > 1 ? "s" : ""}. Human text is kept as written here: leave it and add your words next to it. Nothing was written.`,
      );
    }
  }
  const signed = signRevision(original, revised, model);
  // A block signed with the agent's own name and no model ID (written before IDs were recorded) is the agent's own.
  if (name && signed.foreign.length) {
    const r = parse(signed.text);
    signed.foreign = signed.foreign.filter((n) => {
      const b = r.blocks.find((x) => x.openLine < n && n <= x.lastLine);
      return !(b && !b.signature.id && b.signature.name === name);
    });
  }
  const result = crlf ? signed.text.replace(/\n/g, "\r\n") : signed.text;
  if (result === before) return `No changes: the edits leave ${path} as it is.`;
  if (!dryRun) {
    const now = await readNote(path);
    if (now !== before) throw new Error(`${path} changed while the edit was being signed; read it again and retry. Nothing was written.`);
    await writeNote(path, result);
  }

  const out = [`${dryRun ? "Dry run: would sign" : "Signed"} ${signed.changed} change${signed.changed === 1 ? "" : "s"} in ${path} as ${model}.`];
  const notes = [
    ...signed.unmarked.map((n) => [n, "unmarked", `This line changed, but it holds a quote or code that sign can't mark. Your words there still read as human: mark them by hand as &&words&&[@${model}] with edit_file, then run rakkan_lint.`] as const),
    ...signed.foreign.map((n) => [n, "foreign-block", "Your changes here are inside an AI block another model signed, so they count as that model's."] as const),
    ...signed.tasks.map((n) => [n, "task", "You ticked or unticked this task. A task's box is syntax, so who ticked it isn't recorded: tell the person."] as const),
  ].sort((x, y) => x[0] - y[0]);
  if (notes.length) out.push(...notes.map(([n, code, msg]) => `- ${n + 1}  ${code}  ${msg}`));
  const book = await loadBook();
  const issues = lintLines(parse(signed.text), book);
  const had = lintLines(parse(original), book).length;
  out.push(issues.length ? `Lint (${had} before the edit):` : "Lint: no problems.", ...issues);
  out.push("", "```diff", diff(original, signed.text), "```");
  return out.join("\n");
}

async function rakkanLint(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "");
  const block = denied(path);
  if (block) throw new Error(block);
  const r = parse(await readNote(path));
  const issues = lintLines(r, await loadBook());
  return [`${path}: ${issues.length ? `${issues.length} problem${issues.length > 1 ? "s" : ""}` : "no problems"}.`, ...issues, ...shares(r)].join("\n");
}

const HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  rakkan_sign: rakkanSign,
  rakkan_lint: rakkanLint,
};

/** A unified diff of the lines that differ, in hunks with two lines of context. */
function diff(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let ex = x.length;
  let ey = y.length;
  while (ex > s && ey > s && x[ex - 1] === y[ey - 1]) {
    ex--;
    ey--;
  }
  const xs = x.slice(s, ex);
  const ys = y.slice(s, ey);
  const n = xs.length;
  const m = ys.length;
  // Every line as [kind, text, old line, new line] (1-based).
  type Op = [" " | "-" | "+", string, number, number];
  const ops: Op[] = [];
  for (let k = 0; k < s; k++) ops.push([" ", x[k], k + 1, k + 1]);
  let i = 0;
  let j = 0;
  if (n * m <= 250_000) {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let p = n - 1; p >= 0; p--) for (let q = m - 1; q >= 0; q--) dp[p][q] = xs[p] === ys[q] ? dp[p + 1][q + 1] + 1 : Math.max(dp[p + 1][q], dp[p][q + 1]);
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) {
        ops.push([" ", xs[i], s + i + 1, s + j + 1]);
        i++;
        j++;
      } else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) {
        ops.push(["-", xs[i], s + i + 1, s + j + 1]);
        i++;
      } else {
        ops.push(["+", ys[j], s + i + 1, s + j + 1]);
        j++;
      }
    }
  } else {
    for (; i < n; i++) ops.push(["-", xs[i], s + i + 1, s + 1]);
    for (; j < m; j++) ops.push(["+", ys[j], s + n + 1, s + j + 1]);
  }
  for (let k = ex; k < x.length; k++) ops.push([" ", x[k], k + 1, ey + (k - ex) + 1]);

  const CONTEXT = 2;
  const out: string[] = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k][0] === " ") {
      k++;
      continue;
    }
    const from = Math.max(0, k - CONTEXT);
    let to = k;
    // Extend over changes, joining the next one when the gap is short.
    while (to < ops.length) {
      if (ops[to][0] !== " ") {
        to++;
        continue;
      }
      let gap = to;
      while (gap < ops.length && ops[gap][0] === " ") gap++;
      if (gap < ops.length && gap - to <= CONTEXT * 2) to = gap;
      else break;
    }
    const end = Math.min(ops.length, to + CONTEXT);
    const hunk = ops.slice(from, end);
    const oldLen = hunk.filter((o) => o[0] !== "+").length;
    const newLen = hunk.filter((o) => o[0] !== "-").length;
    out.push(`@@ -${hunk[0][2]},${oldLen} +${hunk[0][3]},${newLen} @@`, ...hunk.map((o) => o[0] + o[1]));
    k = end;
  }
  return out.join("\n");
}

// ── Routing ─────────────────────────────────────────────────────────────

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  let msg: Message;
  try {
    msg = JSON.parse(line) as Message;
  } catch {
    toChild(line);
    return;
  }
  if (Array.isArray(msg) || msg.id === undefined || !msg.method) {
    toChild(line);
    return;
  }
  const handler = msg.method === "tools/call" ? HANDLERS[String(msg.params?.name)] : undefined;
  if (handler) {
    const id = msg.id;
    const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
    handler(args).then(
      (text) => toParent(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })),
      (e: unknown) =>
        toParent(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true } })),
    );
    return;
  }
  if (msg.method === "tools/list") listing.add(idKey(msg.id));
  if (msg.method === "initialize") initializing.add(idKey(msg.id));
  toChild(line);
});
process.stdin.on("end", () => child.stdin.end());

readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let msg: Message;
  try {
    msg = JSON.parse(line) as Message;
  } catch {
    toParent(line);
    return;
  }
  if (Array.isArray(msg) || msg.id === undefined || msg.method) {
    toParent(line);
    return;
  }
  const key = idKey(msg.id);
  const mine = pending.get(key);
  if (mine) {
    pending.delete(key);
    mine.resolve(msg);
    return;
  }
  if (listing.delete(key) && msg.result && Array.isArray(msg.result.tools)) {
    const list = msg.result.tools as Array<{ name: string }>;
    innerTools ??= new Set();
    for (const t of list) innerTools.add(t.name);
    if (!msg.result.nextCursor) list.push(...RAKKAN_TOOLS);
    toParent(JSON.stringify(msg));
    return;
  }
  if (initializing.delete(key) && msg.result) {
    const prev = typeof msg.result.instructions === "string" ? msg.result.instructions + "\n\n" : "";
    msg.result.instructions = prev + INSTRUCTIONS;
    toParent(JSON.stringify(msg));
    return;
  }
  toParent(line);
});
