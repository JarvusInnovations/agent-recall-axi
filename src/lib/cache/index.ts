/**
 * The line-offset table (specs/architecture.md#cache): a checkpoint every 256th line with the
 * byte offset and the classification state at that line, so a read started there classifies
 * exactly as a scan from the file start would; plus per-kind event counts. Built lazily on first
 * seek, extended on append, discarded when the file no longer matches its identity.
 *
 * Derived and disposable: every cache read or write failure is swallowed. A table that cannot be
 * saved is still returned for the current read.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newContext, type ClassifyContext } from "../adapters/adapter.js";
import { claudeCode } from "../adapters/claude-code/index.js";
import { formatId, parseId } from "../ids.js";
import { KINDS, type Event, type EventId, type Kind, type Session } from "../model.js";
import { readLines } from "../reader.js";
import { cacheDir, readSlice, recordName, sha, tablePath, type CacheOpts } from "./store.js";

export const CHECKPOINT_EVERY = 256;
const VERSION = 1;

/** A call still waiting for its result at a checkpoint: what linking a later result needs. */
export interface PendingCall {
  /** tool_use id */
  use: string;
  id: string;
  tool?: string;
  files?: string[];
}

/** Classification state just before line `seq` (which starts at byte `offset`). */
export interface Checkpoint {
  seq: number;
  offset: number;
  /** The `human` / `human.slash` event in effect (the turn), as a formatted id. */
  turn?: string;
  /** Compaction events before this line. */
  window: number;
  /** The last event (any kind) before this line. */
  last?: string;
  pending: PendingCall[];
  /** A compaction still waiting for its summary. */
  compaction?: string;
  /** Events per kind before this line, in `KINDS` order. */
  cum: number[];
  /** Malformed lines before this line. */
  malformed: number;
}

export interface OffsetTable {
  v: number;
  path: string;
  /** Last indexed seq (0 when no complete line has been indexed). */
  seq: number;
  /** Byte offset just past the last indexed line. */
  end: number;
  /** sha256 and byte length of the first line, once indexed. */
  head?: string;
  headLength?: number;
  /** The last indexed line: offset, byte length, sha256. */
  lastOffset: number;
  lastLength: number;
  lastHash: string;
  /** Checkpoints at lines 1, 257, 513, … */
  checkpoints: Checkpoint[];
  /** The state after the last indexed line, where an append resumes. */
  tail: Checkpoint;
}

const opensTurn = (k: Kind) => k === "human" || k === "human.slash";
const KIND_INDEX = new Map<Kind, number>(KINDS.map((k, i) => [k, i]));

function emptyState(): Checkpoint {
  return { seq: 1, offset: 0, window: 0, pending: [], cum: KINDS.map(() => 0), malformed: 0 };
}

/** Visible events counted by a checkpoint, for a kind set. */
export function countOf(cp: Checkpoint, visible: ReadonlySet<Kind>): number {
  let n = 0;
  for (const k of visible) n += cp.cum[KIND_INDEX.get(k)!] ?? 0;
  return n;
}

/** A classification context seeded with a checkpoint's state. */
export function seedContext(session: Session, cp: Checkpoint): ClassifyContext {
  const ctx = newContext(session);
  for (const p of cp.pending) {
    const id = parseId(p.id);
    if (!id) continue;
    const stub: Event = { id, kind: "call", authority: "C", text: "", size: 0, toolUseId: p.use };
    if (p.tool !== undefined) {
      stub.tool = p.tool;
      ctx.tools.set(p.use, p.tool);
    }
    if (p.files) stub.files = [...p.files];
    ctx.pending.set(p.use, stub);
  }
  if (cp.compaction) {
    const id = parseId(cp.compaction);
    if (id) ctx.compaction = { id, kind: "compaction", authority: "D", text: "", size: 0 };
  }
  return ctx;
}

export function idOf(text: string | undefined): EventId | undefined {
  return text ? (parseId(text) ?? undefined) : undefined;
}

/** The checkpoint (or the tail state) to start a read of `seq` from: the latest at or before it. */
export function startFor(table: OffsetTable, seq: number): Checkpoint {
  if (seq >= table.tail.seq) return table.tail;
  const k = Math.min(Math.floor((seq - 1) / CHECKPOINT_EVERY), table.checkpoints.length - 1);
  return table.checkpoints[Math.max(0, k)]!;
}

/** All start points in seq order: the checkpoints, then the tail state when it is past them. */
export function points(table: OffsetTable): Checkpoint[] {
  const last = table.checkpoints[table.checkpoints.length - 1];
  return last && last.seq === table.tail.seq ? table.checkpoints : [...table.checkpoints, table.tail];
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

/** Does the file still hold the bytes the table was built from? (A shorter file, a changed head or last line: no.) */
export async function tableMatches(table: OffsetTable, path: string): Promise<boolean> {
  try {
    const size = await fileSize(path);
    if (size < table.end) return false;
    if (table.seq === 0) return true;
    if (table.head !== undefined && table.headLength !== undefined) {
      const head = await readSlice(path, 0, table.headLength);
      if (!head || sha(head.toString("utf8")) !== table.head) return false;
    }
    const last = await readSlice(path, table.lastOffset, table.lastLength);
    return !!last && sha(last.toString("utf8")) === table.lastHash;
  } catch {
    return false;
  }
}

function isTable(v: unknown, path: string): v is OffsetTable {
  const t = v as OffsetTable;
  return (
    typeof t === "object" && t !== null && t.v === VERSION && t.path === path && typeof t.seq === "number" && typeof t.end === "number" &&
    Array.isArray(t.checkpoints) && t.checkpoints.length > 0 && typeof t.tail === "object" && Array.isArray(t.tail?.cum)
  );
}

/** The saved table for a file, when it exists, parses, and still matches the file. */
export async function loadTable(path: string, opts: CacheOpts = {}): Promise<OffsetTable | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(tablePath(cacheDir(opts), path), "utf8"));
  } catch {
    return undefined;
  }
  if (!isTable(parsed, path)) return undefined;
  return (await tableMatches(parsed, path)) ? parsed : undefined;
}

async function saveTable(table: OffsetTable, opts: CacheOpts): Promise<void> {
  try {
    const dir = join(cacheDir(opts), "index");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, recordName(table.path));
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(table), { mode: 0o600 });
    await rename(tmp, target);
  } catch {
    // An unwritable cache is the same as no cache.
  }
}

/** The running state while indexing; ids stay objects until a checkpoint is written. */
interface Running {
  turn?: EventId | string;
  last?: EventId | string;
  window: number;
  cum: number[];
  malformed: number;
}

const idText = (v: EventId | string) => (typeof v === "string" ? v : formatId(v));

function snapshot(seq: number, offset: number, st: Running, ctx: ClassifyContext): Checkpoint {
  const cp: Checkpoint = { seq, offset, window: st.window, pending: [], cum: [...st.cum], malformed: st.malformed };
  if (st.turn) cp.turn = idText(st.turn);
  if (st.last) cp.last = idText(st.last);
  for (const [use, ev] of ctx.pending) {
    const p: PendingCall = { use, id: formatId(ev.id) };
    if (ev.tool !== undefined) p.tool = ev.tool;
    if (ev.files?.length) p.files = [...ev.files];
    cp.pending.push(p);
  }
  if (ctx.compaction) cp.compaction = formatId(ctx.compaction.id);
  return cp;
}

/**
 * Index the complete lines after the table's end (or the whole file for no table), stopping once
 * `upTo` is covered when given. A trailing line still being written is left for the next run.
 */
export async function extendTable(session: Session, table: OffsetTable | undefined, upTo?: number): Promise<OffsetTable> {
  const start = table?.tail ?? emptyState();
  const t: OffsetTable = table
    ? { ...table, checkpoints: [...table.checkpoints] }
    : { v: VERSION, path: session.path, seq: 0, end: 0, lastOffset: 0, lastLength: 0, lastHash: sha(""), checkpoints: [], tail: start };
  const ctx = seedContext(session, start);
  const st: Running = { window: start.window, cum: [...start.cum], malformed: start.malformed };
  if (start.turn) st.turn = start.turn;
  if (start.last) st.last = start.last;
  let seq = start.seq;
  let offset = start.offset;
  let lastText: string | undefined;
  if (t.checkpoints.length === 0) t.checkpoints.push(snapshot(1, 0, st, ctx));
  for await (const line of readLines(session.path, { startOffset: start.offset, startSeq: start.seq })) {
    if (line.partial) break;
    if (upTo !== undefined && line.seq > upTo) break;
    if ((line.seq - 1) % CHECKPOINT_EVERY === 0 && line.seq > t.checkpoints[t.checkpoints.length - 1]!.seq) {
      t.checkpoints.push(snapshot(line.seq, line.offset, st, ctx));
    }
    const entry = claudeCode.parse(line);
    if (entry) {
      if (entry.malformed) st.malformed++;
      for (const ev of claudeCode.classify(entry, ctx)) {
        st.cum[KIND_INDEX.get(ev.kind)!]!++;
        if (opensTurn(ev.kind)) st.turn = ev.id;
        if (ev.kind === "compaction") st.window++;
        st.last = ev.id;
      }
    }
    const next = line.end ?? line.offset + Buffer.byteLength(line.text) + 1;
    if (line.seq === 1) {
      t.head = sha(line.text);
      t.headLength = next - line.offset - 1;
    }
    t.seq = line.seq;
    t.lastOffset = line.offset;
    t.lastLength = next - line.offset - 1;
    lastText = line.text;
    seq = line.seq + 1;
    offset = next;
  }
  // Only the last indexed line is hashed: hashing every line doubled the build.
  if (lastText !== undefined) t.lastHash = sha(lastText);
  t.end = offset;
  t.tail = snapshot(seq, offset, st, ctx);
  return t;
}

export interface EnsureOpts extends CacheOpts {
  /** Build a table when none exists (a seek); otherwise only use and extend an existing one. */
  build: boolean;
  /** Only lines up to this seq need to be indexed. */
  upTo?: number;
  /** Without `build`: the most appended bytes worth indexing for this read. */
  maxAppend?: number;
}

/**
 * The table for a session, current enough for the read: loaded, extended over appended lines and
 * saved; built from scratch when `build` and absent. Undefined when there is none to use.
 */
export async function ensureTable(session: Session, opts: EnsureOpts): Promise<OffsetTable | undefined> {
  let table = await loadTable(session.path, opts);
  if (!table && !opts.build) return undefined;
  let size: number;
  try {
    size = await fileSize(session.path);
  } catch {
    return table;
  }
  const covered = table && (opts.upTo !== undefined ? table.seq >= opts.upTo : table.end >= size);
  if (table && covered) return table;
  if (table && !opts.build && size - table.end > (opts.maxAppend ?? Infinity)) return undefined;
  const before = table ? `${table.seq}:${table.end}` : "";
  table = await extendTable(session, table, opts.upTo);
  if (`${table.seq}:${table.end}` !== before) await saveTable(table, opts);
  return table;
}

// ---------------------------------------------------------------------------------------------
// cache status / clear (specs/cli.md#cache)

export type TableState = "fresh" | "appended" | "rewritten" | "missing";

export interface IndexedFile {
  path: string;
  /** Last indexed seq. */
  lines: number;
  checkpoints: number;
  /** The record's bytes on disk. */
  size: number;
  state: TableState;
}

export interface CacheStatus {
  dir: string;
  exists: boolean;
  /** Bytes of every file under the directory. */
  size: number;
  /** Identity records. */
  tracked: number;
  indexed: IndexedFile[];
}

async function dirFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

async function treeSize(dir: string): Promise<number> {
  let total = 0;
  let names: import("node:fs").Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of names) {
    const p = join(dir, d.name);
    if (d.isDirectory()) total += await treeSize(p);
    else {
      try {
        total += (await stat(p)).size;
      } catch {
        // vanished
      }
    }
  }
  return total;
}

async function stateOf(table: OffsetTable): Promise<TableState> {
  let size: number;
  try {
    size = await fileSize(table.path);
  } catch {
    return "missing";
  }
  if (!(await tableMatches(table, table.path))) return "rewritten";
  return size > table.end ? "appended" : "fresh";
}

/** The cache directory, its size, and every indexed file with its state (specs/api.md). */
export async function cacheStatus(opts: CacheOpts = {}): Promise<CacheStatus> {
  const dir = cacheDir(opts);
  let exists = false;
  try {
    exists = (await stat(dir)).isDirectory();
  } catch {
    exists = false;
  }
  const status: CacheStatus = { dir, exists, size: 0, tracked: 0, indexed: [] };
  if (!exists) return status;
  status.size = await treeSize(dir);
  status.tracked = (await dirFiles(join(dir, "files"))).length;
  for (const name of await dirFiles(join(dir, "index"))) {
    const p = join(dir, "index", name);
    try {
      const [text, st] = await Promise.all([readFile(p, "utf8"), stat(p)]);
      const t = JSON.parse(text) as OffsetTable;
      if (typeof t?.path !== "string" || !isTable(t, t.path) || recordName(t.path) !== name) continue;
      status.indexed.push({ path: t.path, lines: t.seq, checkpoints: t.checkpoints.length, size: st.size, state: await stateOf(t) });
    } catch {
      // A partial or unreadable record is the same as none.
    }
  }
  status.indexed.sort((a, b) => a.path.localeCompare(b.path));
  return status;
}

/** Delete the cache directory, or only the records of the given session files. */
export async function clearCache(opts: CacheOpts & { paths?: string[] } = {}): Promise<{ removed: number; existed: boolean }> {
  const dir = cacheDir(opts);
  let existed = false;
  try {
    existed = (await stat(dir)).isDirectory();
  } catch {
    existed = false;
  }
  if (!existed) return { removed: 0, existed };
  if (!opts.paths) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { removed: 1, existed };
  }
  let removed = 0;
  for (const path of opts.paths) {
    for (const sub of ["files", "index"]) {
      const p = join(dir, sub, recordName(path));
      try {
        await stat(p);
        await rm(p, { force: true });
        removed++;
      } catch {
        // absent
      }
    }
  }
  return { removed, existed };
}
