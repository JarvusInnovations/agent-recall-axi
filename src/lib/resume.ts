/**
 * The resume pack (specs/data-model.md#resume-pack, specs/api.md#resume-pack): one window's
 * opening summary, every `H` event, the last tool calls and the last assistant claims, sized by a
 * budget that bounds the rendered pack. Built with one read of the window through the shared hold
 * engine, so each call carries the same linked status every other listing prints. Texts are
 * never cut here; each event is charged what the renderer prints for it (output/resume-layout.ts).
 */
import { AgentSessionError } from "./errors.js";
import { AUTHORITY, type Event, type EventId, type Session } from "./model.js";
import type { CacheOpts } from "./cache/store.js";
import { tableFor } from "./cache/index.js";
import { heldEvents, inSpan, type HeldOpts } from "./hold.js";
import { boundSeq, windowStart } from "./events.js";
import { openingSummary, resolveWindow, type WindowRange } from "./windows.js";
import { LAYER_KEYS, packCost, summaryDroppedCost } from "../output/resume-layout.js";

export { packCost };

export const DEFAULT_RESUME_BUDGET = 16_000;
export const DEFAULT_RESUME_TOOLS = 10;
export const DEFAULT_RESUME_CLAIMS = 3;

export interface ResumePackOpts {
  /** A 0-based window index or `last` (the default). */
  window?: number | "last";
  /** Bytes of rendered layers; a non-negative integer, 0 = no budget; default 16,000. */
  budget?: number;
  /** How many of the window's last calls; default 10. */
  tools?: number;
  /** How many of the window's last assistant texts; default 3. */
  claims?: number;
  cache?: CacheOpts;
}

export interface ResumePack {
  session: Session;
  window: { index: number; count: number };
  /** C: the summary that opened the window, uncut (absent when the budget dropped it). */
  summary?: Event;
  /** H: every `H`-class event kept, verbatim, oldest first. */
  human: Event[];
  /** C: the last calls, each with its linked (D) result status, newest last. */
  tools: Event[];
  /** C: the last assistant texts, verbatim, oldest first. */
  claims: Event[];
  /** Dropped human messages (and where to continue), and the dropped summary's id. */
  omitted: { human: number; continueTo?: EventId; summary?: EventId };
  /** The counted cost of the printed layers, and the budget (0 = none). */
  budget: { used: number; limit: number };
  /** The session's title by the data-model precedence, uncut; absent when it has none. */
  title?: string;
}

function invalid(what: string, value: unknown, grammar: string): AgentSessionError {
  return new AgentSessionError(`resume-pack ${what} ${String(value)} is not valid`, "VALIDATION_ERROR", [grammar]);
}

const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const WINDOW_GRAMMAR = "a resume pack is one window: a 0-based window index or last";

/** Check the options before any file is opened; returns them with defaults applied. */
export function resumeOpts(opts: ResumePackOpts = {}): Required<Omit<ResumePackOpts, "cache">> {
  const window = opts.window ?? "last";
  if (window !== "last" && !count(window)) throw invalid("window", window, WINDOW_GRAMMAR);
  const budget = opts.budget ?? DEFAULT_RESUME_BUDGET;
  if (!count(budget)) throw invalid("budget", budget, "budget is a non-negative integer of bytes, e.g. 16000; 0 for no budget");
  const tools = opts.tools ?? DEFAULT_RESUME_TOOLS;
  if (!count(tools)) throw invalid("tools", tools, "tools is a non-negative integer, e.g. 10");
  const claims = opts.claims ?? DEFAULT_RESUME_CLAIMS;
  if (!count(claims)) throw invalid("claims", claims, "claims is a non-negative integer, e.g. 3");
  return { window, budget, tools, claims };
}

/** Keep the last `n` of a running list. */
function pushLast(list: Event[], ev: Event, n: number): void {
  if (n === 0) return;
  list.push(ev);
  if (list.length > n) list.shift();
}

/** The window, or VALIDATION_ERROR in resume-pack's own grammar (no `k..`, no `all`). */
async function packWindow(session: Session, sel: number | "last", cache: CacheOpts | undefined): Promise<WindowRange> {
  try {
    return (await resolveWindow(session, sel, cache ? { cache } : {}))!;
  } catch (err) {
    if (!(err instanceof AgentSessionError) || err.code !== "VALIDATION_ERROR") throw err;
    const n = (await tableFor(session, cache)).bounds.length + 1;
    const range = n === 1 ? "only window 0" : `windows 0..${n - 1}`;
    throw new AgentSessionError(err.message, "VALIDATION_ERROR", [`resume-pack --window takes a 0-based window index (0..${n - 1}) or last; this session has ${range}`]);
  }
}

/** specs/api.md#resume-pack */
export async function buildResumePack(session: Session, opts: ResumePackOpts = {}): Promise<ResumePack> {
  const o = resumeOpts(opts);
  const range = await packWindow(session, o.window, opts.cache);
  const start = windowStart(session, range);
  const human: Event[] = [];
  const tools: Event[] = [];
  const claims: Event[] = [];
  const held: HeldOpts = {
    ctx: start.ctx,
    offset: start.offset,
    seq: start.seq,
    keep: (ev) => (AUTHORITY[ev.kind] === "H" || ev.kind === "call" || ev.kind === "assistant") && inSpan(ev, range),
  };
  const toSeq = boundSeq(undefined, range);
  if (toSeq !== undefined) held.toSeq = toSeq;
  for await (const ev of heldEvents(session, held)) {
    if (ev.kind === "call") pushLast(tools, ev, o.tools);
    else if (ev.kind === "assistant") pushLast(claims, ev, o.claims);
    else human.push(ev);
  }
  let summary = await openingSummary(session, range);

  // The budget policy, one event at a time: claims, then calls, then the oldest human messages
  // but the newest, then the summary (C, so before the last H message). The newest human
  // message always stays.
  const sum = (list: Event[]) => list.reduce((n, ev) => n + packCost(ev), 0);
  let used = LAYER_KEYS + (summary ? packCost(summary) : 0) + sum(human) + sum(tools) + sum(claims);
  const over = () => o.budget > 0 && used > o.budget;
  while (over() && claims.length > 0) used -= packCost(claims.shift()!);
  while (over() && tools.length > 0) used -= packCost(tools.shift()!);
  let dropped = 0;
  while (over() && human.length - dropped > 1) used -= packCost(human[dropped++]!);
  let droppedSummary: EventId | undefined;
  if (over() && summary) {
    used += summaryDroppedCost(summary) - packCost(summary);
    droppedSummary = summary.id;
    summary = undefined;
  }
  const kept = human.slice(dropped);

  const pack: ResumePack = {
    session,
    window: { index: range.index, count: range.count },
    ...(summary ? { summary } : {}),
    human: kept,
    tools,
    claims,
    omitted: { human: dropped },
    budget: { used, limit: o.budget },
  };
  if (dropped > 0) pack.omitted.continueTo = kept[0]!.id;
  if (droppedSummary) pack.omitted.summary = droppedSummary;
  // The window read went through the offset table, which carries the stats: no further pass.
  const { sessionStats } = await import("./stats.js");
  const title = (await sessionStats(session, { cache: opts.cache ?? {} })).title;
  if (title !== undefined) pack.title = title;
  return pack;
}
