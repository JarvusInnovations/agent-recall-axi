/**
 * Every `H`-class event, verbatim (specs/cli.md#human-session, behaviors/authority.md): the record
 * of intent. Texts are returned uncut; a budget only chooses which messages, dropping the oldest
 * (behaviors/truncation.md#caps).
 */
import { AUTHORITY, type Event, type EventId, type Session } from "./model.js";
import type { CacheOpts } from "./cache/store.js";
import { checkSession, heldEvents, inRange, inSpan } from "./hold.js";
import { boundSeq, windowStart } from "./events.js";
import { openingSummary, resolveWindow, type WindowSel } from "./windows.js";

export const DEFAULT_HUMAN_BUDGET = 12_000;
/** The opening summary is C text: printed to this many chars under a budget (truncation.md#caps). */
export const SUMMARY_CAP = 4_000;

export interface HumanOpts {
  from?: Date | EventId;
  to?: Date | EventId;
  window?: WindowSel;
  /**
   * Characters of text in total, newest messages first, the opening summary included at its capped
   * length (SUMMARY_CAP); 0 or Infinity = no budget (and no summary cap). Default 12,000.
   */
  budget?: number;
  cache?: CacheOpts;
}

export interface HumanMessages {
  /** Kept messages, oldest first, text verbatim. */
  messages: Event[];
  /** `H` events in the selection, before the budget. */
  matching: number;
  /** Older messages the budget dropped. */
  omitted: number;
  /** The exclusive `--to` that yields the omitted messages: the oldest kept message. */
  continueTo?: EventId;
  /** The `summary` (C) that opened the selected window, when it begins with one. */
  summary?: Event;
}

/**
 * Which messages a budget keeps (newest first): the newest always, whole, even past the budget
 * (H text is never cut); then older ones while the running total of text characters fits. The
 * first that does not fit ends the selection, so the omitted ones are always the oldest.
 */
export function budgetCut(all: Event[], budget: number): { kept: Event[]; omitted: number } {
  if (budget === Infinity || all.length === 0) return { kept: all, omitted: 0 };
  let used = all[all.length - 1]!.size;
  let i = all.length - 1;
  while (i > 0 && used + all[i - 1]!.size <= budget) {
    i--;
    used += all[i]!.size;
  }
  return { kept: all.slice(i), omitted: i };
}

/** specs/api.md#reading */
export async function humanMessages(session: Session, opts: HumanOpts = {}): Promise<HumanMessages> {
  checkSession(session, opts.from);
  checkSession(session, opts.to);
  const range = await resolveWindow(session, opts.window, opts.cache ? { cache: opts.cache } : {});
  const start = windowStart(session, range);
  const all: Event[] = [];
  const held = {
    ctx: start.ctx,
    offset: start.offset,
    seq: start.seq,
    keep: (ev: Event) => AUTHORITY[ev.kind] === "H" && inRange(ev, opts.from, opts.to) && inSpan(ev, range),
  } as Parameters<typeof heldEvents>[1];
  const toSeq = boundSeq(opts.to, range);
  if (toSeq !== undefined) held.toSeq = toSeq;
  for await (const ev of heldEvents(session, held)) all.push(ev);
  const summary = await openingSummary(session, range);
  const asked = opts.budget ?? DEFAULT_HUMAN_BUDGET;
  const budget = asked > 0 ? asked : Infinity;
  // The summary's printed length counts first; the newest message still always prints.
  const forMessages = budget !== Infinity && summary ? Math.max(0, budget - Math.min(summary.size, SUMMARY_CAP)) : budget;
  const { kept, omitted } = budgetCut(all, forMessages);
  const out: HumanMessages = { messages: kept, matching: all.length, omitted };
  if (omitted > 0) out.continueTo = kept[0]!.id;
  if (summary) out.summary = summary;
  return out;
}
