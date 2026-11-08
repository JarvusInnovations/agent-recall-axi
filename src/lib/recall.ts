/**
 * `recall` (specs/cli.md#recall, specs/api.md#searching): `find` over what the human and the agent
 * said and the calls it made, across a scope, grouped by session. Uses the cache's term index
 * (architecture.md#cache) to skip the lines that cannot match and verifies the rest from their
 * checkpoints; without an index it scans, building the table, the stats and the index in the same
 * pass. Indexed and scanned answers are the same by construction: the index covers exactly the
 * texts the matcher tests.
 */
import { readFile, stat } from "node:fs/promises";
import { AgentSessionError } from "./errors.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import { comparePosition } from "./ids.js";
import { AUTHORITY, DEFAULT_KINDS, KINDS, type Event, type EventId, type Kind, type Session } from "./model.js";
import { readLines } from "./reader.js";
import { compileQuery, matchesOwnText, ownTexts, scopeSessions, type CompiledQuery } from "./find.js";
import { extendTable, loadTable, saveTable, seedContext, startFor, type OffsetTable, type PassObserver } from "./cache/index.js";
import { cacheDir, ownedRecord, recordName, termsPath, writeRecord, type CacheOpts } from "./cache/store.js";
import { statsFromTable } from "./stats.js";
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

const TERMS_VERSION = 1;
const WORD = /[\p{L}\p{N}_]+/gu;

/** Lower-cased word runs (letters, digits, `_`): the index's tokens and a phrase's. */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

interface TermsRecord {
  v: number;
  pkg: string;
  path: string;
  /** The table identity it was built with. */
  seq: number;
  end: number;
  lastHash: string;
  head?: string;
  /** [token, seqs ascending] pairs. */
  terms: Array<[string, number[]]>;
}

const sameIdentity = (r: TermsRecord, t: OffsetTable) => r.seq === t.seq && r.end === t.end && r.lastHash === t.lastHash && r.head === t.head;

async function loadTerms(path: string, cache: CacheOpts): Promise<TermsRecord | undefined> {
  try {
    const rec = termsPath(cacheDir(cache), path);
    if (!(await ownedRecord(rec))) return undefined;
    const r = JSON.parse(await readFile(rec, "utf8")) as TermsRecord;
    return r && r.v === TERMS_VERSION && r.pkg === PACKAGE_VERSION && r.path === path && Array.isArray(r.terms) ? r : undefined;
  } catch {
    return undefined;
  }
}

async function saveTerms(table: OffsetTable, terms: Map<string, number[]>, cache: CacheOpts): Promise<void> {
  const rec: TermsRecord = { v: TERMS_VERSION, pkg: PACKAGE_VERSION, path: table.path, seq: table.seq, end: table.end, lastHash: table.lastHash, terms: [...terms] };
  if (table.head !== undefined) rec.head = table.head;
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

/** One session: through its index when it covers the file, else a scan that builds it. */
async function recallSession(session: Session, cq: CompiledQuery, phrase: string[], q: { from?: Date; to?: Date }, cache: CacheOpts): Promise<{ tally: Tally; state: IndexState; last: Date }> {
  const tally: Tally = { hits: 0 };
  const useIndex = !cq.re && phrase.length > 0;
  let table = useIndex ? await loadTable(session.path, cache) : undefined;
  const rec = table ? await loadTerms(session.path, cache) : undefined;
  let state: IndexState = "none";
  if (table && rec && sameIdentity(rec, table)) {
    await verify(session, table, candidates(rec, phrase), matcher(cq, q, tally));
    const before = table.seq;
    const terms = new Map(rec.terms);
    const grown = await extendTable(session, table, undefined, both(new TermCollector(terms), matcher(cq, q, tally, before)));
    if (grown.seq !== before || grown.end !== table.end) {
      state = "partial";
      table = grown;
      await saveTable(table, cache);
      await saveTerms(table, terms, cache);
    } else state = "fresh";
  } else {
    const terms = new Map<string, number[]>();
    table = await extendTable(session, undefined, undefined, both(new TermCollector(terms), matcher(cq, q, tally)));
    await saveTable(table, cache);
    await saveTerms(table, terms, cache);
  }
  const stats = await statsFromTable(session, table, cache);
  return { tally, state, last: new Date(stats.last) };
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
      'Run `agent-session-axi find "<phrase>" --all --kind <kinds>` to search tool output and injected text',
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
