/**
 * Rows of one session over visible kinds (specs/api.md#reading). File order is the order; time
 * filters select, never sort (principles.md#file-order-is-the-truth-timestamps-are-evidence).
 */
import { AgentSessionError } from "./errors.js";
import { comparePosition, formatId } from "./ids.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { DEFAULT_KINDS, KINDS, type Entry, type Event, type EventId, type Kind, type Pointer, type Session } from "./model.js";
import { countNewlines, readLines, readLinesBackward } from "./reader.js";
import { newContext, type ClassifyContext } from "./adapters/adapter.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import { countOf, ensureTable, extendTable, idOf, points, seedContext, startFor, type OffsetTable } from "./cache/index.js";
import type { CacheOpts } from "./cache/store.js";

export interface ListOpts {
  /** Default: every kind but `thinking` and `result`. */
  kinds?: readonly Kind[] | "all";
  /** Inclusive start: a time, or a position (an id of this session). */
  from?: Date | EventId;
  /** Exclusive end: a time, or a position. */
  to?: Date | EventId;
  /** Rows to return; 0 = unbounded. Default 40. */
  limit?: number;
  /** Default: true when no `from` is given (the newest rows, printed oldest first). */
  newestLast?: boolean;
  /** Where the derived cache lives (default: `$XDG_CACHE_HOME/agent-session-axi`). */
  cache?: CacheOpts;
}

export interface Listing {
  rows: Event[];
  /** Visible events matching the filters across the range scanned; known when the scan covered it. */
  matching?: number;
  /** The rows reach the first visible event of the file / range. */
  atStart: boolean;
  /** The rows reach the last visible event of the file / range. */
  atEnd: boolean;
  /** Lines in the file (counted). */
  lines: number;
  /** Malformed lines among those scanned. */
  malformed: number;
  /** Lines classified to produce this listing. */
  scanned: number;
}

const isEventId = (v: unknown): v is EventId => typeof v === "object" && v !== null && "seq" in v;

export function kindSet(kinds: ListOpts["kinds"]): ReadonlySet<Kind> {
  if (kinds === "all") return new Set(KINDS);
  return new Set(kinds ?? DEFAULT_KINDS);
}

function checkSession(session: Session, id: EventId | Date | undefined): void {
  if (isEventId(id) && id.session !== session.short) {
    throw new AgentSessionError(`${formatId(id)} is not an id of session ${session.short}`, "VALIDATION_ERROR", [
      `ids of this session start with ${session.short}:`,
    ]);
  }
}

function inRange(ev: Event, from: ListOpts["from"], to: ListOpts["to"]): boolean {
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

/** How many events the stream holds back behind a call still waiting for its result. */
const HOLD_CAP = 1000;

/**
 * Every visible event in file order, filtered. A call is yielded once its result has been read
 * (or the scan ends), so its `status`/`result` are already linked when a streaming consumer sees
 * it; the events after a waiting call wait with it, keeping file order. With an id bound `to`,
 * the scan continues past the bound only as far as needed to read the results of calls still
 * waiting, never yielding events beyond it. A call's status reflects the results read within that
 * scan span: one whose result never arrives (or arrives after more than 1000 held events) is
 * yielded `pending`.
 */
export async function* events(session: Session, opts: Omit<ListOpts, "limit" | "newestLast"> = {}): AsyncGenerator<Event> {
  checkSession(session, opts.from);
  checkSession(session, opts.to);
  const visible = kindSet(opts.kinds);
  const ctx = newContext(session);
  const toSeq = isEventId(opts.to) ? opts.to.seq : undefined;
  const queue: Event[] = [];
  const waiting = (ev: Event) => ev.kind === "call" && ev.toolUseId !== undefined && ctx.pending.get(ev.toolUseId) === ev;
  for await (const entry of claudeCode.entries(session)) {
    const pastBound = toSeq !== undefined && entry.seq > toSeq;
    for (const ev of claudeCode.classify(entry, ctx)) {
      if (!pastBound && visible.has(ev.kind) && inRange(ev, opts.from, opts.to)) queue.push(ev);
    }
    while (queue.length > 0 && (!waiting(queue[0]!) || queue.length > HOLD_CAP)) yield queue.shift()!;
    if (pastBound && queue.length === 0) return;
  }
  yield* queue;
}

/** A bounded listing: oldest first from `from`, or the newest `limit` rows. */
export async function listEvents(session: Session, opts: ListOpts = {}): Promise<Listing> {
  checkSession(session, opts.from);
  checkSession(session, opts.to);
  const limit = opts.limit ?? 40;
  const newestLast = opts.newestLast ?? opts.from === undefined;
  if (newestLast && opts.from === undefined && opts.to === undefined && limit > 0) {
    const listing = await tailListing(session, limit, opts.kinds);
    if (listing.matching === undefined) await exactTailCount(session, listing, opts);
    return listing;
  }
  return forwardListing(session, { ...opts, limit, newestLast });
}

async function forwardListing(session: Session, opts: ListOpts & { limit: number; newestLast: boolean }): Promise<Listing> {
  const visible = kindSet(opts.kinds);
  const ctx = newContext(session);
  let rows: Event[] = [];
  let matching = 0;
  let malformed = 0;
  let lines = 0;
  let firstMatch: Event | undefined;
  for await (const line of readLines(session.path)) {
    lines = line.seq;
    const entry = claudeCode.parse(line);
    if (!entry) continue;
    if (entry.malformed) malformed++;
    for (const ev of claudeCode.classify(entry, ctx)) {
      if (!visible.has(ev.kind) || !inRange(ev, opts.from, opts.to)) continue;
      matching++;
      firstMatch ??= ev;
      if (opts.newestLast) {
        rows.push(ev);
        if (opts.limit > 0 && rows.length > opts.limit * 2) rows = rows.slice(rows.length - opts.limit);
      } else if (opts.limit === 0 || rows.length < opts.limit) {
        rows.push(ev);
      }
    }
  }
  if (opts.newestLast && opts.limit > 0 && rows.length > opts.limit) rows = rows.slice(rows.length - opts.limit);
  return {
    rows,
    matching,
    atStart: rows.length === 0 || rows[0] === firstMatch,
    atEnd: rows.length === matching ? true : opts.newestLast,
    lines,
    malformed,
    scanned: lines,
  };
}

/**
 * The newest `n` visible rows: read backwards in blocks until enough visible events are found,
 * then re-read that span forwards so calls link to their results (architecture.md#streaming-and-memory).
 */
async function tailListing(session: Session, n: number, kinds: ListOpts["kinds"]): Promise<Listing> {
  const visible = kindSet(kinds);
  const probe = newContext(session);
  let found = 0;
  let spanStart = 0;
  let spanLines = 0;
  let reachedStart = true;
  for await (const bl of readLinesBackward(session.path)) {
    const entry = claudeCode.parse({ seq: 1, offset: bl.offset, text: bl.text, partial: bl.partial });
    let visibleHere = 0;
    if (entry) for (const ev of claudeCode.classify(entry, probe)) if (visible.has(ev.kind)) visibleHere++;
    if (found >= n) {
      // Enough rows already: whether earlier rows exist depends on the next visible event, not
      // on the silent lines (bookkeeping, hidden kinds) that usually sit before them.
      if (visibleHere > 0) {
        reachedStart = false;
        break;
      }
      continue;
    }
    spanLines++;
    spanStart = bl.offset;
    found += visibleHere;
  }
  const before = spanStart > 0 ? await countNewlines(session.path, spanStart) : 0;
  const ctx = newContext(session);
  let rows: Event[] = [];
  let malformed = 0;
  let matched = 0;
  for await (const line of readLines(session.path, { startOffset: spanStart, startSeq: before + 1 })) {
    const entry = claudeCode.parse(line);
    if (!entry) continue;
    if (entry.malformed) malformed++;
    for (const ev of claudeCode.classify(entry, ctx)) {
      if (!visible.has(ev.kind)) continue;
      matched++;
      rows.push(ev);
    }
  }
  if (rows.length > n) rows = rows.slice(rows.length - n);
  const listing: Listing = {
    rows,
    atStart: reachedStart && matched === rows.length,
    atEnd: true,
    lines: before + spanLines,
    malformed,
    scanned: spanLines,
  };
  if (reachedStart) listing.matching = matched;
  return listing;
}

/** How many appended bytes a newest-last listing will index to make its count exact. */
const TAIL_APPEND_INDEX = 8 << 20;

/**
 * A newest-last listing's `matching` from the offset table's per-kind counts, when a table
 * already exists (pan or show built it); a tail read never builds one (cli.md#tail-session).
 */
async function exactTailCount(session: Session, listing: Listing, opts: ListOpts): Promise<void> {
  const table = await ensureTable(session, { ...(opts.cache ?? {}), build: false, maxAppend: TAIL_APPEND_INDEX });
  if (!table) return;
  const last = listing.rows[listing.rows.length - 1];
  if (last && last.id.seq > table.seq) return;
  listing.matching = countOf(table.tail, kindSet(opts.kinds));
}

/** The last `n` visible events (specs/api.md#reading). */
export async function tail(session: Session, n: number, opts: Pick<ListOpts, "kinds" | "cache"> = {}): Promise<Event[]> {
  return (await listEvents(session, { ...opts, kinds: opts.kinds ?? DEFAULT_KINDS, limit: n })).rows;
}

// ---------------------------------------------------------------------------------------------
// pan: around / next / prev (specs/cli.md#around-id--next-id--prev-id)

export interface PanOpts {
  /** Default: every kind but `thinking` and `result`. Counts are over these kinds. */
  kinds?: readonly Kind[] | "all";
  cache?: CacheOpts;
}

export interface AnchorNote {
  /** Why the anchor is not shown: a silent entry, or the hidden kind of its event. */
  kind: "silent" | Kind;
  /** The nearest visible event before / after it, among those this read collected. */
  before?: EventId;
  after?: EventId;
}

export interface PanResult {
  rows: Event[];
  anchor: EventId;
  /** No visible event before the first row (before the anchor when there are no rows). */
  atStart: boolean;
  /** No visible event after the last row (after the anchor when there are no rows). */
  atEnd: boolean;
  /** Visible events of the session, of the kinds asked. */
  matching: number;
  /** Lines in the file. */
  lines: number;
  /** Malformed lines in the file. */
  malformed: number;
  /** The anchor's visible events (the whole entry for a bare id of a multi-event entry). */
  anchorRows: Event[];
  /** Set when the anchor is not a visible event. */
  anchorNote?: AnchorNote;
}

/** Where an event sits relative to the anchor: a bare entry id covers every block of its entry. */
function relation(ev: EventId, anchor: EventId): number {
  if (ev.seq !== anchor.seq) return ev.seq < anchor.seq ? -1 : 1;
  if (anchor.block === undefined) return 0;
  const b = ev.block ?? 0;
  return b === anchor.block ? 0 : b < anchor.block ? -1 : 1;
}

async function tableFor(session: Session, cache: CacheOpts | undefined, upTo?: number): Promise<OffsetTable> {
  const opts = { ...(cache ?? {}), build: true, ...(upTo !== undefined ? { upTo } : {}) };
  return (await ensureTable(session, opts)) ?? (await extendTable(session, undefined, upTo));
}

function beyondEnd(session: Session, id: EventId, lines: number): AgentSessionError {
  return new AgentSessionError(
    `${formatId(id)} is beyond the end of the session (${lines} line${lines === 1 ? "" : "s"})`,
    "NOT_FOUND",
    [`Run \`agent-session-axi tail ${session.short}\` for the last rows of this session`],
    { lines },
  );
}

/**
 * The visible events around an anchor: up to `before` before it, its own visible events when
 * `includeAnchor`, up to `after` after it (Infinity: no cap). Seeks through the offset table,
 * building or extending it, and starts at the checkpoint whose cumulative counts already cover
 * `before`, so one forward read serves both directions (architecture.md#streaming-and-memory).
 */
async function pan(session: Session, anchor: EventId, before: number, after: number, includeAnchor: boolean, opts: PanOpts): Promise<PanResult> {
  checkSession(session, anchor);
  const visible = kindSet(opts.kinds);
  const table = await tableFor(session, opts.cache);
  const pts = points(table);
  const anchorPoint = startFor(table, anchor.seq);
  let k = pts.indexOf(anchorPoint);
  if (before === Infinity) k = 0;
  else if (before > 0) {
    const atAnchor = countOf(anchorPoint, visible);
    while (k > 0 && atAnchor - countOf(pts[k]!, visible) < before) k--;
  }
  const start = pts[k]!;
  const ctx = seedContext(session, start);
  const totalIndexed = countOf(table.tail, visible);

  let visIdx = countOf(start, visible); // visible events before the line being read
  let pre: Event[] = [];
  const anchorRows: Event[] = [];
  let anchorSel: Event[] | undefined;
  const post: Event[] = [];
  let lastPostIdx = -1;
  let visBeforeAnchor: number | undefined;
  let moreAfter = false;
  let beyond = 0;
  let malformedBeyond = 0;
  let lines = start.seq - 1;
  let held = 0;
  // A row still waiting for its partner: a call for its result, a compaction for its summary.
  const waiting = (ev: Event) =>
    (ev.kind === "call" && ev.toolUseId !== undefined && ctx.pending.get(ev.toolUseId) === ev) || (ev.kind === "compaction" && ctx.compaction === ev);

  for await (const line of readLines(session.path, { startOffset: start.offset, startSeq: start.seq })) {
    lines = line.seq;
    const entry = claudeCode.parse(line);
    const evs = entry ? claudeCode.classify(entry, ctx) : [];
    if (line.seq > table.seq && entry?.malformed) malformedBeyond++;
    if (line.seq === anchor.seq) anchorSel = selectBlock(anchor, evs);
    for (const ev of evs) {
      if (!visible.has(ev.kind)) continue;
      if (line.seq > table.seq) beyond++;
      const rel = relation(ev.id, anchor);
      if (rel < 0) {
        if (before > 0) {
          pre.push(ev);
          if (before !== Infinity && pre.length > before * 2 + 64) pre = pre.slice(pre.length - before);
        }
      } else if (rel === 0) {
        visBeforeAnchor ??= visIdx;
        anchorRows.push(ev);
      } else {
        visBeforeAnchor ??= visIdx;
        if (post.length < after) {
          post.push(ev);
          lastPostIdx = visIdx;
        } else moreAfter = true;
      }
      visIdx++;
    }
    if (line.seq < anchor.seq) continue;
    visBeforeAnchor ??= visIdx;
    if (post.length < after) continue;
    const through = post.length ? lastPostIdx + 1 : visBeforeAnchor + anchorRows.length;
    const known = moreAfter || through < totalIndexed;
    if (!known) continue;
    const rows = [...(before > 0 ? pre.slice(-before) : []), ...(includeAnchor ? anchorRows : []), ...post];
    if (!rows.some(waiting)) break;
    if (++held > HOLD_CAP) break;
  }
  if (anchorSel === undefined || visBeforeAnchor === undefined) throw beyondEnd(session, anchor, Math.max(lines, table.seq));
  if (before !== Infinity && pre.length > before) pre = pre.slice(pre.length - before);
  if (before === 0) pre = [];
  const total = totalIndexed + beyond;
  const shownAnchor = includeAnchor ? anchorRows : [];
  const rows = [...pre, ...shownAnchor, ...post];
  const firstIdx = pre.length ? visBeforeAnchor - pre.length : shownAnchor.length ? visBeforeAnchor : post.length ? lastPostIdx - post.length + 1 : visBeforeAnchor;
  // Visible events up to and including the last row (the anchor when there are no rows).
  const through = post.length
    ? lastPostIdx + 1
    : shownAnchor.length || pre.length === 0
      ? visBeforeAnchor + anchorRows.length
      : visBeforeAnchor;
  const out: PanResult = {
    rows,
    anchor,
    atStart: firstIdx === 0,
    atEnd: !moreAfter && through >= total,
    matching: total,
    lines: Math.max(lines, table.seq),
    malformed: table.tail.malformed + malformedBeyond,
    anchorRows,
  };
  if (anchorRows.length === 0) {
    const note: AnchorNote = { kind: anchorSel.length ? anchorSel[0]!.kind : "silent" };
    const b = pre[pre.length - 1];
    if (b) note.before = b.id;
    if (post[0]) note.after = post[0].id;
    out.anchorNote = note;
  }
  return out;
}

/** `before` visible events, the anchor, `after` visible events (specs/api.md#reading). */
export async function around(session: Session, id: EventId, before: number, after: number, opts: PanOpts = {}): Promise<PanResult> {
  return pan(session, id, before, after, true, opts);
}

/** The `n` visible events after the anchor (exclusive); 0 = every one. */
export async function next(session: Session, id: EventId, n: number, opts: PanOpts = {}): Promise<PanResult> {
  return pan(session, id, 0, n === 0 ? Infinity : n, false, opts);
}

/** The `n` visible events before the anchor (exclusive), in file order; 0 = every one. */
export async function prev(session: Session, id: EventId, n: number, opts: PanOpts = {}): Promise<PanResult> {
  return pan(session, id, n === 0 ? Infinity : n, 0, false, opts);
}

// ---------------------------------------------------------------------------------------------
// show: one entry or event, whole (specs/cli.md#show-id-alias-zoom)

/** An event as `show` presents it, with what only a scan of its surroundings can know. */
export interface ShownEvent {
  event: Event;
  /** The `human` / `human.slash` event that opened its turn; absent before the first prompt. */
  turn?: EventId;
  /** 0-based compaction window (a compaction belongs to the window it closes). */
  window: number;
  /** `call`: the linked result event, when it is in the file. */
  linked?: Event;
  /** `compaction`: events of the entries the boundary preserved. */
  preserved?: number;
}

export interface Shown {
  session: Session;
  /** The id as asked. */
  id: EventId;
  entry: Entry;
  /** The line as stored (always available; the only content of a malformed line). */
  line: string;
  /** Every event the entry yields, in block order. */
  all: Event[];
  /** The events the id selects: one, every one for a bare id of a multi-event entry, none when silent. */
  events: ShownEvent[];
  /** The entry yields no events. */
  silent: boolean;
  /** The file's last line, not yet complete (a live file mid-append). */
  partial?: boolean;
  /** For a silent entry: the nearest events before and after (any kind). */
  before?: EventId;
  after?: EventId;
}

const opensTurn = (k: Kind) => k === "human" || k === "human.slash";

/** Where a `show` read starts: the file start, or a checkpoint with its classification state. */
interface ShowStart {
  offset: number;
  seq: number;
  ctx: ClassifyContext;
  turn?: EventId;
  window: number;
  last?: EventId;
  /** Events per entry uuid before the start; only a read from the file start knows them. */
  byUuid?: Map<string, number>;
}

/**
 * One entry by seq, classified with the context of everything before it so call/result links
 * hold. The read starts at the offset table's checkpoint at or before the entry, whose recorded
 * state (pending calls, turn, window, last event) makes it classify exactly as a scan from the
 * file start; a compaction (whose preserved count needs every earlier uuid) and a result with no
 * linked call fall back to that scan. The read continues past the entry only as far as needed:
 * to the results of its calls, the summary of its compaction, or the next event after a silent
 * entry.
 */
export async function show(session: Session, id: EventId, opts: { cache?: CacheOpts } = {}): Promise<Shown> {
  checkSession(session, id);
  const table = await tableFor(session, opts.cache, id.seq);
  const cp = startFor(table, id.seq);
  if (cp.seq > 1) {
    const start: ShowStart = { offset: cp.offset, seq: cp.seq, ctx: seedContext(session, cp), window: cp.window };
    const turn = idOf(cp.turn);
    if (turn) start.turn = turn;
    const last = idOf(cp.last);
    if (last) start.last = last;
    const seeked = await showFrom(session, id, start);
    if (seeked) return seeked;
  }
  return showFromStart(session, id);
}

/** `show` by a forward scan from the file start, without the offset table (the reference a seek must match). */
export async function showFromStart(session: Session, id: EventId): Promise<Shown> {
  checkSession(session, id);
  return (await showFrom(session, id, { offset: 0, seq: 1, ctx: newContext(session), window: 0, byUuid: new Map() }))!;
}

/** `show` from a start point; undefined when a seeked read cannot be exact (see `show`). */
async function showFrom(session: Session, id: EventId, start: ShowStart): Promise<Shown | undefined> {
  const ctx = start.ctx;
  let turn = start.turn;
  let window = start.window;
  let lastEvent = start.last;
  const eventsByUuid = start.byUuid;
  let lines = start.seq - 1;
  let found: Shown | undefined;
  /** Calls of the shown entry still waiting for a result, by tool-use id. */
  const waiting = new Map<string, ShownEvent>();
  let compactionWaiting: Event | undefined;
  let needAfter = false;

  for await (const line of readLines(session.path, { startOffset: start.offset, startSeq: start.seq })) {
    lines = line.seq;
    const parsed = claudeCode.parse(line);
    // null: a trailing line still being written; shown raw, never classified.
    const entry: Entry = parsed ?? { seq: line.seq, offset: line.offset };
    const evs = claudeCode.classify(entry, ctx);
    if (!found) {
      if (line.seq < id.seq) {
        for (const ev of evs) {
          if (opensTurn(ev.kind)) turn = ev.id;
          if (ev.kind === "compaction") window++;
          lastEvent = ev.id;
        }
        if (eventsByUuid && entry.uuid && evs.length) eventsByUuid.set(entry.uuid, evs.length);
        continue;
      }
      // line.seq === id.seq: the entry asked for.
      if (!eventsByUuid && evs.some((ev) => ev.kind === "compaction" || ((ev.kind === "result" || ev.kind === "human.answer") && ev.toolUseId && !ev.call))) {
        return undefined;
      }
      const shownAll: ShownEvent[] = evs.map((ev) => {
        const s: ShownEvent = { event: ev, window };
        const t = opensTurn(ev.kind) ? ev.id : turn;
        if (t) s.turn = t;
        if (opensTurn(ev.kind)) turn = ev.id;
        if (ev.kind === "compaction") {
          const uuids = Array.isArray(ev.meta?.preserved) ? (ev.meta!.preserved as string[]) : [];
          s.preserved = uuids.reduce((n, u) => n + (eventsByUuid?.get(u) ?? 0), 0);
        }
        return s;
      });
      const selected = selectEvents(id, evs, shownAll);
      found = { session, id, entry, line: line.text, all: evs, events: selected, silent: evs.length === 0 };
      if (!parsed) found.partial = true;
      if (found.silent) {
        if (lastEvent) found.before = lastEvent;
        needAfter = true;
      }
      for (const s of selected) {
        const ev = s.event;
        if (ev.kind === "call" && ev.toolUseId && ctx.pending.get(ev.toolUseId) === ev) waiting.set(ev.toolUseId, s);
        if (ev.kind === "compaction" && ctx.compaction === ev) compactionWaiting = ev;
      }
      // Results inside the same entry (rare) are already linked by classify.
      for (const s of selected) linkWithin(s, evs);
      if (waiting.size === 0 && !compactionWaiting && !needAfter) break;
      continue;
    }
    // Past the entry: only what the shown events still need.
    for (const ev of evs) {
      if ((ev.kind === "result" || ev.kind === "human.answer") && ev.toolUseId && waiting.has(ev.toolUseId)) {
        waiting.get(ev.toolUseId)!.linked = ev;
        waiting.delete(ev.toolUseId);
      }
      if (needAfter) {
        found.after = ev.id;
        needAfter = false;
      }
    }
    if (compactionWaiting && ctx.compaction !== compactionWaiting) compactionWaiting = undefined;
    if (waiting.size === 0 && !compactionWaiting && !needAfter) break;
  }
  if (!found) throw beyondEnd(session, id, lines);
  return found;
}

function linkWithin(s: ShownEvent, evs: Event[]): void {
  const ev = s.event;
  if (ev.kind !== "call" || !ev.result) return;
  const r = evs.find((x) => comparePosition(x.id, ev.result!) === 0);
  if (r) s.linked = r;
}

function selectEvents(id: EventId, evs: Event[], shown: ShownEvent[]): ShownEvent[] {
  if (id.block === undefined) return shown;
  const hit = selectBlock(id, evs)[0]!;
  return [shown[evs.indexOf(hit)]!];
}

/** The events an id selects in its entry's events: all for a bare id, else that block (NOT_FOUND otherwise). */
function selectBlock(id: EventId, evs: Event[]): Event[] {
  if (id.block === undefined) return evs;
  const entryId = formatId({ session: id.session, seq: id.seq });
  if (evs.length === 0) {
    throw new AgentSessionError(`${formatId(id)} does not exist: ${entryId} yields no events`, "NOT_FOUND", [
      `Run \`agent-session-axi show ${entryId}\` for the entry itself`,
    ]);
  }
  const hit = evs.find((e) => e.id.block === id.block);
  if (hit) return [hit];
  const ids = evs.map((e) => formatId(e.id));
  const what = evs.length === 1 ? `${entryId} is a single event; its id is ${ids[0]}` : `the blocks of ${entryId} are ${ids.join(", ")}`;
  throw new AgentSessionError(`${formatId(id)} does not exist: ${what}`, "NOT_FOUND", ids.map((i) => `Run \`agent-session-axi show ${i}\``));
}

export type PointerAccess = { followable: true; real: string } | { followable: false; reason: string };

/**
 * Whether a pointer may be followed (data-model.md#pointer, privacy.md): its real path, after
 * relocation and symlink resolution, must be a regular file inside `<sidecar>/tool-results/`.
 * A path named in a log is data, never an instruction to read that file.
 */
export async function pointerAccess(pointer: Pointer, session: Session): Promise<PointerAccess> {
  let dir: string;
  let real: string;
  try {
    dir = await realpath(join(session.sidecar, "tool-results"));
  } catch {
    return { followable: false, reason: "the session has no tool-results directory" };
  }
  try {
    real = await realpath(pointer.path);
  } catch {
    return { followable: false, reason: "the file is missing" };
  }
  if (!real.startsWith(`${dir}${sep}`)) return { followable: false, reason: "outside this session's tool-results directory" };
  try {
    if (!(await stat(real)).isFile()) return { followable: false, reason: "not a regular file" };
  } catch {
    return { followable: false, reason: "the file is missing" };
  }
  return { followable: true, real };
}

/**
 * The full text of a persisted output when it may be followed; otherwise the preview, with
 * `followed: false` and the reason (a missing file is `exists: false`, never an error).
 */
export async function readPointer(
  pointer: Pointer,
  session: Session,
): Promise<{ text: string; exists: boolean; followed: boolean; reason?: string }> {
  const access = await pointerAccess(pointer, session);
  if (!access.followable) {
    const missing = access.reason === "the file is missing";
    return { text: pointer.preview, exists: missing ? false : pointer.exists, followed: false, reason: access.reason };
  }
  try {
    return { text: await readFile(access.real, "utf8"), exists: true, followed: true };
  } catch {
    return { text: pointer.preview, exists: false, followed: false, reason: "the file is missing" };
  }
}

/**
 * The partner of a linked event (specs/api.md#reading): a call's result, or a result's (or
 * answer's) call; undefined when there is none in the file (a pending call, an unlinked result).
 */
export async function linkedResult(session: Session, event: Event, opts: { cache?: CacheOpts } = {}): Promise<Event | undefined> {
  if (event.kind === "call") return (await show(session, event.id, opts)).events[0]?.linked;
  if (event.call) return (await show(session, event.call, opts)).events[0]?.event;
  return undefined;
}
