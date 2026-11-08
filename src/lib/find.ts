/**
 * Search one session by any combination of handles (specs/cli.md#find, specs/api.md#searching).
 * A streaming scan over the classified events: hits carry why they matched and the visible rows
 * around them. Handles combine with AND; a `call` matches a phrase in its linked result's text
 * unless results are searched as rows of their own.
 */
import { AgentSessionError } from "./errors.js";
import { comparePosition, formatId } from "./ids.js";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { boundSeq, kindSet, pointerAccess, windowStart } from "./events.js";
import { inSpan } from "./hold.js";
import { resolveWindow, type WindowRange, type WindowSel } from "./windows.js";
import type { CacheOpts } from "./cache/store.js";
import type { Event, EventId, Kind, Session } from "./model.js";
import { readLines } from "./reader.js";
import { newContext } from "./adapters/adapter.js";
import { claudeCode } from "./adapters/claude-code/index.js";

export type Why = "phrase" | "file" | "tool" | "kind";
/** The fixed order `why` names handles in (cli.md#find). */
export const WHY_ORDER: readonly Why[] = ["phrase", "file", "tool", "kind"];

export interface FindQuery {
  phrase?: string;
  regex?: boolean;
  /** Substring, or a glob when it contains `*`, `?` or `[`. */
  file?: string;
  /** Case-insensitive substring of the tool name. */
  tool?: string;
  kinds?: readonly Kind[];
  /** Inclusive start: a time or a position. */
  from?: Date | EventId;
  /** Exclusive end: a time or a position. */
  to?: Date | EventId;
  /** One compaction window (`k`, `last`, `k..`); default `all` (behaviors/context-windows.md). */
  window?: WindowSel;
  /** Visible rows on each side of a hit (default 1), or each side separately. */
  context?: number | { before: number; after: number };
  /** Hits to yield; 0 or undefined = all. */
  limit?: number;
  /** Also search persisted-output files (only those the containment rule lets us follow). */
  deep?: boolean;
  /** Where the derived cache lives (a window selection reads the offset table). */
  cache?: CacheOpts;
}

export interface Hit {
  event: Event;
  why: Why[];
  /** The visible rows before and after the hit, in file order (the hit itself excluded). */
  context: Event[];
}

export interface FindStats {
  /** Lines read. */
  lines: number;
  malformed: number;
  /** Hits found (all of them, past any limit). */
  hits: number;
}

export const GLOB_CHARS = /[*?[]/;

const isEventId = (v: unknown): v is EventId => typeof v === "object" && v !== null && "seq" in v;

// ---------------------------------------------------------------------------------------------
// the query, compiled

export interface CompiledQuery {
  query: FindQuery;
  why: Why[];
  phrase?: (text: string) => boolean;
  /** The lowercased phrase (substring mode) or the compiled regex (`--regex`), for streaming. */
  needle?: string;
  re?: RegExp;
  file?: (path: string) => boolean;
  tool?: string;
  visible: ReadonlySet<Kind>;
  /** Calls match their results' text (results are not rows of their own). */
  foldResults: boolean;
  before: number;
  after: number;
}

/** Consecutive optional atoms (`a?a?a?…`) at or past this count are refused. */
export const OPTIONAL_RUN_LIMIT = 12;

/**
 * Whether a pattern has one of the common exponential-backtracking shapes (cli.md#find): an
 * unbounded repetition (`*`, `+`, `{n,}`) of a group that itself holds an unbounded quantifier
 * or an alternation whose branches can match overlapping text (`(a+)+`, `(a|ab)*`,
 * `(\w+\s?)*`), or a run of 12+ consecutive optional atoms (`a?a?a?…`). Bounded repetition
 * (`(\d+\.){3}`) and alternations of distinct literals (`(foo|bar)+`) pass. This is not a proof
 * of linear time: a pattern that is merely slow passes (#8).
 */
export function backtrackRisk(source: string): boolean {
  interface Frame {
    /** Holds an unbounded quantifier anywhere inside. */
    unbounded: boolean;
    /** Each finished branch's literal text, or null when it is not a plain literal. */
    branches: Array<string | null>;
    /** The current branch's literal text so far; null once it holds anything else. */
    cur: string | null;
  }
  const stack: Frame[] = [{ unbounded: false, branches: [], cur: "" }];
  const top = () => stack[stack.length - 1]!;
  let optionalRun = 0;
  let i = 0;

  const overlapping = (branches: Array<string | null>): boolean => {
    if (branches.length < 2) return false;
    if (branches.some((b) => b === null)) return true;
    const lower = (branches as string[]).map((b) => b.toLowerCase());
    for (let a = 0; a < lower.length; a++) for (let b = 0; b < lower.length; b++) if (a !== b && lower[a]!.startsWith(lower[b]!)) return true;
    return false;
  };
  /** A quantifier at `at`, if any: its length, whether it is unbounded, whether it makes the atom optional. */
  const quantifier = (at: number): { len: number; unbounded: boolean; optional: boolean } | null => {
    const c = source[at];
    let q: { len: number; unbounded: boolean; optional: boolean } | null = null;
    if (c === "*") q = { len: 1, unbounded: true, optional: false };
    else if (c === "+") q = { len: 1, unbounded: true, optional: false };
    else if (c === "?") q = { len: 1, unbounded: false, optional: true };
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
      if (m) {
        const lo = Number(m[1]);
        const hi = m[2] === undefined ? lo : m[3] === "" ? Infinity : Number(m[3]);
        q = { len: m[0].length, unbounded: hi === Infinity, optional: lo === 0 && hi === 1 };
      }
    }
    if (q && source[at + q.len] === "?") q.len++; // lazy
    return q;
  };
  /** After an atom: apply a following quantifier. Returns true when the shape is refused. */
  const afterAtom = (atom: { risky: boolean; literal?: string }): boolean => {
    const frame = top();
    const q = quantifier(i);
    if (!q) {
      optionalRun = 0;
      if (frame.cur !== null) frame.cur = atom.literal !== undefined ? frame.cur + atom.literal : null;
      return false;
    }
    i += q.len;
    frame.cur = null;
    if (q.unbounded) {
      if (atom.risky) return true;
      frame.unbounded = true;
    }
    if (q.optional) {
      if (++optionalRun >= OPTIONAL_RUN_LIMIT) return true;
    } else optionalRun = 0;
    return false;
  };

  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      const next = source[i + 1] ?? "";
      i += 2;
      // \d, \w, \p{…}, \u…, back-references: not a plain literal
      if (/[A-Za-z0-9]/.test(next)) {
        if ((next === "p" || next === "P" || next === "u") && source[i] === "{") {
          const close = source.indexOf("}", i);
          i = close === -1 ? source.length : close + 1;
        } else if (next === "k" && source[i] === "<") {
          const close = source.indexOf(">", i);
          i = close === -1 ? source.length : close + 1;
        }
        if (afterAtom({ risky: false })) return true;
      } else if (afterAtom({ risky: false, literal: next })) return true;
      continue;
    }
    if (c === "[") {
      i++;
      if (source[i] === "^") i++;
      if (source[i] === "]") i++;
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      i++;
      if (afterAtom({ risky: false })) return true;
      continue;
    }
    if (c === "(") {
      i++;
      if (source[i] === "?") {
        if (source[i + 1] === "<" && source[i + 2] !== "=" && source[i + 2] !== "!") {
          const close = source.indexOf(">", i);
          i = close === -1 ? source.length : close + 1;
        } else i += source[i + 1] === "<" ? 3 : 2;
      }
      stack.push({ unbounded: false, branches: [], cur: "" });
      optionalRun = 0;
      continue;
    }
    if (c === ")") {
      i++;
      if (stack.length === 1) {
        if (afterAtom({ risky: false })) return true;
        continue;
      }
      const frame = stack.pop()!;
      frame.branches.push(frame.cur);
      const parent = top();
      parent.unbounded ||= frame.unbounded;
      const risky = frame.unbounded || overlapping(frame.branches);
      const literal = frame.branches.length === 1 && frame.branches[0] !== null ? frame.branches[0] : undefined;
      if (afterAtom(literal !== undefined ? { risky, literal } : { risky })) return true;
      continue;
    }
    if (c === "|") {
      const frame = top();
      frame.branches.push(frame.cur);
      frame.cur = "";
      optionalRun = 0;
      i++;
      continue;
    }
    i++;
    const meta = c === "." || c === "^" || c === "$";
    if (afterAtom(meta ? { risky: false } : { risky: false, literal: c })) return true;
  }
  return false;
}

/** A glob over a whole path: `*` and `?` match `/` too; `[...]` / `[!...]` are classes. */
export function globRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      while (pattern[i + 1] === "*") i++;
      out += ".*";
    } else if (c === "?") out += ".";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, close);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      out += `[${negate ? "^" : ""}${body.replace(/[\\\]^]/g, (m) => `\\${m}`)}]`;
      i = close;
    } else out += c.replace(/[.+^${}()|\\\]]/g, (m) => `\\${m}`);
  }
  try {
    return new RegExp(`^${out}$`, "s");
  } catch {
    throw new AgentSessionError(`invalid glob ${pattern}: a [...] class is malformed (a range like z-a runs backwards)`, "VALIDATION_ERROR", [
      "a glob takes *, ? and [...] classes such as [a-z] or [!x]; without them the pattern is a substring",
    ]);
  }
}

function contextOf(c: FindQuery["context"]): { before: number; after: number } {
  if (c === undefined) return { before: 1, after: 1 };
  if (typeof c === "number") return { before: c, after: c };
  return c;
}

/** Validate and compile a query; throws `VALIDATION_ERROR` before any file is opened. */
export function compileQuery(q: FindQuery): CompiledQuery {
  const hasPhrase = q.phrase !== undefined && q.phrase !== "";
  if (!hasPhrase && q.file === undefined && q.tool === undefined && !q.kinds?.length) {
    throw new AgentSessionError("find needs at least one of a phrase, file, tool or kinds", "VALIDATION_ERROR", [
      'e.g. find(session, { phrase: "redirect" }) or { tool: "bash" }',
    ]);
  }
  const why: Why[] = [];
  const out: CompiledQuery = { query: q, why, visible: kindSet(q.kinds), foldResults: false, ...contextOf(q.context) };
  out.foldResults = !out.visible.has("result");
  if (hasPhrase) {
    why.push("phrase");
    const phrase = q.phrase!;
    if (q.regex) {
      let re: RegExp;
      try {
        re = new RegExp(phrase, "iu");
      } catch (err) {
        const reason = (err as Error).message.split(": ").pop() ?? "invalid";
        let validWithoutU = false;
        try {
          new RegExp(phrase, "i");
          validWithoutU = true;
        } catch {
          // invalid either way
        }
        throw new AgentSessionError(
          validWithoutU
            ? `invalid regular expression ${phrase} under the u flag (--regex compiles with iu): ${reason}`
            : `invalid regular expression ${phrase}: ${reason}`,
          "VALIDATION_ERROR",
          [
            validWithoutU
              ? "the u (Unicode) flag forbids escaping characters that need no escape (\\- outside a class, \\a); drop the backslash"
              : "the phrase is a JavaScript regular expression with --regex (e.g. redir\\w+); drop --regex to search it literally",
          ],
        );
      }
      if (backtrackRisk(phrase)) {
        throw new AgentSessionError(`regular expression ${phrase} has an exponential-backtracking shape`, "VALIDATION_ERROR", [
          "refused: an unbounded repetition of a group holding an unbounded quantifier or overlapping alternatives ((a+)+, (a|ab)*), or 12+ optional atoms in a row; rewrite it (e.g. (a|ab)* → [ab]*)",
        ]);
      }
      out.re = re;
      out.phrase = (text) => re.test(text);
    } else {
      const needle = phrase.toLowerCase();
      out.needle = needle;
      out.phrase = (text) => text.toLowerCase().includes(needle);
    }
  }
  if (q.file !== undefined) {
    if (q.file === "") throw new AgentSessionError("empty file pattern", "VALIDATION_ERROR", ["a substring of a path (staging) or a glob (*.env)"]);
    why.push("file");
    const pattern = q.file;
    if (GLOB_CHARS.test(pattern)) {
      const re = globRegex(pattern);
      out.file = (p) => re.test(p);
    } else out.file = (p) => p.includes(pattern);
  }
  if (q.tool !== undefined) {
    if (q.tool === "") throw new AgentSessionError("empty tool name", "VALIDATION_ERROR", ["a substring of a tool name (bash, mcp__)"]);
    why.push("tool");
    out.tool = q.tool.toLowerCase();
  }
  if (q.kinds?.length) why.push("kind");
  return out;
}

// ---------------------------------------------------------------------------------------------
// matching

/** Every string value of a tool input, depth-first, as stored. */
function stringValues(value: unknown, out: string[], depth = 0): string[] {
  if (depth > 32) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringValues(v, out, depth + 1);
  return out;
}

const carriesTool = (ev: Event) => ev.kind === "call" || ev.kind === "result";

/** Read size for streamed persisted outputs (and the longest piece a regex sees). */
export const STREAM_CHUNK = 1 << 20;

/**
 * Whether a file holds the phrase, streamed in chunks so it is never held whole (cli.md#find,
 * `--deep`). A substring (already lowercased) may span chunks: the tail of each chunk carries
 * over. A regex is tested line by line, a line longer than one chunk in chunk-sized pieces; a
 * match spanning lines is out of scope.
 */
export async function streamMatches(path: string, m: { needle: string } | { re: RegExp }, chunkSize = STREAM_CHUNK): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buf = Buffer.allocUnsafe(chunkSize);
    let carry = "";
    for (let position = 0; ; ) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, position);
      const text = bytesRead > 0 ? decoder.write(buf.subarray(0, bytesRead)) : decoder.end();
      position += bytesRead;
      const last = bytesRead === 0;
      if ("needle" in m) {
        const hay = carry + text.toLowerCase();
        if (hay.includes(m.needle)) return true;
        carry = m.needle.length > 1 ? hay.slice(-(m.needle.length - 1)) : "";
      } else {
        const lines = (carry + text).split("\n");
        carry = last ? "" : lines.pop()!;
        for (const line of lines) if (m.re.test(line)) return true;
        while (carry.length > chunkSize) {
          if (m.re.test(carry.slice(0, chunkSize))) return true;
          carry = carry.slice(chunkSize);
        }
      }
      if (last) return false;
    }
  } finally {
    await fh.close();
  }
}

async function phraseMatches(cq: CompiledQuery, ev: Event, result: Event | undefined, session: Session): Promise<boolean> {
  const test = cq.phrase!;
  if (test(ev.text)) return true;
  if (ev.kind === "call" && ev.input !== undefined) {
    if (test(JSON.stringify(ev.input) ?? "")) return true;
    if (stringValues(ev.input, []).some(test)) return true;
  }
  const output = ev.kind === "result" ? ev : ev.kind === "call" && cq.foldResults ? result : undefined;
  if (!output) return false;
  if (output !== ev && test(output.text)) return true;
  if (cq.query.deep && output.pointer) {
    const access = await pointerAccess(output.pointer, session);
    if (access.followable && (await streamMatches(access.real, cq.re ? { re: cq.re } : { needle: cq.needle! }))) return true;
  }
  return false;
}

async function matches(cq: CompiledQuery, ev: Event, result: Event | undefined, session: Session): Promise<boolean> {
  if (cq.tool !== undefined && !(carriesTool(ev) && ev.tool?.toLowerCase().includes(cq.tool))) return false;
  if (cq.file && !(carriesTool(ev) && ev.files?.some(cq.file))) return false;
  if (cq.phrase && !(await phraseMatches(cq, ev, result, session))) return false;
  return true;
}

function inRange(ev: Event, from: FindQuery["from"], to: FindQuery["to"]): boolean {
  if (from !== undefined) {
    if (isEventId(from)) {
      if (comparePosition(ev.id, from) < 0) return false;
    } else if (!ev.t || Date.parse(ev.t) < from.getTime()) return false;
  }
  if (to !== undefined) {
    if (isEventId(to)) {
      if (comparePosition(ev.id, to) >= 0) return false;
    } else if (!ev.t || Date.parse(ev.t) >= to.getTime()) return false;
  }
  return true;
}

function checkSession(session: Session, id: EventId | Date | undefined): void {
  if (isEventId(id) && id.session !== session.short) {
    throw new AgentSessionError(`${formatId(id)} is not an id of session ${session.short}`, "VALIDATION_ERROR", [
      `ids of this session start with ${session.short}:`,
    ]);
  }
}

/** How many visible events wait behind a call whose result has not been read yet. */
const HOLD_CAP = 1000;

/**
 * Visible events in file order, each with its linked result when results are folded into calls.
 * A call waits (with the events after it, keeping file order) until its result is read, at most
 * HOLD_CAP events; with an id bound `to`, the scan reads past it only to link waiting calls.
 */
async function* visibleEvents(session: Session, cq: CompiledQuery, stats: FindStats, range?: WindowRange): AsyncGenerator<{ event: Event; result?: Event }> {
  const { from, to } = cq.query;
  const start = windowStart(session, range);
  const ctx = start.ctx;
  stats.malformed += start.malformed;
  const toSeq = boundSeq(to, range);
  const queue: Array<{ event: Event; result?: Event }> = [];
  /** tool-use id → the queued call waiting for its result. */
  const byToolUse = new Map<string, { event: Event; result?: Event }>();
  const waiting = (item: { event: Event }) => {
    const ev = item.event;
    return ev.kind === "call" && ev.toolUseId !== undefined && ctx.pending.get(ev.toolUseId) === ev;
  };
  const release = () => {
    const item = queue.shift()!;
    if (item.event.toolUseId) byToolUse.delete(item.event.toolUseId);
    return item;
  };
  let pastLines = 0;
  for await (const line of readLines(session.path, { startOffset: start.offset, startSeq: start.seq })) {
    stats.lines = line.seq;
    const entry = claudeCode.parse(line);
    if (!entry) continue;
    if (entry.malformed) stats.malformed++;
    const pastBound = toSeq !== undefined && entry.seq > toSeq;
    for (const ev of claudeCode.classify(entry, ctx)) {
      if (ev.kind === "result" && cq.foldResults && ev.toolUseId) {
        const call = byToolUse.get(ev.toolUseId);
        if (call && call.event.result && comparePosition(call.event.result, ev.id) === 0) call.result = ev;
      }
      if (pastBound || !cq.visible.has(ev.kind) || !inRange(ev, from, to) || !inSpan(ev, range)) continue;
      const item: { event: Event; result?: Event } = { event: ev };
      queue.push(item);
      if (ev.kind === "call" && ev.toolUseId && cq.foldResults) byToolUse.set(ev.toolUseId, item);
    }
    // Past an id bound nothing new is queued, so the held-event cap can never trip: read on only
    // HOLD_CAP lines to link calls still waiting, then release them as they are (pending).
    const giveUp = pastBound && ++pastLines > HOLD_CAP;
    while (queue.length > 0 && (giveUp || !waiting(queue[0]!) || queue.length > HOLD_CAP)) yield release();
    if (pastBound && queue.length === 0) return;
  }
  while (queue.length > 0) yield release();
}

/**
 * The hits of a query in one session, in file order (specs/api.md#searching). Each hit carries
 * its own context; contexts of nearby hits overlap and a renderer prints each row once. `stats`,
 * when given, is filled as the scan goes (lines read, malformed lines, hits found).
 */
export async function* find(session: Session, q: FindQuery, stats?: FindStats): AsyncGenerator<Hit> {
  const cq = compileQuery(q);
  checkSession(session, q.from);
  checkSession(session, q.to);
  const st: FindStats = stats ?? { lines: 0, malformed: 0, hits: 0 };
  const limit = q.limit ?? 0;
  const recent: Event[] = [];
  const pending: Array<{ hit: Hit; need: number }> = [];
  let yielded = 0;
  const range = await resolveWindow(session, q.window, q.cache ? { cache: q.cache } : {});
  for await (const { event, result } of visibleEvents(session, cq, st, range)) {
    for (const p of pending) {
      if (p.need > 0) {
        p.hit.context.push(event);
        p.need--;
      }
    }
    while (pending.length > 0 && pending[0]!.need === 0) {
      yield pending.shift()!.hit;
      if (limit > 0 && ++yielded >= limit) return;
    }
    if (await matches(cq, event, result, session)) {
      st.hits++;
      const hit: Hit = { event, why: [...cq.why], context: [...recent] };
      if (cq.after === 0) {
        yield hit;
        if (limit > 0 && ++yielded >= limit) return;
      } else pending.push({ hit, need: cq.after });
    }
    if (cq.before > 0) {
      recent.push(event);
      if (recent.length > cq.before) recent.shift();
    }
  }
  for (const p of pending) {
    yield p.hit;
    if (limit > 0 && ++yielded >= limit) return;
  }
}

export interface FindListing {
  /** The first `limit` hits (all of them with limit 0). */
  hits: Hit[];
  /**
   * Hits past the limit that fall inside a shown hit's context: printed once, as rows, and they
   * keep their `why` (cli.md#find). A continuation starts after the last of them.
   */
  inContext: Hit[];
  /** Hits in the whole range scanned. */
  matching: number;
  lines: number;
  malformed: number;
}

/** A bounded result for a renderer: the first `limit` hits with context, and the total. */
export async function findListing(session: Session, q: FindQuery): Promise<FindListing> {
  const limit = q.limit ?? 20;
  const stats: FindStats = { lines: 0, malformed: 0, hits: 0 };
  const hits: Hit[] = [];
  const inContext: Hit[] = [];
  let shownRows: Set<string> | undefined;
  const { limit: _drop, ...rest } = q;
  for await (const hit of find(session, rest, stats)) {
    if (limit === 0 || hits.length < limit) {
      hits.push(hit);
      continue;
    }
    shownRows ??= new Set(hits.flatMap((h) => h.context.map((e) => formatId(e.id))));
    if (shownRows.has(formatId(hit.event.id))) inContext.push(hit);
  }
  return { hits, inContext, matching: stats.hits, lines: stats.lines, malformed: stats.malformed };
}
