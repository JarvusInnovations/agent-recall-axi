/**
 * The id grammar end to end (specs/data-model.md#identifiers, specs/behaviors/id-stability.md):
 * parse and format entry/event ids, and resolve session references (path, uuid, agentId, an
 * 8+ hex prefix, `latest`) and ids against a scope.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSessionError } from "./errors.js";
import type { EventId, Session } from "./model.js";
import { resolveScope, type ResolvedScope, type Scope } from "./scope.js";
import { openSession } from "./session.js";
import { claudeCode } from "./adapters/claude-code/index.js";

const BIN = "agent-session-axi";

/** `<s8>:<seq>[.<n>]` (specs/data-model.md#entry-id-and-event-id). */
export function formatId(id: EventId): string {
  return id.block === undefined ? `${id.session}:${id.seq}` : `${id.session}:${id.seq}.${id.block}`;
}

const ID_RE = /^([0-9a-f]{8}):([1-9][0-9]*)(?:\.([1-9][0-9]*))?$/;
const SEQ_RE = /^([1-9][0-9]*)(?:\.([1-9][0-9]*))?$/;

export const ID_GRAMMAR = "an id is <s8>:<seq>[.<n>]: 8 hex characters, a 1-based line number, an optional 1-based block (7a2f1c3e:418, 7a2f1c3e:418.2)";
export const SESSION_GRAMMAR = "<session> is a log file path, a session uuid or agentId, a hex prefix of at least 8 characters, or latest";

/**
 * Strict parse of the printed id form; `null` when the text is not an id. Resolution against
 * sessions (prefixes, `latest`, ambiguity) lives in `resolveSession` / `resolveId`.
 */
export function parseId(text: string): EventId | null {
  const m = ID_RE.exec(text);
  if (!m) return null;
  const id: EventId = { session: m[1]!, seq: Number(m[2]) };
  if (m[3] !== undefined) id.block = Number(m[3]);
  return id;
}

/** A bare `<seq>[.<n>]` (accepted only where the session is already named). */
export function parseBareSeq(text: string): { seq: number; block?: number } | null {
  const m = SEQ_RE.exec(text);
  if (!m) return null;
  const out: { seq: number; block?: number } = { seq: Number(m[1]) };
  if (m[2] !== undefined) out.block = Number(m[2]);
  return out;
}

/** Total order of event positions in one file: by seq, then block (entry form sorts first). */
export function comparePosition(a: EventId, b: EventId): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return (a.block ?? 0) - (b.block ?? 0);
}

// ---------------------------------------------------------------------------------------------
// session references

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/** Text that can only be meant as a path (it is not a uuid, prefix or `latest`). */
function looksLikePath(ref: string): boolean {
  return ref.includes("/") || ref.startsWith(".") || ref.startsWith("~") || ref.endsWith(".jsonl");
}

/** Only an existing regular file counts as a path (a directory named `latest` is not one). */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A session the resolver picked by id must be readable: UNREADABLE with its path, not a crash later. */
async function readable(s: Session): Promise<Session> {
  try {
    await access(s.path, constants.R_OK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentSessionError(`session ${s.short} vanished: ${s.path}`, "NOT_FOUND", [`Run \`${BIN} sessions\` to list the sessions in scope`]);
    }
    throw new AgentSessionError(`cannot read session ${s.short}`, "UNREADABLE", [`read permission on ${s.path} is needed`], { path: s.path });
  }
  return s;
}

/** Every session in scope, subagents included (they are always in scope for resolution). */
async function sessionsIn(resolved: ResolvedScope): Promise<Session[]> {
  const out: Session[] = [];
  for (const project of resolved.projects) {
    for await (const s of claudeCode.listSessions(project, { subagents: true })) out.push(s);
  }
  return out;
}

function whereOf(resolved: ResolvedScope): string {
  if (resolved.all) return "any project";
  const p = resolved.projects[0];
  return p ? p.cwd : resolved.root;
}

/** The scope flags the caller gave, as a hint must carry them so it lists the same sessions. */
function scopeFlags(resolved: ResolvedScope, scope: Scope): string {
  if (resolved.all) return " --all";
  if (typeof scope.project === "string") {
    const p = scope.project;
    return ` --project ${/^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`}`;
  }
  return "";
}

function widenHints(resolved: ResolvedScope, scope: Scope): string[] {
  const hints = [`Run \`${BIN} sessions --subagents${scopeFlags(resolved, scope)}\` to list the sessions in scope`];
  if (!resolved.all) hints.push("Pass `--all` to resolve against every project, or `--project <path>` for another one");
  return hints;
}

/** The key a prefix is matched against: the id, or the sha1-derived short id of a file not named by one. */
function matchesPrefix(s: Session, prefix: string): boolean {
  const id = s.id.toLowerCase();
  if (id.startsWith(prefix)) return true;
  return !/^[0-9a-f]{8}/.test(id) && prefix.length === 8 && s.short === prefix;
}

/** Sessions in scope whose id (or derived short id) starts with `prefix`; exact matches win. */
async function byPrefix(prefix: string, scope: Scope): Promise<Session> {
  const resolved = await resolveScope(scope);
  const all = await sessionsIn(resolved);
  const exact = all.filter((s) => s.id.toLowerCase() === prefix);
  const matches = exact.length ? exact : all.filter((s) => matchesPrefix(s, prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new AgentSessionError(`no session matches ${prefix} in ${whereOf(resolved)}`, "NOT_FOUND", widenHints(resolved, scope));
  }
  // Each candidate's title by the same precedence `sessions` prints (data-model.md#session).
  const { sessionStats } = await import("./stats.js");
  const candidates: Array<Record<string, string>> = [];
  for (const s of matches) {
    const c: Record<string, string> = { id: s.id, kind: s.kind };
    if (s.parent) c.parent = s.parent;
    if (s.project) c.project = s.project.cwd;
    const stats = await sessionStats(s, { cache: scope.env ? { env: { ...process.env, ...scope.env } } : {} }).catch(() => undefined);
    c.title = stats?.title !== undefined ? titleHead(stats.title) : "";
    candidates.push(c);
  }
  throw new AgentSessionError(
    `${prefix} matches ${matches.length} sessions`,
    "AMBIGUOUS_SESSION",
    ["Pass more characters of the id (or the full id) of the session you mean", ...matches.slice(0, 5).map((s) => `candidate: ${s.id}`)],
    { candidates },
  );
}

/** A title as one line, cut to the row head (data-model.md#session). */
function titleHead(title: string): string {
  const line = title.replace(/(\r?\n)+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * The `<s8>`s that more than one session in scope shares. A hint may name such a session only by
 * its full id (cli.md#conventions): its `<s8>` would resolve to AMBIGUOUS_SESSION.
 */
export async function sharedShorts(scope: Scope | ResolvedScope): Promise<Set<string>> {
  const resolved = Array.isArray((scope as ResolvedScope).projects) ? (scope as ResolvedScope) : await resolveScope(scope as Scope);
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const s of await sessionsIn(resolved)) {
    if (seen.has(s.short)) shared.add(s.short);
    seen.add(s.short);
  }
  return shared;
}

/** How a hint names a session it resolved by reference: `<s8>` when unique in scope, else its full id. */
export function hintName(session: Session, shared: ReadonlySet<string>): string {
  return shared.has(session.short) && /^[0-9a-f]{8}/i.test(session.id) ? session.id : session.short;
}

/** `latest`: the main session in scope with the newest file mtime (ties: the greater id). */
async function latest(scope: Scope): Promise<Session> {
  const resolved = await resolveScope(scope);
  let best: { s: Session; mtime: number } | undefined;
  for (const project of resolved.projects) {
    for await (const s of claudeCode.listSessions(project, { subagents: false })) {
      let mtime: number;
      try {
        mtime = (await stat(s.path)).mtimeMs;
      } catch {
        continue; // vanished mid-listing
      }
      if (!best || mtime > best.mtime || (mtime === best.mtime && s.id > best.s.id)) best = { s, mtime };
    }
  }
  if (!best) throw new AgentSessionError(`no sessions in ${whereOf(resolved)}`, "NOT_FOUND", widenHints(resolved, scope));
  return best.s;
}

/**
 * A `<session>` reference → a session (data-model.md#session-reference), in order: an existing
 * path (scope ignored); a full uuid or agentId; a hex prefix of at least 8 characters, never
 * guessed between several (`AMBIGUOUS_SESSION`); `latest`.
 */
export async function resolveSession(ref: string, scope: Scope = {}): Promise<Session> {
  const text = ref.trim();
  if (!text) throw new AgentSessionError("empty <session>", "VALIDATION_ERROR", [SESSION_GRAMMAR]);
  const abs = resolve(scope.cwd ?? process.cwd(), expandHome(text));
  // A path ignores scope; one that looks like a path but does not exist is NOT_FOUND there.
  if (looksLikePath(text) || (await isFile(abs))) return openSession(abs);
  if (text === "latest") return readable(await latest(scope));
  const lower = text.toLowerCase();
  if (/^[0-9a-f][0-9a-f-]*$/.test(lower)) {
    if (!/^[0-9a-f]{8}/.test(lower)) {
      throw new AgentSessionError(`session prefix ${text} is too short`, "VALIDATION_ERROR", [
        "a session prefix needs at least 8 hex characters (ids are never shortened below 8)",
      ]);
    }
    return readable(await byPrefix(lower, scope));
  }
  throw new AgentSessionError(`${text} is not a session reference`, "VALIDATION_ERROR", [SESSION_GRAMMAR]);
}

// ---------------------------------------------------------------------------------------------
// ids

function badId(text: string): AgentSessionError {
  const short = /^([0-9a-f]{1,7}):\d/.exec(text.toLowerCase());
  if (short) {
    return new AgentSessionError(`${text} is not an id: the session part needs 8 hex characters`, "VALIDATION_ERROR", [ID_GRAMMAR]);
  }
  return new AgentSessionError(`${text} is not an id`, "VALIDATION_ERROR", [ID_GRAMMAR]);
}

/**
 * An id → its session and position. The `<s8>` resolves as an 8-hex prefix in scope. A bare
 * `<seq>[.<n>]` is accepted only when `opts.session` names the session; with both, the id's
 * `<s8>` must be that session's.
 */
export async function resolveId(text: string, scope: Scope = {}, opts: { session?: string } = {}): Promise<{ session: Session; id: EventId }> {
  const id = parseId(text.trim().toLowerCase());
  const bare = id ? null : parseBareSeq(text.trim());
  if (!id && !bare) throw badId(text);
  if (bare && opts.session === undefined) {
    throw new AgentSessionError(`${text} is a bare seq; it needs its session`, "VALIDATION_ERROR", [
      `write the full id (<s8>:${text}) as listings print it, or name the session with --session <ref>`,
    ]);
  }
  if (opts.session !== undefined) {
    const session = await resolveSession(opts.session, scope);
    if (id) {
      if (id.session !== session.short) {
        throw new AgentSessionError(`${formatId(id)} is not an id of session ${session.short}`, "VALIDATION_ERROR", [
          `ids of this session start with ${session.short}:`,
        ]);
      }
      return { session, id };
    }
    const out: EventId = { session: session.short, seq: bare!.seq };
    if (bare!.block !== undefined) out.block = bare!.block;
    return { session, id: out };
  }
  try {
    return { session: await readable(await byPrefix(id!.session, scope)), id: id! };
  } catch (err) {
    // An id's <s8> cannot be lengthened: name the session instead.
    if (err instanceof AgentSessionError && err.code === "AMBIGUOUS_SESSION") {
      const candidates = (err.details?.candidates ?? []) as Array<{ id: string; project?: string }>;
      throw new AgentSessionError(
        `${formatId(id!)}: its session ${id!.session} matches ${candidates.length} sessions`,
        "AMBIGUOUS_SESSION",
        candidates.slice(0, 5).map((c) => `Pass \`--session ${c.id}\` for the session${c.project ? ` in ${c.project}` : ""}`),
        err.details,
      );
    }
    throw err;
  }
}
