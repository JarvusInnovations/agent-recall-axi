/**
 * The only module that produces TOON (architecture.md#output): header → rows → block-form help[].
 * Rendering rules are specs/behaviors/row-format.md.
 */
import { encode } from "@toon-format/toon";
import { formatId } from "../lib/ids.js";
import type { CallStatus, Event, EventId } from "../lib/model.js";
import { formatClock, formatDay, formatMonthDayClock } from "../lib/time.js";
import { formatSize } from "./sizes.js";
import { head } from "./truncate.js";
import type { RowField } from "../reference.js";

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

/** row-format.md#text-by-kind: newline runs collapse to one space; nothing else changes. */
export function oneLine(text: string): string {
  return text.replace(/(\r?\n)+/g, " ");
}

/** A row head cut (behaviors/truncation.md): URL/id-protected, marked with `…`. */
export function headCut(text: string, n: number): { text: string; cut: boolean } {
  return head(text, n);
}

/**
 * A `call` target cut to min(head, 120): a target that is itself a path is kept whole; inside a
 * longer target (a shell command) path-like tokens are kept whole and the rest is cut.
 */
export function targetCut(ev: Event, cap: number): { text: string; cut: boolean } {
  const target = oneLine(ev.target ?? "");
  if (ev.files?.includes(ev.target ?? "")) return { text: target, cut: false };
  return head(target, cap, { paths: true });
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
      const target = ev.target !== undefined ? targetCut(ev, targetCap) : undefined;
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
  rows: Array<Record<string, string | number | boolean>>;
  cut: number;
  /** The first row whose head was cut. */
  firstCut?: EventId;
  chars: number;
}

/** An opt-in column (`--fields`, cli.md#events-session); empty when the event lacks it. */
export function fieldValue(ev: Event, field: RowField, opts: RowOpts): string | number | boolean {
  switch (field) {
    case "authority":
      return ev.authority;
    case "size":
      return ev.size;
    case "tool":
      return ev.tool ?? "";
    case "target":
      return ev.target !== undefined ? targetCut(ev, opts.head > 0 ? Math.min(opts.head, TARGET_HEAD) : 0).text : "";
    case "result":
      return ev.result ? formatId(ev.result) : "";
    case "call":
      return ev.call ? formatId(ev.call) : "";
    case "error":
      return ev.error === undefined ? "" : ev.error;
  }
}

export function renderRows(events: Event[], tz: string, opts: RowOpts & { fields?: readonly RowField[] }): RenderedRows {
  const time = timeColumn(events, tz);
  let cut = 0;
  let firstCut: EventId | undefined;
  let chars = 0;
  const rows = events.map((ev) => {
    const t = rowText(ev, opts);
    if (t.cut) {
      cut++;
      firstCut ??= ev.id;
    }
    chars += t.text.length;
    const row: Record<string, string | number | boolean> = { id: formatId(ev.id), t: time.format(ev), kind: ev.kind, text: t.text };
    for (const f of opts.fields ?? []) row[f] = fieldValue(ev, f, opts);
    return row;
  });
  const out: RenderedRows = { header: time.header, rows, cut, chars };
  if (firstCut) out.firstCut = firstCut;
  return out;
}
