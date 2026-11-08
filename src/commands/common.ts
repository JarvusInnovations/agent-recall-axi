/** Shared argument handling for the row commands. Validation happens before any file is opened. */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { AgentSessionError } from "../lib/errors.js";
import { hintName, parseId, resolveSession, sharedShorts } from "../lib/ids.js";
import { checkRewrite } from "../lib/cache/store.js";
import { isKind, KINDS, type EventId, type Kind } from "../lib/model.js";
import type { Scope } from "../lib/scope.js";
import { formatClock, formatDay, parseSpan, parseWhen, resolveZone } from "../lib/time.js";
import type { Session } from "../lib/model.js";
import { parseWindow, type WindowSel } from "../lib/windows.js";
import { getBool, getString, usageLine, type Parsed } from "../flags.js";

import { BIN } from "../invocation.js";
export { BIN };

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
  // Ids print lowercase; an uppercased one is still an id, never a time (as in resolveId).
  const id = parseId(text.toLowerCase());
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

/** The resolution scope a command's `--project`/`--all` set (cli.md#conventions). */
export function scopeOf(command: string, p: Parsed, io: Io): Scope {
  const project = getString(p, "project");
  const all = getBool(p, "all");
  if (project !== undefined && all) {
    throw new AxiError("--project and --all both set the scope; pass one", "USAGE", [usageLine(command)]);
  }
  const scope: Scope = { cwd: io.cwd, env: io.env };
  if (all) scope.project = "all";
  else if (project !== undefined) scope.project = project;
  return scope;
}

/** ` --project <p>` / ` --all` as given, for hints that must resolve in the same scope. */
export function scopeCarry(p: Parsed): string {
  if (getBool(p, "all")) return " --all";
  const project = getString(p, "project");
  return project !== undefined ? ` --project ${shellPath(project)}` : "";
}

/** A `<session>` argument, resolved per data-model.md#session-reference. */
export async function sessionFromArg(command: string, ref: string, p: Parsed, io: Io): Promise<Session> {
  return resolveSession(ref, scopeOf(command, p, io));
}

/**
 * How a hint names the session: the path when the caller gave a path (it may lie outside any
 * scope), else the `<s8>` plus the scope flags it was resolved in.
 */
export interface SessionHint {
  /** The session as hints name it, scope flags included: `<s8> --all`, `<uuid>`, or a path. */
  ref: string;
  /** What a `show <id>` hint appends so the id resolves the same way. */
  showCarry: string;
}

export async function sessionHint(command: string, ref: string, session: Session, p: Parsed, io: Io): Promise<SessionHint> {
  const looksLikePath = ref.includes("/") || ref.startsWith(".") || ref.startsWith("~") || ref.endsWith(".jsonl");
  if (looksLikePath || resolve(io.cwd, ref) === session.path) {
    const path = shellPath(session.path);
    return { ref: path, showCarry: ` --session ${path}` };
  }
  const name = hintName(session, await sharedShorts(scopeOf(command, p, io)));
  const scope = scopeCarry(p);
  return { ref: `${name}${scope}`, showCarry: name === session.short ? scope : ` --session ${name}${scope}` };
}

/**
 * Run `fn`; an error it throws carries the rewrite notice in its details, so a NOT_FOUND caused
 * by a rewrite says so (id-stability.md#append-only-is-assumed).
 */
export async function withNotice<T>(notice: string | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (notice && err instanceof AgentSessionError) {
      throw new AgentSessionError(err.message, err.code, err.suggestions, { ...(err.details ?? {}), notice });
    }
    throw err;
  }
}

/** The rewrite notice (id-stability.md#append-only-is-assumed), once per detected rewrite. */
export async function rewriteNotice(session: Session, io: Io, tz: string): Promise<string | undefined> {
  const check = await checkRewrite(session.path, { env: io.env, now: io.now });
  if (!check.rewritten || !check.since) return undefined;
  const since = new Date(check.since);
  return `session file was rewritten since ${formatDay(since, tz)} ${formatClock(since, tz)}; ids printed earlier may have moved`;
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

/** `--window` parsed before any file is opened (VALIDATION_ERROR on a bad value); undefined = all. */
export function windowFlag(p: Parsed): WindowSel | undefined {
  const text = getString(p, "window");
  if (text === undefined) return undefined;
  try {
    return parseWindow(text);
  } catch (err) {
    if (err instanceof AgentSessionError) throw new AxiError(err.message, err.code, err.suggestions);
    throw err;
  }
}

/** ` --window <w>` as given, for hints that must show the same window. */
export function windowCarry(p: Parsed): string {
  const w = getString(p, "window");
  return w !== undefined ? ` --window ${shellArg(w)}` : "";
}
