/**
 * The derived, disposable cache (specs/architecture.md#cache, specs/behaviors/privacy.md): the
 * per-file identity record that rewrite detection needs
 * (specs/behaviors/id-stability.md#append-only-is-assumed). The line-offset table lives beside it
 * (`index.ts`) and is discarded here when a rewrite is detected.
 *
 * The cache lives under `$XDG_CACHE_HOME/agent-session-axi/` (default `~/.cache/…`), owner-only,
 * and is never required: every failure to read or write it is swallowed and the caller behaves as
 * if it were absent. Nothing here writes anywhere else, and session files are only read.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readLines, readLinesBackward } from "../reader.js";

export interface CacheOpts {
  env?: Record<string, string | undefined>;
  /** Overrides the location (tests). */
  dir?: string;
  /** The read time recorded with the identity; default now. */
  now?: Date;
}

/** `$XDG_CACHE_HOME/agent-session-axi`, else `~/.cache/agent-session-axi`. */
export function cacheDir(opts: CacheOpts = {}): string {
  if (opts.dir) return opts.dir;
  const env = opts.env ?? process.env;
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(base, "agent-session-axi");
}

/** What the cache remembers about one file, keyed by its absolute path. */
export interface FileIdentity {
  path: string;
  /** Byte length at the last read. */
  bytes: number;
  /** sha256 of the first line, once that line is complete; absent for an empty or partial head. */
  head?: string;
  /** Byte offset, length and sha256 of the last complete line at the last read. */
  lastOffset: number;
  lastLength: number;
  lastHash: string;
  /** ISO time of the last read. */
  seen: string;
}

export const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The record name for a file: a hash of its absolute path, so no path appears in a filename. */
export function recordName(path: string): string {
  return `${sha(path).slice(0, 32)}.json`;
}

function recordPath(dir: string, path: string): string {
  return join(dir, "files", recordName(path));
}

/** Where a file's line-offset table lives (specs/architecture.md#cache). */
export function tablePath(dir: string, path: string): string {
  return join(dir, "index", recordName(path));
}

/** Where a file's session-stats mirror and term index live (specs/architecture.md#cache). */
export function statsPath(dir: string, path: string): string {
  return join(dir, "stats", recordName(path));
}
export function termsPath(dir: string, path: string): string {
  return join(dir, "terms", recordName(path));
}

/** Every per-file derived record directory (the identity records live in `files/`). */
export const DERIVED_DIRS = ["index", "stats", "terms"] as const;

export async function readSlice(path: string, offset: number, length: number): Promise<Buffer | undefined> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return bytesRead === length ? buf : undefined;
  } finally {
    await fh.close();
  }
}

/** The identity of a file as it is now: length, first-line hash, last complete line. */
export async function currentIdentity(path: string, now: Date): Promise<FileIdentity> {
  const { size } = await stat(path);
  let lastOffset = 0;
  let lastLength = 0;
  let lastHash = sha("");
  for await (const line of readLinesBackward(path, 64 << 10)) {
    if (line.partial) continue; // a live file mid-append: the line is not settled yet
    lastOffset = line.offset;
    lastLength = Buffer.byteLength(line.text);
    lastHash = sha(line.text);
    break;
  }
  const id: FileIdentity = { path, bytes: size, lastOffset, lastLength, lastHash, seen: now.toISOString() };
  // A first line still being written is not settled: hashing it would make the append that
  // completes it look like a rewrite.
  for await (const line of readLines(path)) {
    if (!line.partial) id.head = sha(line.text);
    break;
  }
  return id;
}

/**
 * A record may be read only when it is a regular file owned by the current user and not writable
 * by group or others (architecture.md#cache): anything else is treated as absent.
 */
export async function ownedRecord(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || (st.mode & 0o022) !== 0) return false;
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    return uid === undefined || st.uid === uid;
  } catch {
    return false;
  }
}

/** A cache directory that may be written into: absent, or a real directory (never a symlink). */
export async function safeDir(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Write `<dir>/<sub>/<name>` via a temp file and rename, owner-only. Never through a symlinked
 * cache or `<sub>` directory; the temp file is removed when anything fails. Failures are swallowed:
 * an unwritable cache is the same as no cache.
 */
export async function writeRecord(dir: string, sub: string, name: string, data: string): Promise<void> {
  const folder = join(dir, sub);
  let tmp: string | undefined;
  try {
    if (!(await safeDir(dir)) || !(await safeDir(folder))) return;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!(await safeDir(dir)) || !(await safeDir(folder))) return;
    const target = join(folder, name);
    tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
    await writeFile(tmp, data, { mode: 0o600, flag: "wx" });
    await rename(tmp, target);
    tmp = undefined;
  } catch {
    // swallowed (see above)
  } finally {
    if (tmp) await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function load(dir: string, path: string): Promise<FileIdentity | undefined> {
  try {
    if (!(await ownedRecord(recordPath(dir, path)))) return undefined;
    const rec = JSON.parse(await readFile(recordPath(dir, path), "utf8")) as FileIdentity;
    return rec.path === path ? rec : undefined;
  } catch {
    return undefined;
  }
}

async function save(dir: string, rec: FileIdentity): Promise<void> {
  await writeRecord(dir, "files", recordName(rec.path), JSON.stringify(rec));
}

export interface RewriteCheck {
  rewritten: boolean;
  /** When rewritten: the time of the read the earlier ids came from. */
  since?: string;
}

/**
 * Compare a file with the identity recorded at its last read: a shorter file, a changed first
 * line, or a changed last-read line means it was rewritten in place. Records the new identity
 * either way, so a rewrite is reported once and the mark clears.
 */
export async function checkRewrite(path: string, opts: CacheOpts = {}): Promise<RewriteCheck> {
  const dir = cacheDir(opts);
  let now: FileIdentity;
  try {
    now = await currentIdentity(path, opts.now ?? new Date());
  } catch {
    return { rewritten: false };
  }
  const before = await load(dir, path);
  let rewritten = false;
  if (before) {
    if (now.bytes < before.bytes) rewritten = true;
    else if (before.head !== undefined && now.head !== before.head) rewritten = true;
    else if (before.lastLength > 0) {
      try {
        const slice = await readSlice(path, before.lastOffset, before.lastLength);
        rewritten = !slice || sha(slice.toString("utf8")) !== before.lastHash;
      } catch {
        rewritten = true;
      }
    }
  }
  // A rewritten file's derived records are discarded (id-stability.md#append-only-is-assumed).
  if (rewritten) {
    for (const p of [tablePath(dir, path), statsPath(dir, path), termsPath(dir, path)]) await rm(p, { force: true }).catch(() => undefined);
  }
  await save(dir, now);
  return rewritten && before ? { rewritten: true, since: before.seen } : { rewritten: false };
}
