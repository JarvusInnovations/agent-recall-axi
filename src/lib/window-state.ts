/**
 * Window numbering (specs/behaviors/context-windows.md): an event's window is the number of
 * boundaries before it in file order. A `compaction` counts after itself (it is the last event of
 * the window it closes); a `summary` with no compaction waiting for it (a log that predates the
 * structured boundary) is a boundary itself and counts before itself (it opens the next window).
 * The one rule the offset table, `show` and every `--window` selection share. A leaf module.
 */
import type { Event } from "./model.js";

/** A summary that no compaction was waiting for: classification links a boundary's summary to it. */
export function opensWindow(ev: Event): boolean {
  return ev.kind === "summary" && !(ev.meta !== undefined && "compaction" in ev.meta);
}

/** Running window index over events in file order. */
export class WindowCounter {
  constructor(public index = 0) {}

  /** The event's window; advances the count past a boundary. */
  place(ev: Event): number {
    if (opensWindow(ev)) this.index++;
    const w = this.index;
    if (ev.kind === "compaction") this.index++;
    return w;
  }
}
