/**
 * The line-offset table (specs/architecture.md#cache): a checkpoint every 256th line with the
 * byte offset and the classification state at that line, so a read started there classifies
 * exactly as a scan from the file start would; plus per-kind event counts. Built lazily on first
 * seek, extended on append, discarded when the file no longer matches its identity.
 *
 * Derived and disposable: every cache read or write failure is swallowed. A table that cannot be
 * saved is still returned for the current read.
 */
import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { newContext, type ClassifyContext } from "../adapters/adapter.js";
import { claudeCode } from "../adapters/claude-code/index.js";
import { formatId, parseId } from "../ids.js";
import { KINDS, type Entry, type Event, type EventId, type Kind, type Session } from "../model.js";
import { readLines } from "../reader.js";
import { WindowCounter } from "../window-state.js";
import { VERSION as PACKAGE_VERSION } from "../../version.js";
import { cacheDir, DERIVED_DIRS, ownedRecord, readSlice, recordName, safeDir, sha, tablePath, writeRecord, type CacheOpts } from "./store.js";

export const CHECKPOINT_EVERY = 256;
/** The table format; bumped whenever what a table records changes. */
const VERSION = 5;

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
  /** Window boundaries before this line: the window in effect (window-state.ts). */
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

/**
 * A window boundary (behaviors/context-windows.md): where window `k` (its index in `bounds`, + 1)
 * begins. Ids are formatted.
 */
export interface Bound {
  /** The compaction that closed the window before; absent for a boundary-less summary. */
  compaction?: string;
  /** The summary that opened the window, once read. */
  summary?: string;
  /** The position where the window begins (inclusive): the line after a compaction, or the summary itself. */
  start: string;
  /** Events per kind before `start`, in `KINDS` order. */
  cum: number[];
}

/** Where a line lives: what a title is read back from (the cache never holds its text). */
export interface LineLoc {
  seq: number;
  offset: number;
  /** Bytes, without the newline. */
  length: number;
}

/**
 * The session-stats state after the last indexed line (data-model.md#session,
 * architecture.md#cache): timestamps, the model, and the lines a title can come from.
 */
export interface StatsState {
  /** First entry timestamp in file order (ISO). */
  first?: string;
  /** Newest entry timestamp (ISO). */
  max?: string;
  /** `message.model` of the last assistant entry. */
  model?: string;
  /** The last `custom-title` entry. */
  custom?: LineLoc;
  /** The last `ai-title` entry. */
  ai?: LineLoc;
  /** The line of the first `human` event, and that event's id. */
  human?: LineLoc & { id: string };
}

/** What a pass over lines may observe besides the table (the term index, recall's matcher). */
export interface PassObserver {
  event(ev: Event, entry: Entry): void;
}

export interface OffsetTable {
  v: number;
  /** The package version that built it: a classifier change discards every table. */
  pkg: string;
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
  /**
   * Every tool-use id → tool-name assignment classification made, in file order, one
   * `<seq>\t<use id>\t<tool>\n` line each: a checkpoint's share is the lines before its seq. One
   * string, because it is consulted only for a result whose call is no longer pending (rare), so
   * it is searched on demand instead of being parsed into a map on every seek.
   */
  tools: string;
  /** Window boundaries in file order (bounds[k - 1] opens window k). */
  bounds: Bound[];
  /** Session stats after the last indexed line. */
  stats: StatsState;
}

/** A tool name inside the `tools` log: backslash, tab and newline escaped. */
const escapeTool = (t: string) => t.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
const unescapeTool = (t: string) => t.replace(/\\(\\|t|n)/g, (_m, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : "\\"));

/**
 * The tool-use id → tool map of a seeded context: assignments made during this read, then the
 * table's assignments before the checkpoint, searched on a miss (classify asks only for a result
 * whose call is no longer pending).
 */
class SeededTools extends Map<string, string> {
  constructor(
    private readonly log: string,
    private readonly before: number,
  ) {
    super();
  }

  override get(use: string): string | undefined {
    if (super.has(use)) return super.get(use);
    const key = `\t${use}\t`;
    let pos = this.log.lastIndexOf(key);
    while (pos >= 0) {
      const start = this.log.lastIndexOf("\n", pos) + 1;
      if (Number(this.log.slice(start, pos)) < this.before) {
        const end = this.log.indexOf("\n", pos + key.length);
        const tool = unescapeTool(this.log.slice(pos + key.length, end === -1 ? undefined : end));
        super.set(use, tool);
        return tool;
      }
      pos = start > 0 ? this.log.lastIndexOf(key, start - 1) : -1;
    }
    return undefined;
  }

  override has(use: string): boolean {
    return this.get(use) !== undefined;
  }
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

/** A classification context seeded with a checkpoint's state (and the table's tool names before it). */
export function seedContext(session: Session, cp: Checkpoint, table?: OffsetTable): ClassifyContext {
  const ctx = newContext(session);
  if (table) ctx.tools = new SeededTools(table.tools, cp.seq);
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
    Array.isArray(t.checkpoints) && t.checkpoints.length > 0 && typeof t.tail === "object" && Array.isArray(t.tail?.cum) &&
    t.pkg === PACKAGE_VERSION && typeof t.tools === "string" && Array.isArray(t.bounds) && typeof t.stats === "object" && t.stats !== null
  );
}

/** The saved table for a file, when it exists, parses, and still matches the file. */
export async function loadTable(path: string, opts: CacheOpts = {}): Promise<OffsetTable | undefined> {
  let parsed: unknown;
  try {
    const rec = tablePath(cacheDir(opts), path);
    if (!(await ownedRecord(rec))) return undefined;
    parsed = JSON.parse(await readFile(rec, "utf8"));
  } catch {
    return undefined;
  }
  if (!isTable(parsed, path)) return undefined;
  return (await tableMatches(parsed, path)) ? parsed : undefined;
}

export async function saveTable(table: OffsetTable, opts: CacheOpts): Promise<void> {
  await writeRecord(cacheDir(opts), "index", recordName(table.path), JSON.stringify(table));
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
export async function extendTable(session: Session, table: OffsetTable | undefined, upTo?: number, observer?: PassObserver): Promise<OffsetTable> {
  const start = table?.tail ?? emptyState();
  const t: OffsetTable = table
    ? { ...table, checkpoints: [...table.checkpoints], bounds: table.bounds.map((b) => ({ ...b })), stats: { ...table.stats } }
    : { v: VERSION, pkg: PACKAGE_VERSION, path: session.path, seq: 0, end: 0, lastOffset: 0, lastLength: 0, lastHash: sha(""), checkpoints: [], tail: start, tools: "", bounds: [], stats: {} };
  const stats = t.stats;
  const windows = new WindowCounter(start.window, start.cum.some((n) => n > 0));
  const ctx = seedContext(session, start, table);
  const tools: string[] = [];
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
    const next = line.end ?? line.offset + Buffer.byteLength(line.text) + 1;
    if (entry) {
      if (entry.malformed) st.malformed++;
      noteEntry(stats, entry, line.seq, line.offset, next - line.offset - 1);
      for (const ev of claudeCode.classify(entry, ctx)) {
        if (ev.kind === "human" && !stats.human) stats.human = { seq: line.seq, offset: line.offset, length: next - line.offset - 1, id: formatId(ev.id) };
        observer?.event(ev, entry);
        if (windows.opens(ev)) t.bounds.push({ summary: formatId(ev.id), start: formatId(ev.id), cum: [...st.cum] });
        windows.place(ev);
        st.window = windows.index;
        st.cum[KIND_INDEX.get(ev.kind)!]!++;
        if (ev.kind === "compaction") t.bounds.push({ compaction: formatId(ev.id), start: formatId({ session: ev.id.session, seq: ev.id.seq + 1 }), cum: [...st.cum] });
        else if (ev.kind === "summary" && ev.meta?.compaction) {
          const c = formatId(ev.meta.compaction as EventId);
          for (let i = t.bounds.length - 1; i >= 0; i--) {
            if (t.bounds[i]!.compaction !== c) continue;
            t.bounds[i]!.summary = formatId(ev.id);
            break;
          }
        }
        if (opensTurn(ev.kind)) st.turn = ev.id;
        st.last = ev.id;
        // Mirrors classify's `ctx.tools.set` (adapter link): every call with a tool and an id.
        if (ev.kind === "call" && ev.toolUseId && ev.tool) tools.push(`${line.seq}\t${ev.toolUseId}\t${escapeTool(ev.tool)}\n`);
      }
    }
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
  if (tools.length) t.tools = (table?.tools ?? "") + tools.join("");
  else if (table) t.tools = table.tools;
  // Only the last indexed line is hashed: hashing every line doubled the build.
  if (lastText !== undefined) t.lastHash = sha(lastText);
  t.end = offset;
  t.tail = snapshot(seq, offset, st, ctx);
  return t;
}

/** The canonical ISO form Claude Code writes: such strings order chronologically as text. */
const CANONICAL_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** An entry timestamp as canonical ISO, or undefined when it does not parse. */
function isoOf(t: string): string | undefined {
  if (CANONICAL_TS.test(t)) return t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Timestamps, the model and the title lines an entry contributes to the stats (one per line, so kept cheap). */
function noteEntry(stats: StatsState, entry: Entry, seq: number, offset: number, length: number): void {
  if (entry.t !== undefined) {
    const iso = isoOf(entry.t);
    if (iso !== undefined) {
      stats.first ??= iso;
      if (stats.max === undefined || iso > stats.max) stats.max = iso;
    }
  }
  const type = entry.type;
  if (type === "assistant") {
    const model = (entry.raw?.message as { model?: unknown } | undefined)?.model;
    if (typeof model === "string" && model) stats.model = model;
  } else if (type === "custom-title") {
    // The last entry wins even when empty (a cleared title): reading it back then falls through.
    if (typeof entry.raw?.customTitle === "string") stats.custom = { seq, offset, length };
  } else if (type === "ai-title") {
    if (typeof entry.raw?.aiTitle === "string") stats.ai = { seq, offset, length };
  }
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

/** The table for a session, built when absent, covering the file (or up to `upTo`): what a seek reads. */
export async function tableFor(session: Session, cache: CacheOpts | undefined, upTo?: number): Promise<OffsetTable> {
  const opts = { ...(cache ?? {}), build: true, ...(upTo !== undefined ? { upTo } : {}) };
  return (await ensureTable(session, opts)) ?? (await extendTable(session, undefined, upTo));
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

/** Is there a newline in `[from, to)`? (Read in 1 MB blocks.) */
export async function hasNewline(path: string, from: number, to: number): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let pos = from; pos < to; ) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, to - pos), pos);
      if (bytesRead === 0) return false;
      if (buf.subarray(0, bytesRead).includes(0x0a)) return true;
      pos += bytesRead;
    }
    return false;
  } finally {
    await fh.close();
  }
}

async function stateOf(table: OffsetTable): Promise<TableState> {
  let size: number;
  try {
    size = await fileSize(table.path);
  } catch {
    return "missing";
  }
  if (!(await tableMatches(table, table.path))) return "rewritten";
  if (size === table.end) return "fresh";
  // Only a line still being written after the indexed end: nothing a seek would index yet.
  return (await hasNewline(table.path, table.end, size)) ? "appended" : "fresh";
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
      if (!(await ownedRecord(p))) continue;
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

/**
 * Delete the cache directory, or only the records whose stored path is one of `paths` or lies
 * under one of them (a project's log directory), so records of deleted logs go too.
 */
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
  const roots = opts.paths;
  const matches = (path: string) => roots.some((r) => path === r || path.startsWith(r.endsWith(sep) ? r : `${r}${sep}`));
  let removed = 0;
  for (const sub of ["files", ...DERIVED_DIRS]) {
    if (!(await safeDir(join(dir, sub)))) continue;
    for (const name of await dirFiles(join(dir, sub))) {
      const p = join(dir, sub, name);
      try {
        const rec = JSON.parse(await readFile(p, "utf8")) as { path?: unknown };
        if (typeof rec.path !== "string" || !matches(rec.path)) continue;
        await rm(p, { force: true });
        removed++;
      } catch {
        // unreadable or vanished: not ours to judge
      }
    }
  }
  return { removed, existed };
}
