/**
 * Window numbering (specs/behaviors/context-windows.md, specs/data-model.md#window): an event's
 * window is the number of boundaries before it in file order. A `compaction` counts after itself
 * (it is the last event of the window it closes); a `summary` no compaction was waiting for (a log
 * that predates the structured boundary) is a boundary itself when at least one event precedes
 * it, and counts before itself (it opens the next window). A summary with nothing before it is
 * window 0's opening summary. The one rule the offset table, `show`, `turns` and every `--window`
 * selection share. A leaf module.
 */
import type { Event } from "./model.js";

/** A summary that no compaction was waiting for: classification links a boundary's summary to it. */
export function unlinkedSummary(ev: Event): boolean {
  return ev.kind === "summary" && !(ev.meta !== undefined && "compaction" in ev.meta);
}

/** Running window index over events in file order. */
export class WindowCounter {
  /**
   * @param index the window in effect
   * @param seen whether any event came before (a checkpoint knows from its per-kind counts)
   */
  constructor(
    public index = 0,
    public seen = false,
  ) {}

  /** Does this event open a new window (a boundary-less summary with events before it)? */
  opens(ev: Event): boolean {
    return this.seen && unlinkedSummary(ev);
  }

  /** Is this event a boundary (a compaction, or a summary that opens a window)? */
  isBoundary(ev: Event): boolean {
    return ev.kind === "compaction" || this.opens(ev);
  }

  /** The event's window; advances the count past a boundary. */
  place(ev: Event): number {
    if (this.opens(ev)) this.index++;
    const w = this.index;
    if (ev.kind === "compaction") this.index++;
    this.seen = true;
    return w;
  }
}
