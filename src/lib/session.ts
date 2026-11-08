/** Open and list sessions (specs/api.md#scope-and-sessions). */
import { BIN } from "../invocation.js";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentSessionError } from "./errors.js";
import type { Session } from "./model.js";
import { sessionStats, type SessionStats } from "./stats.js";
import type { CacheOpts } from "./cache/store.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import { resolveScope, type Scope } from "./scope.js";

export interface SessionInfo extends Session, SessionStats {}

/** A session for a log file path; scope is ignored. Throws NOT_FOUND / UNREADABLE / VALIDATION_ERROR. */
export async function openSession(path: string): Promise<Session> {
  const abs = resolve(path);
  let st;
  try {
    st = await stat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") throw new AgentSessionError(`cannot read ${path}`, "UNREADABLE", [`read permission on ${abs} is needed`], { path: abs });
    throw new AgentSessionError(`no session file at ${path}`, "NOT_FOUND", [`Run \`${BIN} sessions --fields path\` to list session files`]);
  }
  if (!st.isFile()) throw new AgentSessionError(`${path} is not a file`, "VALIDATION_ERROR", ["pass the path of a session .jsonl file"]);
  let ok: boolean;
  try {
    ok = await claudeCode.detect(abs);
  } catch {
    throw new AgentSessionError(`cannot read ${path}`, "UNREADABLE", [`read permission on ${abs} is needed`], { path: abs });
  }
  if (!ok) throw new AgentSessionError(`${path} is not a session log`, "VALIDATION_ERROR", ["pass a Claude Code session .jsonl file"]);
  return claudeCode.sessionForPath(abs);
}

/** A session with its stats (data-model.md#session): one streaming pass on first touch, cached. */
export async function describeSession(session: Session, cache?: CacheOpts): Promise<SessionInfo> {
  return { ...session, ...(await sessionStats(session, { cache: cache ?? {} })) };
}

/** The cache location a listing uses: the scope's env over the process env. */
export function scopeCache(scope: Scope): CacheOpts {
  return scope.env ? { env: { ...process.env, ...scope.env } } : {};
}

export interface ListOpts {
  from?: Date;
  to?: Date;
  limit?: number;
  cache?: CacheOpts;
}

export interface SessionListing {
  sessions: SessionInfo[];
  /** Sessions in scope before the time window and limit (unreadable ones included). */
  total: number;
  /** Session files in scope that could not be read (permissions, vanished mid-listing); skipped. */
  unreadable: number;
  /** The first unreadable file, for the hint. */
  firstUnreadable?: string;
  /** Sessions inside the time window, before the limit. */
  matching: number;
  scope: Awaited<ReturnType<typeof resolveScope>>;
}

/** Sessions in scope, most recently active first (ties by id), with the totals a listing prints. */
export async function sessionListing(scope: Scope = {}, opts: ListOpts = {}): Promise<SessionListing> {
  const resolved = await resolveScope(scope);
  const all: SessionInfo[] = [];
  let unreadable = 0;
  let firstUnreadable: string | undefined;
  for (const project of resolved.projects) {
    for await (const s of claudeCode.listSessions(project, { subagents: scope.subagents === true })) {
      // One unreadable or vanished file never fails the listing: it is skipped and counted.
      try {
        all.push(await describeSession(s, opts.cache ?? scopeCache(scope)));
      } catch {
        unreadable++;
        firstUnreadable ??= s.path;
      }
    }
  }
  const inWindow = all.filter((s) => {
    const t = Date.parse(s.last);
    if (opts.from && t < opts.from.getTime()) return false;
    if (opts.to && t >= opts.to.getTime()) return false;
    return true;
  });
  inWindow.sort((a, b) => (a.last === b.last ? a.id.localeCompare(b.id) : a.last < b.last ? 1 : -1));
  const limited = opts.limit && opts.limit > 0 ? inWindow.slice(0, opts.limit) : inWindow;
  const listing: SessionListing = { sessions: limited, total: all.length + unreadable, matching: inWindow.length, unreadable, scope: resolved };
  if (firstUnreadable) listing.firstUnreadable = firstUnreadable;
  return listing;
}

/** specs/api.md#scope-and-sessions: sessions in scope, most recently active first. */
export async function* listSessions(scope: Scope = {}, opts: ListOpts & { since?: Date } = {}): AsyncGenerator<SessionInfo> {
  const from = opts.from ?? opts.since;
  const listing = await sessionListing(scope, { ...opts, ...(from ? { from } : {}) });
  yield* listing.sessions;
}
