/**
 * The only module that produces TOON (architecture.md#output): header → rows → block-form help[].
 * Rendering rules are specs/behaviors/row-format.md.
 */
import { encode } from "@toon-format/toon";
import { formatId } from "../lib/ids.js";
import type { CallStatus, Event, EventId } from "../lib/model.js";
import { formatClock, formatDay, formatMonthDayClock } from "../lib/time.js";
import { formatSize } from "./sizes.js";

export const DEFAULT_HEAD = 200;
export const TARGET_HEAD = 120;

/** `help[N]:` in block form, one complete command per line (encode would inline primitives). */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  return `help[${lines.length}]:\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

/** Encode a structured block and append the help block. */
export function renderDocument(body: Record<string, unknown>, help: string[] = []): string {
  const parts = [encode(body)];
  const h = renderHelp(help);
  if (h) parts.push(h);
  return parts.join("\n");
}

export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** A plain head cut marked with `…` (URL/path/id protection lands with the truncation module). */
export function headCut(text: string, n: number): { text: string; cut: boolean } {
  if (n <= 0 || text.length <= n) return { text, cut: false };
  let end = n;
  const code = text.charCodeAt(end);
  if (code >= 0xdc00 && code <= 0xdfff) end--;
  return { text: `${text.slice(0, end)}…`, cut: true };
}

export function renderStatus(s: CallStatus | undefined): string {
  if (!s) return "pending";
  switch (s.state) {
    case "ok":
    case "error":
    case "persisted":
      return `${s.state} ${formatSize(s.size ?? 0)}`;
    default:
      return s.state;
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export interface RowOpts {
  /** Head length; 0 = uncapped. */
  head: number;
}

/** The `text` column by kind (row-format.md#text-by-kind). */
export function rowText(ev: Event, opts: RowOpts): { text: string; cut: boolean } {
  const head = opts.head;
  const meta = ev.meta ?? {};
  switch (ev.kind) {
    case "call": {
      const targetCap = head > 0 ? Math.min(head, TARGET_HEAD) : 0;
      const target = ev.target !== undefined ? headCut(oneLine(ev.target), targetCap) : undefined;
      const base = target ? `${ev.tool} ${target.text}` : (ev.tool ?? "?");
      return { text: `${base} → ${renderStatus(ev.status)}`, cut: target?.cut ?? false };
    }
    case "result":
      return headCut((ev.error ? "error: " : "") + oneLine(ev.text), head);
    case "compaction": {
      const parts = ["compacted"];
      if (typeof meta.trigger === "string") parts.push(meta.trigger);
      const pre = num(meta.pre_tokens);
      const post = num(meta.post_tokens);
      if (pre !== undefined && post !== undefined) parts.push(`${formatSize(pre)}→${formatSize(post)}`);
      let text = parts.join(" ");
      const summary = meta.summary as EventId | undefined;
      if (summary) text += `, summary ${formatId(summary)}`;
      return { text, cut: false };
    }
    case "hook": {
      const name = typeof meta.hook === "string" ? meta.hook : "hook";
      const exit = meta.exit !== undefined ? ` ${String(meta.exit)}` : "";
      const body = oneLine(ev.text);
      const cut = headCut(body, head);
      return { text: body ? `${name}${exit}: ${cut.text}` : `${name}${exit}`, cut: cut.cut };
    }
    default:
      return headCut(oneLine(ev.text), head);
  }
}

export interface TimeColumn {
  header: Record<string, string>;
  format: (ev: Event) => string;
}

/** `HH:MM:SS` + `day:` when every row is on one local day; else `MM-DD HH:MM:SS` + `days:`. */
export function timeColumn(rows: Event[], tz: string): TimeColumn {
  const days = new Set<string>();
  let min: string | undefined;
  let max: string | undefined;
  for (const ev of rows) {
    if (!ev.t) continue;
    const d = formatDay(new Date(ev.t), tz);
    days.add(d);
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  if (days.size <= 1) {
    return {
      header: min ? { day: min } : {},
      format: (ev) => (ev.t ? formatClock(new Date(ev.t), tz) : ""),
    };
  }
  return {
    header: { days: `${min}..${max}` },
    format: (ev) => (ev.t ? formatMonthDayClock(new Date(ev.t), tz) : ""),
  };
}

export interface RenderedRows {
  header: Record<string, string>;
  rows: Array<{ id: string; t: string; kind: string; text: string }>;
  cut: number;
  chars: number;
}

export function renderRows(events: Event[], tz: string, opts: RowOpts): RenderedRows {
  const time = timeColumn(events, tz);
  let cut = 0;
  let chars = 0;
  const rows = events.map((ev) => {
    const t = rowText(ev, opts);
    if (t.cut) cut++;
    chars += t.text.length;
    return { id: formatId(ev.id), t: time.format(ev), kind: ev.kind, text: t.text };
  });
  return { header: time.header, rows, cut, chars };
}
