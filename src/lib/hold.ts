/**
 * The one hold-and-release engine every forward row reader uses, and the range helpers they share
 * (architecture.md#streaming-and-memory). A leaf of the library: classification and the reader only.
 */
import { AgentSessionError } from "./errors.js";
import { comparePosition, formatId } from "./ids.js";
import { DEFAULT_KINDS, KINDS, type Entry, type Event, type EventId, type Kind, type Session } from "./model.js";
import { readLines, type Line } from "./reader.js";
import type { ClassifyContext } from "./adapters/adapter.js";
import { claudeCode } from "./adapters/claude-code/index.js";

/** A half-open position range: `from` inclusive, `to` exclusive (a window, `behaviors/context-windows.md`). */
export interface Span {
  from?: EventId;
  to?: EventId;
}

export const isEventId = (v: unknown): v is EventId => typeof v === "object" && v !== null && "seq" in v;

export function kindSet(kinds: readonly Kind[] | "all" | undefined): ReadonlySet<Kind> {
  if (kinds === "all") return new Set(KINDS);
  return new Set(kinds ?? DEFAULT_KINDS);
}

export function checkSession(session: Session, id: EventId | Date | undefined): void {
  if (isEventId(id) && id.session !== session.short) {
    throw new AgentSessionError(`${formatId(id)} is not an id of session ${session.short}`, "VALIDATION_ERROR", [
      `ids of this session start with ${session.short}:`,
    ]);
  }
}

export function inRange(ev: Event, from: Date | EventId | undefined, to: Date | EventId | undefined): boolean {
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

/** How many visible events may wait behind a held row (and, past an id bound, how many lines are read). */
export const HOLD_CAP = 1000;

/** A row still waiting for its partner: a call for its result, a compaction for its summary. */
export function waitingFor(ctx: ClassifyContext): (ev: Event) => boolean {
  return (ev) => (ev.kind === "call" && ev.toolUseId !== undefined && ctx.pending.get(ev.toolUseId) === ev) || (ev.kind === "compaction" && ctx.compaction === ev);
}

export interface HeldOpts {
  ctx: ClassifyContext;
  /** Where to start: a line start and its seq. */
  offset: number;
  seq: number;
  /** Which events are rows. */
  keep: (ev: Event) => boolean;
  /** An id bound: lines past it are read only to settle held rows, at most HOLD_CAP of them. */
  toSeq?: number;
  /** Called for every line read, after it is classified (a partial last line: entry null, no events). */
  onLine?: (line: Line, entry: Entry | null, evs: Event[]) => void;
  /** Checked after each line once nothing is held: true ends the read. */
  until?: () => boolean;
  /** Kept rows that must not wait for a partner (released as they stand). */
  noHold?: (ev: Event) => boolean;
}

/**
 * The one hold-and-release engine every forward row reader uses (architecture.md#streaming-and-memory),
 * so the same row prints the same way whichever command reached it. Rows come out in file order; a
 * call waits for its result and a compaction for its summary, with the rows after it waiting too,
 * until it is settled or more than HOLD_CAP rows wait behind it (then it is released as it stands).
 */
export async function* heldEvents(session: Session, o: HeldOpts): AsyncGenerator<Event> {
  const ctx = o.ctx;
  const partner = waitingFor(ctx);
  const waiting = o.noHold ? (ev: Event) => partner(ev) && !o.noHold!(ev) : partner;
  const queue: Event[] = [];
  let pastLines = 0;
  for await (const line of readLines(session.path, { startOffset: o.offset, startSeq: o.seq })) {
    const entry = claudeCode.parse(line);
    const evs = entry ? claudeCode.classify(entry, ctx) : [];
    o.onLine?.(line, entry, evs);
    const pastBound = o.toSeq !== undefined && line.seq > o.toSeq;
    if (!pastBound) for (const ev of evs) if (o.keep(ev)) queue.push(ev);
    // Past an id bound nothing new is queued, so the held-row cap cannot trip: read on at most
    // HOLD_CAP lines to settle the held rows, then release them as they are.
    const giveUp = pastBound && ++pastLines > HOLD_CAP;
    while (queue.length > 0 && (giveUp || !waiting(queue[0]!) || queue.length > HOLD_CAP)) yield queue.shift()!;
    if (queue.length === 0 && (pastBound || o.until?.())) return;
  }
  yield* queue;
}


/** Is the event inside a position span? */
export function inSpan(ev: Event, span: Span | undefined): boolean {
  if (!span) return true;
  if (span.from && comparePosition(ev.id, span.from) < 0) return false;
  if (span.to && comparePosition(ev.id, span.to) >= 0) return false;
  return true;
}
