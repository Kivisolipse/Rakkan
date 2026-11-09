export type Kind = "human" | "ai" | "quote";

/** Who a character belongs to. */
export interface Attr {
  kind: Kind;
  /** `[@key]` attached to the span or quote. */
  key?: string;
  /** Index into ParseResult.blocks when the character sits in an AI block. */
  block?: number;
  /**
   * True when the attribution comes from an explicit inline marker or quote,
   * false for the region default (unmarked human text, AI block body).
   */
  explicit: boolean;
}

/**
 * - text:   content, counted in stats
 * - mark:   Rakkan syntax (markers, `[@key]`, block lines, declarations)
 * - syntax: Markdown syntax that is not ours and not counted (fence lines, `>` prefixes)
 * - meta:   invisible or metadata (frontmatter, comments, definitions, iA block)
 */
export type Role = "text" | "mark" | "syntax" | "meta";

export type MarkType =
  | "open"
  | "close"
  | "cite"
  | "block-open"
  | "block-close"
  | "decl";

export interface Segment {
  from: number;
  to: number;
  role: Role;
  attr: Attr;
  mark?: MarkType;
}

/** An inline span opened by a marker pair, or a quote. Used for hiding markers. */
export interface InlineSpan {
  from: number; // start of the opening marker / opening quote
  to: number; // end of the closing marker / cite
  contentFrom: number;
  contentTo: number;
  attr: Attr;
  type: "marker" | "quote";
}

/**
 * A quote whose `[@key]` a model wrote (SPEC §4.4): a claim that `key` said it. Its words stay the AI's
 * until a check backs the claim; the claim is kept for lint and gateways to check.
 */
export interface Claim {
  /** The quoted text, between the quotation marks (or the blockquote's lines). */
  from: number;
  to: number;
  key: string;
  /** The `[@key]`. */
  cite: { from: number; to: number };
}

export interface Signature {
  raw: string;
  name?: string;
  id?: string;
}

export interface Block {
  index: number;
  signature: Signature;
  openLine: number;
  /** Line of the explicit `&&`, or null when closed implicitly by the next opener. */
  closeLine: number | null;
  /** Last line that belongs to the block (inclusive). */
  lastLine: number;
  from: number; // offset of the opener line start
  to: number; // offset of the end of the closer line (or last line)
}

export type DiagnosticCode =
  | "unclosed-fence"
  | "lone-closer"
  | "implicit-close"
  | "unclosed-block"
  | "blank-line"
  | "math-swallow";

export interface Diagnostic {
  from: number;
  to: number;
  line: number;
  code: DiagnosticCode;
  message: string;
}

export interface Stats {
  human: number;
  ai: number;
  quote: number;
  /** AI characters by author label (block signature or key). */
  aiByAuthor: Record<string, number>;
  /** Quote characters by key. */
  quoteByKey: Record<string, number>;
}

export interface LineInfo {
  from: number;
  to: number; // exclusive, without the line break
}

/** How a line was parsed; enough to re-parse or rewrite it in isolation. */
export interface LineContext {
  /** prose / code: inline markers apply; other: structural or skipped line. */
  mode: "prose" | "code" | "other";
  base: Attr;
  pair: "human" | "ai-block" | "quote";
  /** Characters at the start of the line that are not inline content (`> `). */
  prefix: number;
  inComment: boolean;
  ampLen: number;
  atLen: number;
  /** For the content lines of a fenced code block: the line of the opening fence. */
  codeFence?: number;
}

export interface ParseResult {
  text: string;
  lines: LineInfo[];
  lineContexts: LineContext[];
  segments: Segment[];
  spans: InlineSpan[];
  /** Quotes a model wrote: claims, whose words stay the AI's (SPEC §4.4). */
  claims: Claim[];
  blocks: Block[];
  diagnostics: Diagnostic[];
  definitions: Record<string, string>;
  stats: Stats;
  /** The first line after the frontmatter; 0 without one. */
  bodyStart: number;
}
