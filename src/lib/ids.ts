import type { EventId } from "./model.js";

/** `<s8>:<seq>[.<n>]` (specs/data-model.md#entry-id-and-event-id). */
export function formatId(id: EventId): string {
  return id.block === undefined ? `${id.session}:${id.seq}` : `${id.session}:${id.seq}.${id.block}`;
}

const ID_RE = /^([0-9a-f]{8}):([1-9][0-9]*)(?:\.([1-9][0-9]*))?$/;

/**
 * Strict parse of the printed id form; `null` when the text is not an id. Resolution against
 * sessions (prefixes, `latest`, ambiguity) lives with the resolver, not here.
 */
export function parseId(text: string): EventId | null {
  const m = ID_RE.exec(text);
  if (!m) return null;
  const id: EventId = { session: m[1]!, seq: Number(m[2]) };
  if (m[3] !== undefined) id.block = Number(m[3]);
  return id;
}

/** Total order of event positions in one file: by seq, then block (entry form sorts first). */
export function comparePosition(a: EventId, b: EventId): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return (a.block ?? 0) - (b.block ?? 0);
}
