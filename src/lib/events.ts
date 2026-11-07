/**
 * Rows of one session over visible kinds (specs/api.md#reading). File order is the order; time
 * filters select, never sort (principles.md#file-order-is-the-truth-timestamps-are-evidence).
 */
import { AgentSessionError } from "./errors.js";
import { comparePosition, formatId } from "./ids.js";
import { DEFAULT_KINDS, KINDS, type Event, type EventId, type Kind, type Session } from "./model.js";
import { countNewlines, readLines, readLinesBackward } from "./reader.js";
import { newContext } from "./adapters/adapter.js";
import { claudeCode } from "./adapters/claude-code/index.js";

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
    return tailListing(session, limit, opts.kinds);
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

/** The last `n` visible events (specs/api.md#reading). */
export async function tail(session: Session, n: number, opts: Pick<ListOpts, "kinds"> = {}): Promise<Event[]> {
  return (await listEvents(session, { kinds: opts.kinds ?? DEFAULT_KINDS, limit: n })).rows;
}
