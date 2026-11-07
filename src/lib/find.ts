/**
 * Search one session by any combination of handles (specs/cli.md#find, specs/api.md#searching).
 * A streaming scan over the classified events: hits carry why they matched and the visible rows
 * around them. Handles combine with AND; a `call` matches a phrase in its linked result's text
 * unless results are searched as rows of their own.
 */
import { AgentSessionError } from "./errors.js";
import { comparePosition, formatId } from "./ids.js";
import { kindSet, readPointer } from "./events.js";
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
  /** Window selection lands with the views plan; only `all` (or undefined) is accepted here. */
  window?: number | "last" | "all";
  /** Visible rows on each side of a hit (default 1), or each side separately. */
  context?: number | { before: number; after: number };
  /** Hits to yield; 0 or undefined = all. */
  limit?: number;
  /** Also search persisted-output files (only those the containment rule lets us follow). */
  deep?: boolean;
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
  file?: (path: string) => boolean;
  tool?: string;
  visible: ReadonlySet<Kind>;
  /** Calls match their results' text (results are not rows of their own). */
  foldResults: boolean;
  before: number;
  after: number;
}

/**
 * Whether a pattern repeats a group that holds a quantifier or an alternation (`(a+)+`,
 * `(a|ab)*`, `(\w+\s){2,}`): the shapes that make a backtracking engine run exponentially.
 * Conservative: some safe patterns (`(foo|bar)+`) are refused too, with a hint to rewrite.
 */
export function backtrackRisk(source: string): boolean {
  interface Frame {
    risky: boolean;
  }
  const stack: Frame[] = [{ risky: false }];
  /** The atom a following quantifier applies to: whether it is a group that holds a quantifier or `|`. */
  let atom: { risky: boolean } | null = null;
  let i = 0;
  const quantifier = (at: number): { len: number; repeats: boolean } | null => {
    const c = source[at];
    if (c === "*" || c === "+") return { len: 1, repeats: true };
    if (c === "?") return { len: 1, repeats: false };
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
      if (!m) return null;
      const lo = Number(m[1]);
      const hi = m[2] === undefined ? lo : m[3] === "" ? Infinity : Number(m[3]);
      return { len: m[0].length, repeats: hi >= 2 };
    }
    return null;
  };
  while (i < source.length) {
    const c = source[i]!;
    const top = stack[stack.length - 1]!;
    const q = quantifier(i);
    if (q && atom) {
      if (q.repeats && atom.risky) return true;
      top.risky = true;
      i += q.len;
      if (source[i] === "?") i++; // lazy
      atom = null;
      continue;
    }
    if (c === "\\") {
      atom = { risky: false };
      i += 2;
      continue;
    }
    if (c === "[") {
      i++;
      if (source[i] === "^") i++;
      if (source[i] === "]") i++;
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      i++;
      atom = { risky: false };
      continue;
    }
    if (c === "(") {
      stack.push({ risky: false });
      i++;
      if (source[i] === "?") {
        if (source[i + 1] === "<" && source[i + 2] !== "=" && source[i + 2] !== "!") {
          const close = source.indexOf(">", i);
          i = close === -1 ? source.length : close + 1;
        } else {
          i += source[i + 1] === "<" ? 3 : 2;
        }
      }
      atom = null;
      continue;
    }
    if (c === ")") {
      const frame = stack.length > 1 ? stack.pop()! : { risky: false };
      const parent = stack[stack.length - 1]!;
      parent.risky ||= frame.risky;
      atom = { risky: frame.risky };
      i++;
      continue;
    }
    if (c === "|") {
      top.risky = true;
      atom = null;
      i++;
      continue;
    }
    atom = { risky: false };
    i++;
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
  return new RegExp(`^${out}$`, "s");
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
  if (q.window !== undefined && q.window !== "all") {
    throw new AgentSessionError(`window ${q.window} cannot be selected yet; only all`, "USAGE", ["search every window (the default)"]);
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
        re = new RegExp(phrase, "i");
      } catch (err) {
        const reason = (err as Error).message.split(": ").pop() ?? "invalid";
        throw new AgentSessionError(`invalid regular expression ${phrase}: ${reason}`, "VALIDATION_ERROR", [
          "the phrase is a JavaScript regular expression with --regex (e.g. redir\\w+); drop --regex to search it literally",
        ]);
      }
      if (backtrackRisk(phrase)) {
        throw new AgentSessionError(`regular expression ${phrase} repeats a group that holds a quantifier or an alternation`, "VALIDATION_ERROR", [
          "patterns like (a+)+ or (a|ab)* can backtrack for hours; rewrite without repeating such a group (e.g. (a|ab)* → [ab]*)",
        ]);
      }
      out.phrase = (text) => re.test(text);
    } else {
      const needle = phrase.toLowerCase();
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
    const read = await readPointer(output.pointer, session);
    if (read.followed && test(read.text)) return true;
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
async function* visibleEvents(session: Session, cq: CompiledQuery, stats: FindStats): AsyncGenerator<{ event: Event; result?: Event }> {
  const { from, to } = cq.query;
  const ctx = newContext(session);
  const toSeq = isEventId(to) ? to.seq : undefined;
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
  for await (const line of readLines(session.path)) {
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
      if (pastBound || !cq.visible.has(ev.kind) || !inRange(ev, from, to)) continue;
      const item: { event: Event; result?: Event } = { event: ev };
      queue.push(item);
      if (ev.kind === "call" && ev.toolUseId && cq.foldResults) byToolUse.set(ev.toolUseId, item);
    }
    while (queue.length > 0 && (!waiting(queue[0]!) || queue.length > HOLD_CAP)) yield release();
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
  for await (const { event, result } of visibleEvents(session, cq, st)) {
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
  const { limit: _drop, ...rest } = q;
  for await (const hit of find(session, rest, stats)) {
    if (limit === 0 || hits.length < limit) hits.push(hit);
  }
  return { hits, matching: stats.hits, lines: stats.lines, malformed: stats.malformed };
}
