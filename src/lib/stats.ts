/**
 * Session stats and titles (specs/data-model.md#session, specs/architecture.md#cache): counts,
 * first/newest timestamps and the title's source line come from the pass that builds the offset
 * table and ride on it; a small mirror record (`stats/`) carries them with the table's identity so
 * a listing reads a few hundred bytes per session. The title is read back from its line (or from
 * `custom-title.json`) on demand: the cache never holds its text.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readSessionsIndex, type IndexEntry } from "./adapters/claude-code/sessions.js";
import { readLines } from "./reader.js";
import { newContext } from "./adapters/adapter.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import { formatId } from "./ids.js";
import { KINDS, type Kind, type Session } from "./model.js";
import { ensureTable, hasNewline, loadTable, tableFor, tableMatches, type LineLoc, type OffsetTable, type StatsState } from "./cache/index.js";
import { cacheDir, ownedRecord, readSlice, recordName, statsPath, writeRecord, type CacheOpts } from "./cache/store.js";
import { VERSION as PACKAGE_VERSION } from "../version.js";

export type TitleSource = "custom-title.json" | "custom-title" | "ai-title" | "human";

export interface SessionStats {
  /** Prompts that open a turn: `human` and `human.slash` events. */
  turns: number;
  calls: number;
  /** Window boundaries (as `compactions` lists them). */
  compactions: number;
  /** `human*` events. */
  humans: number;
  /** Complete lines indexed. */
  lines: number;
  malformed: number;
  /** File size at the read. */
  bytes: number;
  /** File modification time (ISO). */
  mtime: string;
  /** First entry timestamp in file order (ISO). */
  started?: string;
  /** Newest entry timestamp (ISO); the file mtime when no entry has one. */
  last: string;
  /** The title, uncut (renderers make it one line and cut it); absent when no source exists. */
  title?: string;
  titleSource?: TitleSource;
  /** The last assistant entry's model. */
  model?: string;
}

/** The mirror's format; bumped whenever what it records changes. */
const MIRROR_VERSION = 1;

/** The mirror record: the table's identity, its counts and its stats state. */
interface Mirror {
  v: number;
  pkg: string;
  path: string;
  seq: number;
  end: number;
  head?: string;
  headLength?: number;
  lastOffset: number;
  lastLength: number;
  lastHash: string;
  counts: { turns: number; calls: number; compactions: number; humans: number; malformed: number };
  stats: StatsState;
}

const KIND_INDEX = new Map<Kind, number>(KINDS.map((k, i) => [k, i]));
const cum = (t: OffsetTable, k: Kind) => t.tail.cum[KIND_INDEX.get(k)!] ?? 0;

function mirrorOf(t: OffsetTable): Mirror {
  const m: Mirror = {
    v: MIRROR_VERSION,
    pkg: PACKAGE_VERSION,
    path: t.path,
    seq: t.seq,
    end: t.end,
    lastOffset: t.lastOffset,
    lastLength: t.lastLength,
    lastHash: t.lastHash,
    counts: {
      turns: cum(t, "human") + cum(t, "human.slash"),
      calls: cum(t, "call"),
      compactions: t.bounds.length,
      humans: cum(t, "human") + cum(t, "human.queued") + cum(t, "human.slash") + cum(t, "human.answer"),
      malformed: t.tail.malformed,
    },
    stats: t.stats,
  };
  if (t.head !== undefined) m.head = t.head;
  if (t.headLength !== undefined) m.headLength = t.headLength;
  return m;
}

function isMirror(v: unknown, path: string): v is Mirror {
  const m = v as Mirror;
  return typeof m === "object" && m !== null && m.v === MIRROR_VERSION && m.pkg === PACKAGE_VERSION && m.path === path && typeof m.end === "number" && typeof m.counts === "object" && m.counts !== null && typeof m.stats === "object" && m.stats !== null;
}

/** The mirror, when it parses and the file is still exactly what it describes (a line being written aside). */
async function loadMirror(path: string, opts: CacheOpts): Promise<Mirror | undefined> {
  let parsed: unknown;
  try {
    const rec = statsPath(cacheDir(opts), path);
    if (!(await ownedRecord(rec))) return undefined;
    parsed = JSON.parse(await readFile(rec, "utf8"));
  } catch {
    return undefined;
  }
  if (!isMirror(parsed, path)) return undefined;
  try {
    if (!(await tableMatches(parsed as unknown as OffsetTable, path))) return undefined;
    const { size } = await stat(path);
    if (size > parsed.end && (await hasNewline(path, parsed.end, size))) return undefined;
  } catch {
    return undefined;
  }
  return parsed;
}

/**
 * The line count the cache knows at a byte offset at or before `offset` (the mirror's end, or the
 * nearest table checkpoint, line 1 included), so a caller counts newlines only from there.
 * Undefined when the cache knows nothing that still matches the file: the line cannot be numbered
 * without reading the file from its start.
 */
export async function knownLineStart(path: string, offset: number, cache: CacheOpts = {}): Promise<{ seq: number; offset: number } | undefined> {
  if (offset === 0) return { seq: 1, offset: 0 };
  let best: { seq: number; offset: number } | undefined;
  try {
    const rec = statsPath(cacheDir(cache), path);
    if (await ownedRecord(rec)) {
      const m = JSON.parse(await readFile(rec, "utf8")) as unknown;
      if (isMirror(m, path) && m.end <= offset && m.end > 0 && (await tableMatches(m as unknown as OffsetTable, path))) best = { seq: m.seq + 1, offset: m.end };
    }
  } catch {
    // no usable mirror
  }
  const table = await loadTable(path, cache);
  if (table) {
    for (const cp of [...table.checkpoints, table.tail]) if (cp.offset <= offset && (!best || cp.offset > best.offset)) best = { seq: cp.seq, offset: cp.offset };
  }
  return best;
}

async function saveMirror(t: OffsetTable, opts: CacheOpts): Promise<void> {
  await writeRecord(cacheDir(opts), "stats", recordName(t.path), JSON.stringify(mirrorOf(t)));
}

async function readLine(path: string, loc: LineLoc): Promise<Record<string, unknown> | undefined> {
  try {
    const buf = await readSlice(path, loc.offset, loc.length);
    if (!buf) return undefined;
    const v = JSON.parse(buf.toString("utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `<sidecar>/custom-title.json`'s `customTitle` (main sessions only: a subagent's sidecar is its parent's). */
export async function customTitleFile(session: Session): Promise<string | undefined> {
  if (session.kind !== "main") return undefined;
  try {
    const v = JSON.parse(await readFile(join(session.sidecar, "custom-title.json"), "utf8")) as { customTitle?: unknown };
    return typeof v.customTitle === "string" && v.customTitle.trim() ? v.customTitle : undefined;
  } catch {
    return undefined;
  }
}

/** How far into a file's head the cheap title looks for the first human event. */
export const HEAD_TITLE_BYTES = 1 << 20;

/** The first `human` event within the file's first megabyte (small read blocks: it is usually near the top). */
export async function headHuman(session: Session): Promise<string | undefined> {
  const ctx = newContext(session);
  try {
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

/** The `sessions-index.json` entry for a session, only while its `fileMtime` matches the file. */
export async function indexEntry(session: Session, mtimeMs?: number): Promise<IndexEntry | undefined> {
  const dir = session.kind === "main" ? (session.project?.dir ?? dirname(session.path)) : undefined;
  if (!dir) return undefined;
  const e = (await readSessionsIndex(dir)).get(session.id);
  if (e?.fileMtime === undefined) return undefined;
  let mtime = mtimeMs;
  if (mtime === undefined) {
    try {
      mtime = (await stat(session.path)).mtimeMs;
    } catch {
      return undefined;
    }
  }
  return Math.trunc(e.fileMtime) === Math.trunc(mtime) ? e : undefined;
}

/**
 * The title a single-session header prints (cli.md#conventions): the cheap sources only, so it
 * depends on the file and its sidecar, never the cache. Undefined means `(untitled)`.
 */
export async function headerTitle(session: Session): Promise<string | undefined> {
  return (await customTitleFile(session)) ?? (await indexEntry(session))?.summary ?? (await headHuman(session));
}

/** The title by precedence (data-model.md#session), read back from its source line. */
export async function resolveTitle(session: Session, st: StatsState): Promise<{ title: string; source: TitleSource } | undefined> {
  const file = await customTitleFile(session);
  if (file !== undefined) return { title: file, source: "custom-title.json" };
  if (st.custom) {
    const raw = await readLine(session.path, st.custom);
    if (typeof raw?.customTitle === "string" && raw.customTitle.trim()) return { title: raw.customTitle, source: "custom-title" };
  }
  if (st.ai) {
    const raw = await readLine(session.path, st.ai);
    if (typeof raw?.aiTitle === "string" && raw.aiTitle.trim()) return { title: raw.aiTitle, source: "ai-title" };
  }
  if (st.human) {
    const text = await humanAt(session, st.human);
    if (text !== undefined) return { title: text, source: "human" };
  }
  return undefined;
}

/** The text of the `human` event `loc.id` on the line at `loc` (a human event needs no earlier context). */
export async function humanAt(session: Session, loc: LineLoc & { id: string }): Promise<string | undefined> {
  try {
    const buf = await readSlice(session.path, loc.offset, loc.length);
    if (!buf) return undefined;
    const entry = claudeCode.parse({ seq: loc.seq, offset: loc.offset, text: buf.toString("utf8"), partial: false });
    if (!entry) return undefined;
    const ev = claudeCode.classify(entry, newContext(session)).find((e) => formatId(e.id) === loc.id);
    return ev && ev.kind === "human" ? ev.text : undefined;
  } catch {
    return undefined;
  }
}

async function build(session: Session, m: Mirror, size: number, mtime: Date): Promise<SessionStats> {
  const out: SessionStats = {
    ...m.counts,
    lines: m.seq,
    bytes: size,
    mtime: mtime.toISOString(),
    last: m.stats.max ?? mtime.toISOString(),
  };
  if (m.stats.first) out.started = m.stats.first;
  if (m.stats.model) out.model = m.stats.model;
  const t = await resolveTitle(session, m.stats);
  if (t) {
    out.title = t.title;
    out.titleSource = t.source;
  }
  return out;
}

export interface StatsOpts {
  cache?: CacheOpts;
}

/** Stats from a table that covers the file (the table's own pass computed them); the mirror is refreshed. */
export async function statsFromTable(session: Session, table: OffsetTable, cache: CacheOpts = {}): Promise<SessionStats> {
  const st = await stat(session.path);
  await saveMirror(table, cache);
  return build(session, mirrorOf(table), st.size, st.mtime);
}

/**
 * A session's stats (specs/api.md#scope-and-sessions): from the mirror when it matches the file,
 * else from the offset table, extended over an append or built by one streaming pass.
 */
export async function sessionStats(session: Session, opts: StatsOpts = {}): Promise<SessionStats> {
  const cache = opts.cache ?? {};
  const st = await stat(session.path);
  const m = await loadMirror(session.path, cache);
  if (m) return build(session, m, st.size, st.mtime);
  const table = await tableFor(session, cache);
  return statsFromTable(session, table, cache);
}

/**
 * Stats without a whole-file pass (the home view): the mirror, or an existing table extended over
 * its appended bytes when they fit `budget.left` (which the extension spends; default 8 MB).
 * Undefined when neither is at hand.
 */
export async function cachedStats(session: Session, opts: StatsOpts & { maxAppend?: number; budget?: { left: number } } = {}): Promise<SessionStats | undefined> {
  const cache = opts.cache ?? {};
  let st;
  try {
    st = await stat(session.path);
  } catch {
    return undefined;
  }
  const m = await loadMirror(session.path, cache);
  if (m) return build(session, m, st.size, st.mtime);
  const budget = opts.budget ?? { left: opts.maxAppend ?? 8 << 20 };
  const existing = await loadTable(session.path, cache);
  if (!existing) return undefined;
  const need = Math.max(0, st.size - existing.end);
  if (need > budget.left) return undefined;
  budget.left -= need;
  const table = await ensureTable(session, { ...cache, build: false, maxAppend: need });
  if (!table) return undefined;
  return statsFromTable(session, table, cache);
}
