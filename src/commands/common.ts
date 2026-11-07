/** Shared argument handling for the row commands. Validation happens before any file is opened. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseId } from "../lib/ids.js";
import { isKind, KINDS, type EventId, type Kind } from "../lib/model.js";
import { openSession } from "../lib/session.js";
import { parseSpan, parseWhen, resolveZone } from "../lib/time.js";
import type { Session } from "../lib/model.js";
import { getString, usageLine, type Parsed } from "../flags.js";

export const BIN = "agent-session-axi";

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  now: Date;
}

export function zoneOf(p: Parsed, io: Io): string {
  return resolveZone(getString(p, "tz"), io.env);
}

export function parseKinds(text: string | undefined): readonly Kind[] | "all" | undefined {
  if (text === undefined) return undefined;
  if (text === "all") return "all";
  const kinds = text.split(",").map((k) => k.trim()).filter(Boolean);
  const bad = kinds.filter((k) => !isKind(k));
  if (bad.length || kinds.length === 0) {
    throw new AxiError(`unknown kind: ${bad.join(", ") || "(empty)"}`, "VALIDATION_ERROR", [`kinds: ${KINDS.join(", ")}, or all`]);
  }
  return kinds as Kind[];
}

/** `<when>` or an event id (ids first, then the time grammar). */
export function parseWhenOrId(text: string, tz: string, now: Date, endOfDay: boolean): Date | EventId {
  const id = parseId(text);
  if (id) return id;
  return parseWhen(text, { tz, now, endOfDay });
}

export interface Range {
  from?: Date | EventId;
  to?: Date | EventId;
}

export function parseRange(command: string, p: Parsed, tz: string, now: Date, allowIds: boolean): Range {
  const from = getString(p, "from");
  const to = getString(p, "to");
  const since = getString(p, "since");
  if (since !== undefined && from !== undefined) {
    throw new AxiError("--since and --from both set the start; pass one", "USAGE", [
      usageLine(command),
      "--since 7d counts back 7×24h from now; --from -7d starts at the beginning of the local day 7 days ago",
    ]);
  }
  const parse = (v: string, end: boolean) => (allowIds ? parseWhenOrId(v, tz, now, end) : parseWhen(v, { tz, now, endOfDay: end }));
  const range: Range = {};
  if (from !== undefined) range.from = parse(from, false);
  if (since !== undefined) range.from = new Date(now.getTime() - parseSpan(since));
  if (to !== undefined) range.to = parse(to, true);
  return range;
}

export function collapseHome(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A value as it should appear inside a suggested command: quoted when needed. */
export function shellArg(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A path as it should appear inside a suggested command: home-collapsed, quoted when needed. */
export function shellPath(path: string): string {
  return shellArg(collapseHome(path));
}

/**
 * A `<session>` argument. This version resolves file paths; uuids, prefixes and `latest`
 * resolve once ids-and-show lands, and say so instead of guessing.
 */
export async function sessionFromArg(ref: string, io: Io): Promise<Session> {
  const abs = resolve(io.cwd, ref.startsWith("~/") ? `${homedir()}${ref.slice(1)}` : ref);
  if (!existsSync(abs) && !ref.includes("/") && !ref.endsWith(".jsonl")) {
    throw new AxiError(`${ref} is not a session file path`, "NOT_FOUND", [
      "This version takes a session's .jsonl path; uuids, prefixes and `latest` arrive with ids-and-show",
      `Run \`${BIN} sessions --fields path\` to list session paths`,
    ]);
  }
  return openSession(abs);
}

export function carry(p: Parsed): string {
  const tz = getString(p, "tz");
  return tz ? ` --tz ${tz}` : "";
}

/** Header field and hint for session files a listing skipped because they could not be read. */
export function unreadableNote(listing: { unreadable: number; firstUnreadable?: string }): { count?: number; help?: string } {
  if (listing.unreadable === 0 || !listing.firstUnreadable) return {};
  const more = listing.unreadable > 1 ? ` (and ${listing.unreadable - 1} more were skipped)` : "";
  return {
    count: listing.unreadable,
    help: `Run \`ls -l ${shellPath(listing.firstUnreadable)}\` to check why that session file is unreadable${more}`,
  };
}
