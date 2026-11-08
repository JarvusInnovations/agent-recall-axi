/**
 * The home view's data (specs/cli.md#home-view-no-arguments): the newest main sessions of a scope
 * with the cheapest values at hand, and where the latest one left off. Never a whole-file pass:
 * files are stat'ed, rows come from cached stats, the `sessions-index.json` accelerator or the
 * file's head, and the latest session is read backwards from its end.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { newContext } from "./adapters/adapter.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import { readSessionsIndex, type IndexEntry } from "./adapters/claude-code/sessions.js";
import type { CacheOpts } from "./cache/store.js";
import { AUTHORITY, type Event, type Session } from "./model.js";
import { countNewlinesBetween, readLines, readLinesBackward } from "./reader.js";
import { resolveScope, type ResolvedScope, type Scope } from "./scope.js";
import { cachedStats, customTitleFile, knownLineStart } from "./stats.js";

/** How far into a file's head the fallback title looks for the first human event. */
const HEAD_TITLE_BYTES = 1 << 20;
/** How far back from the end `last_human` looks. */
export const LAST_HUMAN_BYTES = 4 << 20;
/** The most appended bytes worth indexing to use cached stats. */
const STATS_APPEND = 8 << 20;

export type HomeSource = "stats" | "index" | "file";

export interface HomeSession {
  session: Session;
  mtime: string;
  /** Newest activity: exact from stats, else the index's `modified`, else the file mtime. */
  last: string;
  /** Known only from cached stats. */
  turns?: number;
  title?: string;
  source: HomeSource;
}

export interface LastHuman {
  event?: Event;
  /** No H event in the read span: `none` (the file start was reached) or `bound` (the 4 MB limit). */
  missing?: "none" | "bound";
}

export interface HomeListing {
  scope: ResolvedScope;
  /** Main sessions in scope (unreadable ones included). */
  total: number;
  unreadable: number;
  firstUnreadable?: string;
  sessions: HomeSession[];
  lastHuman?: LastHuman;
  /** The `<s8>`s more than one session in scope shares (subagents included), for hints. */
  shared: Set<string>;
}

/** The first `human` event within the file's first megabyte. */
async function headHuman(session: Session): Promise<string | undefined> {
  const ctx = newContext(session);
  try {
    // Small blocks: the first prompt is usually in the first few lines, and a 1 MB buffer per row costs GC.
    for await (const line of readLines(session.path, { blockSize: 64 << 10 })) {
      if (line.offset > HEAD_TITLE_BYTES) break;
      const entry = claudeCode.parse(line);
      if (!entry) continue;
      const ev = claudeCode.classify(entry, ctx).find((e) => e.kind === "human");
      if (ev) return ev.text;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The newest H-class event in the last 4 MB, its line numbered by a newline count before it. */
export async function lastHumanOf(session: Session, opts: { bound?: number; cache?: CacheOpts } = {}): Promise<LastHuman> {
  const bound = opts.bound ?? LAST_HUMAN_BYTES;
  const { size } = await stat(session.path);
  const probe = newContext(session);
  for await (const bl of readLinesBackward(session.path, 256 << 10)) {
    if (size - bl.offset > bound) return { missing: "bound" };
    const entry = claudeCode.parse({ seq: 1, offset: bl.offset, text: bl.text, partial: bl.partial });
    if (!entry) continue;
    if (!claudeCode.classify(entry, probe).some((e) => AUTHORITY[e.kind] === "H")) continue;
    // Numbered from the nearest line the cache knows, so only the bytes after it are counted.
    const known = await knownLineStart(session.path, bl.offset, opts.cache ?? {});
    const seq = known.seq + (await countNewlinesBetween(session.path, known.offset, bl.offset, 4 << 20));
    const real = claudeCode.parse({ seq, offset: bl.offset, text: bl.text, partial: bl.partial })!;
    const evs = claudeCode.classify(real, newContext(session)).filter((e) => AUTHORITY[e.kind] === "H");
    return { event: evs[evs.length - 1]! };
  }
  return { missing: "none" };
}

/** The home rows of a scope: main sessions by file mtime, newest first (as `latest` resolves). */
export async function homeListing(scope: Scope, opts: { limit?: number; cache?: CacheOpts } = {}): Promise<HomeListing> {
  const limit = opts.limit ?? 5;
  const resolved = await resolveScope(scope);
  const found: Array<{ s: Session; mtime: number }> = [];
  let unreadable = 0;
  let firstUnreadable: string | undefined;
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const project of resolved.projects) {
    for await (const s of claudeCode.listSessions(project, { subagents: true })) {
      if (seen.has(s.short)) shared.add(s.short);
      seen.add(s.short);
      if (s.kind !== "main") continue;
      try {
        const st = await stat(s.path);
        await access(s.path, constants.R_OK);
        found.push({ s, mtime: st.mtimeMs });
      } catch {
        unreadable++;
        firstUnreadable ??= s.path;
      }
    }
  }
  found.sort((a, b) => (a.mtime === b.mtime ? (a.s.id < b.s.id ? 1 : a.s.id > b.s.id ? -1 : 0) : b.mtime - a.mtime));
  const indexes = new Map<string, Map<string, IndexEntry>>();
  const sessions: HomeSession[] = [];
  for (const { s, mtime } of found.slice(0, limit)) {
    const mtimeIso = new Date(mtime).toISOString();
    const stats = await cachedStats(s, { cache: opts.cache ?? {}, maxAppend: STATS_APPEND }).catch(() => undefined);
    if (stats) {
      const row: HomeSession = { session: s, mtime: mtimeIso, last: stats.last, turns: stats.turns, source: "stats" };
      if (stats.title !== undefined) row.title = stats.title;
      sessions.push(row);
      continue;
    }
    const dir = s.project?.dir;
    let entry: IndexEntry | undefined;
    if (dir) {
      if (!indexes.has(dir)) indexes.set(dir, await readSessionsIndex(dir));
      const e = indexes.get(dir)!.get(s.id);
      if (e?.fileMtime !== undefined && Math.trunc(e.fileMtime) === Math.trunc(mtime)) entry = e;
    }
    const row: HomeSession = { session: s, mtime: mtimeIso, last: entry?.modified ?? mtimeIso, source: entry ? "index" : "file" };
    const title = (await customTitleFile(s)) ?? entry?.summary ?? (await headHuman(s));
    if (title !== undefined) row.title = title;
    sessions.push(row);
  }
  const out: HomeListing = { scope: resolved, total: found.length + unreadable, unreadable, sessions, shared };
  if (firstUnreadable) out.firstUnreadable = firstUnreadable;
  if (sessions[0]) out.lastHuman = await lastHumanOf(sessions[0].session, { cache: opts.cache ?? {} }).catch(() => ({ missing: "none" as const }));
  return out;
}
