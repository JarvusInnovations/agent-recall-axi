/**
 * Turn segmentation (specs/data-model.md#turn, specs/cli.md#turns-session): a turn is a human
 * prompt (`human` / `human.slash`) and every event until the next one; the events before the
 * first prompt are turn 0. The rule `show` already prints as `turn:` (the nearest preceding
 * prompt), so both agree.
 */
import { formatId } from "./ids.js";
import type { Event, EventId, Session } from "./model.js";
import { readLines } from "./reader.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import type { CacheOpts } from "./cache/store.js";
import { checkSession, inRange, inSpan, isEventId } from "./hold.js";
import { resolveWindow, type WindowSel } from "./windows.js";
import { windowStart } from "./events.js";

export type TurnEnd = "stop" | "compaction" | "open";

export interface Turn {
  /** The opening prompt's id; for turn 0, its first event's id. */
  id: EventId;
  /** Turn 0: the events before the session's first prompt. */
  zero: boolean;
  t?: string;
  /** The opening prompt (absent for turn 0). */
  prompt?: Event;
  /** Events in the turn, every kind (hidden ones included). */
  events: number;
  calls: number;
  /** `human.queued` events that arrived during the turn. */
  queued: number;
  ended: TurnEnd;
  /** Last event time − first event time, in ms, when both carry a time. */
  duration?: number;
  /** The turn's last event. */
  last: EventId;
}

export interface TurnOpts {
  /** Select turns by their opening prompt (turn 0 by its first event): a time or a position. */
  from?: Date | EventId;
  to?: Date | EventId;
  window?: WindowSel;
  cache?: CacheOpts;
}

const opensTurn = (ev: Event) => ev.kind === "human" || ev.kind === "human.slash";
/** The kinds whose last occurrence says whether the agent had finished (data-model.md#turn). */
const WORK = new Set(["assistant", "thinking", "call", "result", "human.answer", "human.queued"]);

interface Open {
  turn: Turn;
  first?: string;
  lastT?: string;
  firstT?: string;
  lastWork?: string;
  boundary: boolean;
  /** Listed (its opening is inside the selection). */
  listed: boolean;
}

function close(o: Open, next: boolean): Turn {
  const t = o.turn;
  t.ended = o.boundary ? "compaction" : next || o.lastWork === "assistant" ? "stop" : "open";
  if (o.firstT && o.lastT) t.duration = Date.parse(o.lastT) - Date.parse(o.firstT);
  return t;
}

/**
 * Every turn whose opening lies in the selection, in file order, each counted whole (specs/api.md).
 * A window selection starts at the window's checkpoint, seeded, so it reads exactly as a cold scan.
 */
export async function* turns(session: Session, opts: TurnOpts = {}, stats?: { lines: number }): AsyncGenerator<Turn> {
  checkSession(session, opts.from);
  checkSession(session, opts.to);
  const range = await resolveWindow(session, opts.window, opts.cache ? { cache: opts.cache } : {});
  const start = windowStart(session, range);
  const ctx = start.ctx;
  const windows = start.windows;
  const selected = (ev: Event) => inRange(ev, opts.from, opts.to) && inSpan(ev, range);
  // Where no further turn can open inside the selection.
  const endSeq = Math.min(isEventId(opts.to) ? opts.to.seq : Infinity, range?.to?.seq ?? Infinity);
  // Turn 0 exists only for a read from the file start (a checkpoint's turn opened before it).
  let cur: Open | undefined;
  const fromStart = start.seq === 1;
  for await (const line of readLines(session.path, { startOffset: start.offset, startSeq: start.seq })) {
    if (stats) stats.lines = line.seq;
    const entry = claudeCode.parse(line);
    const evs = entry ? claudeCode.classify(entry, ctx) : [];
    for (const ev of evs) {
      const boundary = windows.isBoundary(ev);
      windows.place(ev);
      if (opensTurn(ev)) {
        if (cur?.listed) yield close(cur, true);
        if (ev.id.seq > endSeq) return;
        cur = { turn: { id: ev.id, zero: false, prompt: ev, events: 0, calls: 0, queued: 0, ended: "open", last: ev.id }, boundary: false, listed: selected(ev) };
        if (ev.t) cur.turn.t = ev.t;
      } else if (!cur) {
        if (!fromStart) continue; // the rest of a turn that opened before this read
        cur = { turn: { id: ev.id, zero: true, events: 0, calls: 0, queued: 0, ended: "open", last: ev.id }, boundary: false, listed: selected(ev) };
        if (ev.t) cur.turn.t = ev.t;
      }
      const o = cur;
      o.turn.events++;
      o.turn.last = ev.id;
      if (ev.kind === "call") o.turn.calls++;
      if (ev.kind === "human.queued") o.turn.queued++;
      if (boundary) o.boundary = true;
      if (WORK.has(ev.kind)) o.lastWork = ev.kind;
      if (ev.t) {
        o.firstT ??= ev.t;
        o.lastT = ev.t;
      }
    }
    if (line.seq > endSeq && !cur?.listed) return;
  }
  if (cur?.listed) yield close(cur, false);
}

/** `<s8>:<seq>[.<n>]` of a turn (its opening prompt, or turn 0's first event). */
export function turnId(t: Turn): string {
  return formatId(t.id);
}
