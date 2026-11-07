/** Open and list sessions (specs/api.md#scope-and-sessions). */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentSessionError } from "./errors.js";
import type { Session } from "./model.js";
import { readLines, readLinesBackward } from "./reader.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import { resolveScope, type Scope } from "./scope.js";

export interface SessionInfo extends Session {
  /** First entry timestamp in file order. */
  started?: string;
  /** Latest entry timestamp near the end of the file; the file mtime when none is found. */
  last: string;
  bytes: number;
  mtime: string;
}

/** How far into the head / tail of a file the cheap listing looks for timestamps. */
const HEAD_SCAN_BYTES = 1 << 20;
const TAIL_SCAN_BYTES = 256 << 10;

/** A cheap prefilter: most silent lines carry no timestamp at all. */
const TS_RE = /"timestamp":"/;

/**
 * The entry's own (top-level) `timestamp`. A `"timestamp":"…"` substring can also sit inside the
 * payload (a tool input, an attachment) ahead of the entry's, so the line is parsed.
 */
function lineTimestamp(text: string): string | undefined {
  if (!TS_RE.test(text)) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  const ts = typeof obj === "object" && obj !== null ? (obj as { timestamp?: unknown }).timestamp : undefined;
  if (typeof ts !== "string") return undefined;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

async function firstTimestamp(path: string): Promise<string | undefined> {
  for await (const line of readLines(path)) {
    const t = lineTimestamp(line.text);
    if (t) return t;
    if (line.offset > HEAD_SCAN_BYTES) break;
  }
  return undefined;
}

async function lastTimestamp(path: string, size: number): Promise<string | undefined> {
  let max: string | undefined;
  for await (const line of readLinesBackward(path, 64 << 10)) {
    const t = lineTimestamp(line.text);
    if (t && (!max || t > max)) max = t;
    if (size - line.offset > TAIL_SCAN_BYTES && max) break;
    if (size - line.offset > HEAD_SCAN_BYTES * 4) break;
  }
  return max;
}

/** A session for a log file path; scope is ignored. Throws NOT_FOUND / UNREADABLE / VALIDATION_ERROR. */
export async function openSession(path: string): Promise<Session> {
  const abs = resolve(path);
  let st;
  try {
    st = await stat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") throw new AgentSessionError(`cannot read ${path}`, "UNREADABLE", [`read permission on ${abs} is needed`]);
    throw new AgentSessionError(`no session file at ${path}`, "NOT_FOUND", ["Run `agent-session-axi sessions --fields path` to list session files"]);
  }
  if (!st.isFile()) throw new AgentSessionError(`${path} is not a file`, "VALIDATION_ERROR", ["pass the path of a session .jsonl file"]);
  let ok: boolean;
  try {
    ok = await claudeCode.detect(abs);
  } catch {
    throw new AgentSessionError(`cannot read ${path}`, "UNREADABLE", [`read permission on ${abs} is needed`]);
  }
  if (!ok) throw new AgentSessionError(`${path} is not a session log`, "VALIDATION_ERROR", ["pass a Claude Code session .jsonl file"]);
  return claudeCode.sessionForPath(abs);
}

export async function describeSession(session: Session): Promise<SessionInfo> {
  const st = await stat(session.path);
  const mtime = st.mtime.toISOString();
  const info: SessionInfo = {
    ...session,
    last: (await lastTimestamp(session.path, st.size)) ?? mtime,
    bytes: st.size,
    mtime,
  };
  const started = await firstTimestamp(session.path);
  if (started) info.started = started;
  return info;
}

export interface ListOpts {
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface SessionListing {
  sessions: SessionInfo[];
  /** Sessions in scope before the time window and limit. */
  total: number;
  /** Sessions inside the time window, before the limit. */
  matching: number;
  scope: Awaited<ReturnType<typeof resolveScope>>;
}

/** Sessions in scope, most recently active first (ties by id), with the totals a listing prints. */
export async function sessionListing(scope: Scope = {}, opts: ListOpts = {}): Promise<SessionListing> {
  const resolved = await resolveScope(scope);
  const all: SessionInfo[] = [];
  for (const project of resolved.projects) {
    for await (const s of claudeCode.listSessions(project, { subagents: scope.subagents === true })) {
      all.push(await describeSession(s));
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
  return { sessions: limited, total: all.length, matching: inWindow.length, scope: resolved };
}

/** specs/api.md#scope-and-sessions: sessions in scope, most recently active first. */
export async function* listSessions(scope: Scope = {}, opts: ListOpts & { since?: Date } = {}): AsyncGenerator<SessionInfo> {
  const from = opts.from ?? opts.since;
  const listing = await sessionListing(scope, { ...opts, ...(from ? { from } : {}) });
  yield* listing.sessions;
}
