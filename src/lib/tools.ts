/**
 * Tool calls with their results folded in (specs/cli.md#tools-session): `call` events from the
 * shared hold engine, so each arrives with its linked status (`ok`, `error`, `persisted`, `image`,
 * or `pending` when no result is in the file).
 */
import type { Event, EventId, Session } from "./model.js";
import type { CacheOpts } from "./cache/store.js";
import { checkSession, heldEvents, inRange, inSpan, type HeldOpts } from "./hold.js";
import { boundSeq, windowStart } from "./events.js";
import { compileQuery } from "./find.js";
import { resolveWindow, type WindowSel } from "./windows.js";

export interface ToolOpts {
  from?: Date | EventId;
  to?: Date | EventId;
  window?: WindowSel;
  /** Case-insensitive substring of the tool name. */
  name?: string;
  /** Files touched: a substring, or a glob when it has `*`, `?` or `[` (as `find --file`). */
  file?: string;
  /** Only calls whose result `is_error`. */
  errors?: boolean;
  cache?: CacheOpts;
}

export interface ToolCall {
  call: Event;
  /** The linked result (or answer) event, when `withResults` asked for it and the file has it. */
  result?: Event;
}

/** Validate the filters before any file is opened (a bad glob is VALIDATION_ERROR). */
export function toolFilter(opts: Pick<ToolOpts, "name" | "file" | "errors">): (ev: Event) => boolean {
  const name = opts.name?.toLowerCase();
  const file = opts.file !== undefined ? compileQuery({ file: opts.file }).file : undefined;
  return (ev) => {
    if (name !== undefined && !ev.tool?.toLowerCase().includes(name)) return false;
    if (file && !ev.files?.some(file)) return false;
    if (opts.errors && ev.status?.state !== "error") return false;
    return true;
  };
}

/**
 * Matching calls in file order, each once its result is read (or the read gives up on it). With
 * `withResults`, the result event rides along (`--full` prints its text).
 */
export async function* toolCallsWithResults(session: Session, opts: ToolOpts & { withResults?: boolean } = {}): AsyncGenerator<ToolCall> {
  checkSession(session, opts.from);
  checkSession(session, opts.to);
  const match = toolFilter(opts);
  const range = await resolveWindow(session, opts.window, opts.cache ? { cache: opts.cache } : {});
  const start = windowStart(session, range);
  const results = new Map<string, Event>();
  const byName = toolFilter(opts.name !== undefined ? { name: opts.name } : {});
  /** Calls kept and not yet released: only their results are worth holding. */
  const kept = new Set<string>();
  const held: HeldOpts = {
    ctx: start.ctx,
    offset: start.offset,
    seq: start.seq,
    // Name is known at the call; files and the error status only once the result links.
    keep: (ev) => {
      if (ev.kind !== "call" || !inRange(ev, opts.from, opts.to) || !inSpan(ev, range) || !byName(ev)) return false;
      if (opts.withResults) kept.add(`${ev.id.seq}.${ev.id.block ?? 0}`);
      return true;
    },
  };
  if (opts.withResults) {
    held.onLine = (_line, _entry, evs) => {
      for (const ev of evs) {
        if ((ev.kind !== "result" && ev.kind !== "human.answer") || !ev.call) continue;
        const key = `${ev.call.seq}.${ev.call.block ?? 0}`;
        if (kept.has(key)) results.set(key, ev);
      }
    };
  }
  const toSeq = boundSeq(opts.to, range);
  if (toSeq !== undefined) held.toSeq = toSeq;
  for await (const ev of heldEvents(session, held)) {
    const key = `${ev.id.seq}.${ev.id.block ?? 0}`;
    const result = results.get(key);
    results.delete(key);
    kept.delete(key);
    if (!match(ev)) continue;
    const out: ToolCall = { call: ev };
    if (result) out.result = result;
    yield out;
  }
}

/** specs/api.md#reading: the matching `call` events, results linked. */
export async function* toolCalls(session: Session, opts: ToolOpts = {}): AsyncGenerator<Event> {
  for await (const c of toolCallsWithResults(session, opts)) yield c.call;
}
