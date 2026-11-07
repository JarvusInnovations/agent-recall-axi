/**
 * The `<when>` / `<span>` grammar and zone-aware rendering (specs/behaviors/time-and-scope.md).
 * Every date formatting in the tool goes through here with an explicit zone.
 */
import { AgentSessionError } from "./errors.js";

export const WHEN_GRAMMAR =
  "<when> is an ISO instant (2026-04-20T14:00, optional zone), a date (2026-04-20), now, today, yesterday, ±Nd, ±Nw, ±Nh or ±Nm";
export const SPAN_GRAMMAR = "<span> is a count and a unit: 90m, 24h, 7d, 2w";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export function isValidZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `--tz`, else a valid `TZ`, else the system zone. Throws VALIDATION_ERROR for a bad `--tz`. */
export function resolveZone(flag: string | undefined, env: Record<string, string | undefined> = process.env): string {
  if (flag !== undefined) {
    if (!isValidZone(flag)) {
      throw new AgentSessionError(`unknown time zone: ${flag}`, "VALIDATION_ERROR", [
        "--tz takes an IANA zone name, e.g. --tz America/New_York or --tz UTC",
      ]);
    }
    return canonicalZone(flag);
  }
  const fromEnv = env.TZ?.replace(/^:/, "");
  if (fromEnv && isValidZone(fromEnv)) return canonicalZone(fromEnv);
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function canonicalZone(tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Offset of `tz` from UTC at `instant`, in ms (local = utc + offset). */
function zoneOffset(instant: number, tz: string): number {
  const p = localParts(new Date(instant), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads the given local time. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, second: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = guess - zoneOffset(guess, tz);
  const second2 = guess - zoneOffset(instant, tz);
  if (second2 !== instant) instant = second2;
  return new Date(instant);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatDay(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `HH:MM:SS` */
export function formatClock(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** `MM-DD HH:MM:SS` */
export function formatMonthDayClock(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** `MM-DD HH:MM` */
export function formatMonthDayMinute(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** `3m ago` style; only the sessions listing and the home view use relative times. */
export function formatAgo(date: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** `90m`, `24h`, `7d`, `2w` → milliseconds. */
export function parseSpan(text: string): number {
  const m = /^(\d+)([mhdw])$/.exec(text.trim());
  if (!m) throw new AgentSessionError(`not a span: ${text}`, "VALIDATION_ERROR", [SPAN_GRAMMAR]);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

function addLocalDays(p: LocalParts, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function startOfLocalDay(y: number, m: number, d: number, tz: string): Date {
  return zonedTime(y, m, d, 0, 0, 0, tz);
}

export interface WhenOpts {
  now?: Date;
  tz: string;
  /** Interpret a day-precision value as the start of the following day (for `--to`). */
  endOfDay?: boolean;
}

/** Parse a `<when>`; half-open range semantics come from `endOfDay` (time-and-scope.md). */
export function parseWhen(text: string, opts: WhenOpts): Date {
  const now = opts.now ?? new Date();
  const tz = opts.tz;
  const value = text.trim();
  const bump = opts.endOfDay ? 1 : 0;
  const fail = (): never => {
    throw new AgentSessionError(`not a time: ${text}`, "VALIDATION_ERROR", [WHEN_GRAMMAR]);
  };

  if (value === "now") return now;
  if (value === "today" || value === "yesterday") {
    const p = localParts(now, tz);
    const d = addLocalDays(p, (value === "yesterday" ? -1 : 0) + bump);
    return startOfLocalDay(d.year, d.month, d.day, tz);
  }
  const rel = /^([+-])(\d+)([mhdw])$/.exec(value);
  if (rel) {
    const sign = rel[1] === "-" ? -1 : 1;
    const n = Number(rel[2]) * sign;
    const unit = rel[3]!;
    if (unit === "d" || unit === "w") {
      const p = localParts(now, tz);
      const d = addLocalDays(p, n * (unit === "w" ? 7 : 1) + bump);
      return startOfLocalDay(d.year, d.month, d.day, tz);
    }
    return new Date(now.getTime() + n * UNIT_MS[unit as "m" | "h"]);
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (!validDate(y, m, d)) fail();
    const next = addLocalDays({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, bump);
    return startOfLocalDay(next.year, next.month, next.day, tz);
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (iso) {
    const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(iso[i]));
    const s = iso[6] ? Number(iso[6]) : 0;
    const ms = iso[7] ? Number(iso[7].padEnd(3, "0")) : 0;
    if (!validDate(y!, mo!, d!) || h! > 23 || mi! > 59 || s > 59) fail();
    const zone = iso[8];
    if (zone) {
      const base = Date.UTC(y!, mo! - 1, d!, h!, mi!, s, ms);
      if (zone === "Z") return new Date(base);
      const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
      const off = (Number(zm[2]) * 60 + Number(zm[3])) * 60_000 * (zm[1] === "-" ? -1 : 1);
      return new Date(base - off);
    }
    return new Date(zonedTime(y!, mo!, d!, h!, mi!, s, tz).getTime() + ms);
  }
  return fail();
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
