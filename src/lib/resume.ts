/**
 * The resume pack (specs/data-model.md#resume-pack, specs/api.md#resume-pack): one window's
 * opening summary, every `H` event, the last tool calls and the last assistant claims, sized by a
 * character budget. Built with one read of the window through the shared hold engine, so each
 * call carries the same linked status every other listing prints. Texts are never cut here.
 */
import { AgentSessionError } from "./errors.js";
import { AUTHORITY, type Event, type EventId, type Session } from "./model.js";
import type { CacheOpts } from "./cache/store.js";
import { heldEvents, inSpan, type HeldOpts } from "./hold.js";
import { boundSeq, windowStart } from "./events.js";
import { openingSummary, resolveWindow } from "./windows.js";
import { SUMMARY_CAP } from "./human.js";

export const DEFAULT_RESUME_BUDGET = 16_000;
export const DEFAULT_RESUME_TOOLS = 10;
export const DEFAULT_RESUME_CLAIMS = 3;
/** A call's target counts at most this many chars, as its row cuts it (behaviors/truncation.md#caps). */
export const TARGET_COST_CAP = 120;

export interface ResumePackOpts {
  /** A 0-based window index or `last` (the default). */
  window?: number | "last";
  /** Characters of content; a positive integer, default 16,000. */
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
  /** C: the summary that opened the window, uncut. */
  summary?: Event;
  /** H: every `H`-class event kept, verbatim, oldest first. */
  human: Event[];
  /** The last calls, linked status included, newest last. */
  tools: Event[];
  /** C: the last assistant texts, verbatim, oldest first. */
  claims: Event[];
  omitted: { human: number; continueTo?: EventId };
  budget: { used: number; limit: number };
}

/** What one event costs against the budget (data-model.md#resume-pack). */
export function packCost(ev: Event): number {
  if (ev.kind === "summary") return Math.min(ev.size, SUMMARY_CAP);
  if (ev.kind === "call") return (ev.tool ?? "").length + Math.min((ev.target ?? "").length, TARGET_COST_CAP);
  return ev.size;
}

function invalid(what: string, value: unknown, grammar: string): AgentSessionError {
  return new AgentSessionError(`resume-pack ${what} ${String(value)} is not valid`, "VALIDATION_ERROR", [grammar]);
}

const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Check the options before any file is opened; returns them with defaults applied. */
export function resumeOpts(opts: ResumePackOpts = {}): Required<Omit<ResumePackOpts, "cache">> {
  const window = opts.window ?? "last";
  if (window !== "last" && !count(window)) throw invalid("window", window, "a resume pack is one window: a 0-based window index or last");
  const budget = opts.budget ?? DEFAULT_RESUME_BUDGET;
  if (!count(budget) || budget === 0) throw invalid("budget", budget, "budget is a positive integer of characters, e.g. 16000");
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

/** specs/api.md#resume-pack */
export async function buildResumePack(session: Session, opts: ResumePackOpts = {}): Promise<ResumePack> {
  const o = resumeOpts(opts);
  const cache = opts.cache ? { cache: opts.cache } : {};
  const range = (await resolveWindow(session, o.window, cache))!;
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
  const summary = await openingSummary(session, range);

  // The budget policy: claims shrink first, then tools, then the oldest human messages; the
  // newest human message (and the capped summary) always stay.
  const sum = (list: Event[]) => list.reduce((n, ev) => n + packCost(ev), 0);
  let used = (summary ? packCost(summary) : 0) + sum(human) + sum(tools) + sum(claims);
  while (used > o.budget && claims.length > 0) used -= packCost(claims.shift()!);
  while (used > o.budget && tools.length > 0) used -= packCost(tools.shift()!);
  let dropped = 0;
  while (used > o.budget && human.length - dropped > 1) used -= packCost(human[dropped++]!);
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
  return pack;
}
