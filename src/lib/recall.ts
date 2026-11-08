/**
 * `recall` (specs/cli.md#recall, specs/api.md#searching): `find` over what the human and the agent
 * said and the calls it made, across a scope, grouped by session. Uses the cache's term index
 * (architecture.md#cache) to skip the lines that cannot match and verifies the rest from their
 * checkpoints; without an index it scans, building the table, the stats and the index in the same
 * pass. Indexed and scanned answers are the same by construction: the index covers exactly the
 * texts the matcher tests.
 */
import { BIN } from "../invocation.js";
import { readFile, stat } from "node:fs/promises";
import { AgentSessionError } from "./errors.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import { comparePosition } from "./ids.js";
import { AUTHORITY, DEFAULT_KINDS, KINDS, type Event, type EventId, type Kind, type Session } from "./model.js";
import { readLines } from "./reader.js";
import { compileQuery, matchesOwnText, ownTexts, scopeSessions, type CompiledQuery } from "./find.js";
import { extendTable, saveTable, seedContext, startFor, tableFor, tableMatches, type OffsetTable, type PassObserver } from "./cache/index.js";
import { cacheDir, ownedRecord, recordName, termsPath, writeRecord, type CacheOpts } from "./cache/store.js";
import { sessionStats, statsFromTable } from "./stats.js";
import { newContext } from "./adapters/adapter.js";
import type { ResolvedScope, Scope } from "./scope.js";
import { VERSION as PACKAGE_VERSION } from "../version.js";

/** The kinds recall searches by default: the `H` and `C` kinds of an `events` listing. */
export const RECALL_KINDS: readonly Kind[] = DEFAULT_KINDS.filter((k) => AUTHORITY[k] !== "D");
const SEARCHABLE: ReadonlySet<Kind> = new Set(KINDS.filter((k) => AUTHORITY[k] !== "D"));

export type IndexState = "fresh" | "partial" | "none";

export interface RecallOpts {
  scope?: Scope;
  since?: Date;
  from?: Date;
  to?: Date;
  regex?: boolean;
  file?: string;
  tool?: string;
  kinds?: readonly Kind[];
  /** Sessions to return; 0 = all. Default 20. */
  limit?: number;
  cache?: CacheOpts;
}

export interface RecallResult {
  session: Session;
  hits: number;
  first: EventId;
  /** The session's newest entry timestamp (its file mtime when none). */
  last: Date;
}

export interface Recall {
  sessions: RecallResult[];
  /** Sessions with hits, before the limit. */
  matching: number;
  scanned: { sessions: number; bytes: number; ms: number; index: IndexState };
  scope: ResolvedScope;
  unreadable: number;
  firstUnreadable?: string;
}

// ---------------------------------------------------------------------------------------------
// the term index (tokens → seqs; nothing else)

const TERMS_VERSION = 2;
const WORD = /[\p{L}\p{N}_]+/gu;

/** Lower-cased word runs (letters, digits, `_`): the index's tokens and a phrase's. */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** The index record: its own identity (as the table's, at the seq it reached) and the tokens. */
interface TermsRecord {
  v: number;
  pkg: string;
  path: string;
  /** Last indexed seq, the byte offset past it, the head's hash and length, the last indexed line. */
  seq: number;
  end: number;
  head?: string;
  headLength?: number;
  lastOffset: number;
  lastLength: number;
  lastHash: string;
  /** [token, seqs ascending] pairs, sorted by token: no trace of the order words were written in. */
  terms: Array<[string, number[]]>;
}

/** The record, when it parses and the file still holds the bytes it indexed (otherwise a rewrite: rebuild). */
async function loadTerms(path: string, cache: CacheOpts): Promise<TermsRecord | undefined> {
  let r: TermsRecord;
  try {
    const rec = termsPath(cacheDir(cache), path);
    if (!(await ownedRecord(rec))) return undefined;
    r = JSON.parse(await readFile(rec, "utf8")) as TermsRecord;
  } catch {
    return undefined;
  }
  if (!r || r.v !== TERMS_VERSION || r.pkg !== PACKAGE_VERSION || r.path !== path || !Array.isArray(r.terms) || typeof r.seq !== "number") return undefined;
  return (await tableMatches(r as unknown as OffsetTable, path)) ? r : undefined;
}

const byToken = (a: [string, number[]], b: [string, number[]]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Save the tokens with the identity of the table they now cover. */
async function saveTerms(table: OffsetTable, terms: Map<string, number[]>, cache: CacheOpts): Promise<void> {
  const rec: TermsRecord = {
    v: TERMS_VERSION,
    pkg: PACKAGE_VERSION,
    path: table.path,
    seq: table.seq,
    end: table.end,
    lastOffset: table.lastOffset,
    lastLength: table.lastLength,
    lastHash: table.lastHash,
    terms: [...terms].sort(byToken),
  };
  if (table.head !== undefined) rec.head = table.head;
  if (table.headLength !== undefined) rec.headLength = table.headLength;
  await writeRecord(cacheDir(cache), "terms", recordName(table.path), JSON.stringify(rec));
}

/** Collects the index's tokens from the H and C events of a pass. */
class TermCollector implements PassObserver {
  constructor(readonly terms: Map<string, number[]>) {}

  event(ev: Event): void {
    if (AUTHORITY[ev.kind] === "D") return;
    const seq = ev.id.seq;
    for (const text of ownTexts(ev)) {
      for (const tok of tokens(text)) {
        let seqs = this.terms.get(tok);
        if (!seqs) this.terms.set(tok, (seqs = []));
        if (seqs[seqs.length - 1] !== seq) seqs.push(seq);
      }
    }
  }
}

/** The seqs whose lines may hold the phrase: every phrase token inside some token of the line. */
function candidates(rec: TermsRecord, phrase: string[]): number[] {
  let acc: Set<number> | undefined;
  for (const pt of new Set(phrase)) {
    const here = new Set<number>();
    for (const [tok, seqs] of rec.terms) if (tok.includes(pt)) for (const s of seqs) if (!acc || acc.has(s)) here.add(s);
    acc = here;
    if (acc.size === 0) break;
  }
  return [...(acc ?? [])].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------
// matching

interface Tally {
  hits: number;
  first?: EventId;
}

function matcher(cq: CompiledQuery, q: { from?: Date; to?: Date }, tally: Tally, afterSeq = 0): PassObserver {
  return {
    event(ev: Event): void {
      if (ev.id.seq <= afterSeq || !cq.visible.has(ev.kind)) return;
      if (q.from && (!ev.t || Date.parse(ev.t) < q.from.getTime())) return;
      if (q.to && (!ev.t || Date.parse(ev.t) >= q.to.getTime())) return;
      if (!matchesOwnText(cq, ev)) return;
      tally.hits++;
      if (!tally.first || comparePosition(ev.id, tally.first) < 0) tally.first = ev.id;
    },
  };
}

const both = (a: PassObserver, b: PassObserver): PassObserver => ({ event: (ev, e) => (a.event(ev, e), b.event(ev, e)) });

/** Classify only the candidate lines, each from its checkpoint (the table seeds the state). */
async function verify(session: Session, table: OffsetTable, seqs: number[], observe: PassObserver): Promise<void> {
  const groups = new Map<number, { seqs: Set<number>; max: number }>();
  for (const seq of seqs) {
    const cp = startFor(table, seq);
    const g = groups.get(cp.seq) ?? { seqs: new Set<number>(), max: 0 };
    g.seqs.add(seq);
    g.max = Math.max(g.max, seq);
    groups.set(cp.seq, g);
  }
  for (const [cpSeq, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    const cp = startFor(table, cpSeq);
    const ctx = seedContext(session, cp, table);
    for await (const line of readLines(session.path, { startOffset: cp.offset, startSeq: cp.seq, endSeq: g.max + 1 })) {
      const entry = claudeCode.parse(line);
      if (!entry) continue;
      const evs = claudeCode.classify(entry, ctx);
      if (g.seqs.has(line.seq)) for (const ev of evs) observe.event(ev, entry);
    }
  }
}

/** Classify lines `from`..`to` (inclusive) from the checkpoint at or before `from`, observing only those lines. */
async function readSpan(session: Session, table: OffsetTable, from: number, to: number, observe: PassObserver): Promise<void> {
  const cp = startFor(table, from);
  const ctx = seedContext(session, cp, table);
  for await (const line of readLines(session.path, { startOffset: cp.offset, startSeq: cp.seq, endSeq: to + 1 })) {
    if (line.partial) break;
    const entry = claudeCode.parse(line);
    if (!entry) continue;
    const evs = claudeCode.classify(entry, ctx);
    if (line.seq >= from) for (const ev of evs) observe.event(ev, entry);
  }
}

/** A plain scan (a regex or a phrase the index cannot narrow): complete lines only, nothing written. */
async function scan(session: Session, observe: PassObserver): Promise<void> {
  const ctx = newContext(session);
  for await (const line of readLines(session.path)) {
    if (line.partial) break;
    const entry = claudeCode.parse(line);
    if (entry) for (const ev of claudeCode.classify(entry, ctx)) observe.event(ev, entry);
  }
}

/**
 * One session: through its index, extended from the index's own seq (another command may have
 * extended the table since), else a scan that builds the table and the index. A query the index
 * cannot narrow scans without writing anything.
 */
async function recallSession(session: Session, cq: CompiledQuery, phrase: string[], q: { from?: Date; to?: Date }, cache: CacheOpts): Promise<{ tally: Tally; state: IndexState; last: Date }> {
  const tally: Tally = { hits: 0 };
  const useIndex = !cq.re && phrase.length > 0;
  let state: IndexState = "none";
  const rec = useIndex ? await loadTerms(session.path, cache) : undefined;
  if (!useIndex) {
    await scan(session, matcher(cq, q, tally));
  } else if (rec) {
    // The table covers the file (built or extended as any seek would); the index covers up to rec.seq.
    const table = await tableFor(session, cache);
    if (rec.seq > table.seq) {
      // An index ahead of its table (the table was rebuilt shorter): rebuild both.
      return recallFresh(session, cq, q, cache, tally);
    }
    await verify(session, table, candidates(rec, phrase), matcher(cq, q, tally));
    if (table.seq > rec.seq) {
      const terms = new Map(rec.terms);
      await readSpan(session, table, rec.seq + 1, table.seq, both(new TermCollector(terms), matcher(cq, q, tally, rec.seq)));
      await saveTerms(table, terms, cache);
      state = "partial";
    } else state = "fresh";
  } else return recallFresh(session, cq, q, cache, tally);
  return { tally, state, last: new Date((await sessionStats(session, { cache })).last) };
}

/** The scan that builds the table, the stats and the index in one pass. */
async function recallFresh(session: Session, cq: CompiledQuery, q: { from?: Date; to?: Date }, cache: CacheOpts, tally: Tally): Promise<{ tally: Tally; state: IndexState; last: Date }> {
  tally.hits = 0;
  delete tally.first;
  const terms = new Map<string, number[]>();
  const table = await extendTable(session, undefined, undefined, both(new TermCollector(terms), matcher(cq, q, tally)));
  await saveTable(table, cache);
  await saveTerms(table, terms, cache);
  return { tally, state: "none", last: new Date((await statsFromTable(session, table, cache)).last) };
}

function unreadableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EISDIR";
}

/** "Have I dealt with this before?" across a scope (default every project, since 90 days). */
export async function recall(phrase: string, opts: RecallOpts = {}): Promise<Recall> {
  const t0 = Date.now();
  if (opts.since && opts.from) throw new AgentSessionError("since and from both set the start; pass one", "USAGE", ["recall(phrase, { since }) or { from }"]);
  const bad = (opts.kinds ?? []).filter((k) => !SEARCHABLE.has(k));
  if (bad.length) {
    throw new AgentSessionError(`recall searches what the human and the agent said and the calls it made; ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not among them`, "VALIDATION_ERROR", [
      `kinds recall takes: ${[...SEARCHABLE].join(", ")}`,
      `Run \`${BIN} find "<phrase>" --all --kind <kinds>\` to search tool output and injected text`,
    ]);
  }
  if (!phrase) throw new AgentSessionError("recall needs a phrase", "VALIDATION_ERROR", ['e.g. recall("redirect loop")']);
  const query = { phrase, ...(opts.regex ? { regex: true } : {}), ...(opts.file !== undefined ? { file: opts.file } : {}), ...(opts.tool !== undefined ? { tool: opts.tool } : {}), kinds: opts.kinds?.length ? opts.kinds : RECALL_KINDS };
  const cq = compileQuery(query, { fold: false });
  // An explicit --kind labels hits with `kind`; the default kind set is recall's scope, not a handle.
  if (!opts.kinds?.length) cq.why = cq.why.filter((w) => w !== "kind");
  const from = opts.since ?? opts.from;
  const window = { ...(from ? { from } : {}), ...(opts.to ? { to: opts.to } : {}) };
  const scope: Scope = { ...(opts.scope ?? {}) };
  if (scope.project === undefined) scope.project = "all";
  const cache = opts.cache ?? (scope.env ? { env: { ...process.env, ...scope.env } } : {});
  const scoped = await scopeSessions(scope, from);
  const phraseTokens = tokens(phrase);
  const results: RecallResult[] = [];
  const states = new Set<IndexState>();
  let bytes = 0;
  let read = 0;
  let unreadable = scoped.unreadable;
  let firstUnreadable = scoped.firstUnreadable;
  for (const { session, bytes: size } of scoped.sessions) {
    let r;
    try {
      r = await recallSession(session, cq, phraseTokens, window, cache);
    } catch (err) {
      if (!unreadableError(err)) throw err;
      unreadable++;
      firstUnreadable ??= session.path;
      continue;
    }
    read++;
    bytes += size;
    states.add(r.state);
    if (r.tally.hits > 0 && r.tally.first) results.push({ session, hits: r.tally.hits, first: r.tally.first, last: r.last });
  }
  results.sort((a, b) => (a.last.getTime() === b.last.getTime() ? a.session.id.localeCompare(b.session.id) : b.last.getTime() - a.last.getTime()));
  const limit = opts.limit ?? 20;
  const index: IndexState = states.size === 1 ? [...states][0]! : states.size === 0 ? "none" : "partial";
  const out: Recall = {
    sessions: limit > 0 ? results.slice(0, limit) : results,
    matching: results.length,
    scanned: { sessions: read, bytes, ms: Date.now() - t0, index },
    scope: scoped.scope,
    unreadable,
  };
  if (firstUnreadable) out.firstUnreadable = firstUnreadable;
  return out;
}
