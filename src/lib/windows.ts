/**
 * Compaction windows (specs/behaviors/context-windows.md, specs/data-model.md#window): the one
 * place a `--window` selection becomes a position range, so every listing and `compactions` agree
 * on where a window begins and ends. Boundaries come from the offset table (cache/index.ts), which
 * numbers windows with the same rule as `show` (window-state.ts).
 */
import { AgentSessionError } from "./errors.js";
import { comparePosition, formatId, parseId } from "./ids.js";
import { KINDS, type Event, type EventId, type Session } from "./model.js";
import { newContext } from "./adapters/adapter.js";
import { idOf, seedContext, startFor, tableFor, type Bound, type Checkpoint, type OffsetTable } from "./cache/index.js";
import type { CacheOpts } from "./cache/store.js";
import { heldEvents, type Span } from "./hold.js";

/** `k`, `last`, `k..` (k to the end) or `all` (the default). */
export type WindowSel = number | "last" | "all" | `${number}..`;

export const WINDOW_GRAMMAR = "--window takes a 0-based window index, last, k.. (k to the end) or all";

/** The grammar with an example index inside the session's range. */
function grammarFor(count: number): string {
  const k = count - 1;
  return `--window takes a 0-based window index (0..${k}), last, k.. (${k}.. runs to the end) or all`;
}

function invalid(value: unknown): AgentSessionError {
  return new AgentSessionError(`--window ${String(value)} is not a window`, "VALIDATION_ERROR", [WINDOW_GRAMMAR]);
}

/** Parse `--window`; throws VALIDATION_ERROR (before any file is opened). */
export function parseWindow(text: string): WindowSel {
  const v = text.trim();
  if (v === "last" || v === "all") return v;
  if (/^\d+$/.test(v)) return Number(v);
  if (/^\d+\.\.$/.test(v)) return v as `${number}..`;
  throw invalid(text);
}

/** A library caller's selection, checked: an integer ≥ 0, `k..`, `last` or `all`. */
function checkSel(sel: unknown): WindowSel {
  if (sel === "last" || sel === "all") return sel;
  if (typeof sel === "number" && Number.isSafeInteger(sel) && sel >= 0) return sel;
  if (typeof sel === "string" && /^\d+\.\.$/.test(sel)) return sel as `${number}..`;
  throw invalid(sel);
}

export function formatWindow(sel: WindowSel): string {
  return String(sel);
}

/** A window selection resolved against a session's boundaries. */
export interface WindowRange extends Span {
  /** The first selected window. */
  index: number;
  /** The last selected window (`index` unless `k..`). */
  through: number;
  /** Windows in the session. */
  count: number;
  /** Where a seeded read of the range starts: the checkpoint at or before `from`. */
  start: Checkpoint;
  table: OffsetTable;
  /** Events per kind before `from` / before `to` (absent: the file start / the indexed end). */
  fromCum?: number[];
  toCum?: number[];
  /** The boundary that opened window `index` (absent for window 0). */
  opening?: Bound;
}

function startId(session: Session, b: Bound): EventId {
  const id = parseId(b.start);
  if (!id) throw new AgentSessionError(`corrupt window boundary ${b.start}`, "INTERNAL_ERROR", []);
  return { ...id, session: session.short };
}

function rangeText(count: number): string {
  return count === 1 ? "only window 0" : `windows 0..${count - 1}`;
}

/**
 * The position range of a selection (undefined for `all`), through the offset table, built when
 * absent: a window selection is a seek. Throws VALIDATION_ERROR naming the valid range for a
 * window past the last.
 */
export async function resolveWindow(session: Session, sel: WindowSel | undefined, opts: { cache?: CacheOpts; table?: OffsetTable } = {}): Promise<WindowRange | undefined> {
  if (sel === undefined) return undefined;
  sel = checkSel(sel);
  if (sel === "all") return undefined;
  const table = opts.table ?? (await tableFor(session, opts.cache));
  const count = table.bounds.length + 1;
  let index: number;
  let through: number;
  if (sel === "last") index = through = count - 1;
  else if (typeof sel === "number") index = through = sel;
  else {
    index = Number(sel.slice(0, -2));
    through = count - 1;
  }
  if (index >= count) {
    throw new AgentSessionError(`window ${index} does not exist in ${session.short}: it has ${rangeText(count)}`, "VALIDATION_ERROR", [
      `${grammarFor(count)}; this session has ${rangeText(count)}`,
    ]);
  }
  const r: WindowRange = { index, through, count, start: table.checkpoints[0]!, table };
  if (index > 0) {
    const b = table.bounds[index - 1]!;
    r.opening = b;
    r.from = startId(session, b);
    r.fromCum = b.cum;
    r.start = startFor(table, r.from.seq);
  }
  if (through < count - 1) {
    const b = table.bounds[through]!;
    r.to = startId(session, b);
    r.toCum = b.cum;
  }
  return r;
}

/** The window a position falls in, by the table's boundaries. */
export function windowOf(table: OffsetTable, id: EventId): number {
  let w = 0;
  for (const b of table.bounds) {
    const start = parseId(b.start);
    if (!start || comparePosition(id, start) < 0) break;
    w++;
  }
  return w;
}

/** One boundary as `compactions` lists it. */
export interface Boundary {
  /** The `compaction` event; for a boundary-less summary, a synthesized one (`meta.trigger: "unknown"`, the summary's id). */
  compaction: Event;
  /** The summary that opened the next window, when the file has it. */
  summary?: Event;
  /** The window this boundary opens. */
  opens: number;
  /** Events (all kinds) in the window before and after the boundary. */
  before: number;
  after: number;
}

export interface Window {
  index: number;
  /** Inclusive start position (absent: the file start). */
  from?: EventId;
  /** Exclusive end position (absent: the end of the file). */
  to?: EventId;
  /** Events of every kind in the window. */
  events: number;
  /** The compaction that opened it (absent for window 0 and a boundary-less summary). */
  compaction?: EventId;
  /** The summary that opened it, when there is one. */
  summary?: EventId;
}

const total = (cum: readonly number[]) => cum.reduce((a, b) => a + b, 0);

/** Every window of a session, in order (specs/api.md#reading). */
export async function windows(session: Session, opts: { cache?: CacheOpts } = {}): Promise<Window[]> {
  const table = await tableFor(session, opts.cache);
  return windowsOf(session, table);
}

function windowsOf(session: Session, table: OffsetTable): Window[] {
  const out: Window[] = [];
  const n = table.bounds.length;
  for (let k = 0; k <= n; k++) {
    const open = k > 0 ? table.bounds[k - 1]! : undefined;
    const close = k < n ? table.bounds[k]! : undefined;
    const w: Window = { index: k, events: total(close?.cum ?? table.tail.cum) - total(open?.cum ?? KINDS.map(() => 0)) };
    if (open) {
      w.from = startId(session, open);
      const c = idOf(open.compaction);
      if (c) w.compaction = c;
      const s = idOf(open.summary);
      if (s) w.summary = s;
    }
    if (close) w.to = startId(session, close);
    out.push(w);
  }
  return out;
}

/**
 * Read the given events (by id) through the table: each from the checkpoint at or before it,
 * seeded, so it classifies exactly as a cold scan; a compaction waits for its summary.
 */
async function eventsById(session: Session, table: OffsetTable, ids: EventId[]): Promise<Map<string, Event>> {
  const want = new Set(ids.map((i) => formatId(i)));
  const found = new Map<string, Event>();
  const sorted = [...ids].sort((a, b) => a.seq - b.seq || (a.block ?? 0) - (b.block ?? 0));
  for (const id of sorted) {
    if (found.has(formatId(id))) continue;
    const cp = startFor(table, id.seq);
    const ctx = cp.seq > 1 ? seedContext(session, cp, table) : newContext(session);
    for await (const ev of heldEvents(session, {
      ctx,
      offset: cp.offset,
      seq: cp.seq,
      keep: (ev) => want.has(formatId(ev.id)) && !found.has(formatId(ev.id)),
      // A wanted row is the answer as it stands: never read on for its partner.
      noHold: () => true,
      until: () => found.has(formatId(id)),
    })) {
      found.set(formatId(ev.id), ev);
    }
  }
  return found;
}

/** Every boundary with its compaction (or a synthesized one), summary and window sizes. */
export async function boundaries(session: Session, opts: { cache?: CacheOpts; table?: OffsetTable } = {}): Promise<Boundary[]> {
  const table = opts.table ?? (await tableFor(session, opts.cache));
  if (table.bounds.length === 0) return [];
  const ids: EventId[] = [];
  for (const b of table.bounds) {
    for (const x of [b.compaction, b.summary]) {
      const id = idOf(x);
      if (id) ids.push({ ...id, session: session.short });
    }
  }
  const byId = await eventsById(session, table, ids);
  const wins = windowsOf(session, table);
  return table.bounds.map((b, i) => {
    const summary = b.summary ? byId.get(b.summary) : undefined;
    let compaction = b.compaction ? byId.get(b.compaction) : undefined;
    if (!compaction) {
      // A boundary-less summary is the boundary itself (context-windows.md).
      const id = idOf(b.summary ?? b.start)!;
      compaction = { id, kind: "compaction", authority: "D", text: "Conversation compacted", size: 22, meta: { trigger: "unknown", summary: id, synthesized: true } };
      if (summary?.t) compaction.t = summary.t;
    }
    const out: Boundary = { compaction, opens: i + 1, before: wins[i]!.events, after: wins[i + 1]!.events };
    if (summary) out.summary = summary;
    return out;
  });
}

/** The compaction events of a session (specs/api.md#reading), with `meta` and the summary id. */
export async function compactions(session: Session, opts: { cache?: CacheOpts } = {}): Promise<Event[]> {
  return (await boundaries(session, opts)).map((b) => b.compaction);
}

/**
 * The summary that opens a selected window: the window's first event, when it is a summary
 * (context-windows.md). A summary further into the window opens nothing.
 */
export async function openingSummary(session: Session, range: WindowRange | undefined): Promise<Event | undefined> {
  if (!range) return undefined;
  const cp = range.start;
  const from = range.from;
  let first: Event | undefined;
  for await (const ev of heldEvents(session, {
    ctx: cp.seq > 1 ? seedContext(session, cp, range.table) : newContext(session),
    offset: cp.offset,
    seq: cp.seq,
    keep: (ev) => first === undefined && (!from || comparePosition(ev.id, from) >= 0),
    noHold: () => true,
    until: () => first !== undefined,
  })) {
    first = ev;
    break;
  }
  if (!first || first.kind !== "summary") return undefined;
  if (range.to && comparePosition(first.id, range.to) >= 0) return undefined;
  return first;
}
