/**
 * `--json-out[=path]` (specs/cli.md#conventions, specs/behaviors/privacy.md): the complete,
 * uncapped result written as JSON, streamed, while stdout keeps the TOON view. The only way
 * session content leaves stdout, and only when the caller asks.
 */
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm, stat, type FileHandle } from "node:fs/promises";
import { AgentSessionError } from "../lib/errors.js";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { formatId } from "../lib/ids.js";
import type { EventId } from "../lib/model.js";
import type { Parsed } from "../flags.js";
import { renderDocument } from "../output/render.js";
import { collapseHome, type Io } from "./common.js";

export interface JsonOutTarget {
  /** The file to write; absent until the temp directory is made (only once the read succeeds). */
  path?: string;
  /** The caller's path (resolved), or none for a temp file. */
  given?: string;
  command: string;
  tmp: string;
}

const ownedBy = (st: { uid: number }) => typeof process.getuid !== "function" || st.uid === process.getuid();

/** A path the export may write: absent, or a regular file the current user owns, never a symlink. */
function refuse(given: string, why: string): never {
  throw new AxiError(`--json-out: ${collapseHome(given)} ${why}`, "VALIDATION_ERROR", [
    "name a new file or one of your own regular files (never a symlink), or pass a bare --json-out for an owner-only temp file",
  ]);
}

/** `--json-out` as given, validated before any log is read; undefined when not asked for. */
export async function jsonOutTarget(command: string, p: Parsed, io: Io): Promise<JsonOutTarget | undefined> {
  const v = p.flags.get("json-out");
  if (v === undefined) return undefined;
  const tmp = io.env.TMPDIR && io.env.TMPDIR.length ? io.env.TMPDIR : tmpdir();
  if (v === true) return { command, tmp };
  if (v === "") throw new AxiError("--json-out= needs a path after the =", "VALIDATION_ERROR", ["--json-out=out.json writes there; a bare --json-out writes an owner-only temp file"]);
  const given = resolve(io.cwd, v);
  let dir;
  try {
    dir = await stat(dirname(given));
  } catch {
    dir = undefined;
  }
  if (!dir?.isDirectory()) refuse(given, `cannot be written: the directory ${collapseHome(dirname(given))} does not exist`);
  let st;
  try {
    st = await lstat(given);
  } catch {
    st = undefined; // a new file
  }
  if (st?.isSymbolicLink()) refuse(given, "is a symlink");
  if (st && !st.isFile()) refuse(given, "is not a regular file");
  if (st && !ownedBy(st)) refuse(given, "belongs to another user");
  return { command, tmp, given, path: given };
}

/** The library fields that hold an event id (every other value is written as stored). */
const ID_FIELDS = new Set(["id", "result", "call", "turn", "first", "last", "continueTo", "summary", "compaction", "anchor"]);
/** Subtrees copied from the log as they are: a call input that looks like an id stays an object. */
const VERBATIM = new Set(["input", "raw"]);

const isEventId = (v: unknown): v is EventId => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.session === "string" && typeof o.seq === "number" && Object.keys(o).every((k) => k === "session" || k === "seq" || k === "block");
};

/** A value as the export prints it: the id fields as printed (`7a2f1c3e:418`), times as ISO strings. */
export function jsonValue(value: unknown, key?: string): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (key !== undefined && ID_FIELDS.has(key) && isEventId(value)) return formatId(value);
  if (Array.isArray(value)) return value.map((v) => jsonValue(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = VERBATIM.has(k) ? v : jsonValue(v, k);
  return out;
}

/** One JSON document `{...meta, "<key>": [items…]}` written item by item. */
export class JsonStream {
  private first = true;
  private buffer = "";

  constructor(private readonly fh: FileHandle) {}

  private async put(text: string): Promise<void> {
    this.buffer += text;
    if (this.buffer.length >= 1 << 16) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.buffer) return;
    const b = this.buffer;
    this.buffer = "";
    await this.fh.write(b);
  }

  async begin(meta: Record<string, unknown>, key: string): Promise<void> {
    const head = JSON.stringify(jsonValue(meta));
    await this.put(`${head.length > 2 ? `${head.slice(0, -1)},` : "{"}${JSON.stringify(key)}:[`);
  }

  async item(value: unknown): Promise<void> {
    await this.put(`${this.first ? "\n" : ",\n"}${JSON.stringify(jsonValue(value))}`);
    this.first = false;
  }

  async end(tail: Record<string, unknown> = {}): Promise<void> {
    const rest = JSON.stringify(jsonValue(tail));
    await this.put(`\n]${rest.length > 2 ? `,${rest.slice(1, -1)}` : ""}}\n`);
    await this.flush();
  }
}

/** An export being written: stream into it, then `close()` (its path) or `abort()` (removes it). */
export interface JsonSink {
  out: JsonStream;
  path: string;
  close(): Promise<string>;
  abort(): Promise<void>;
}

/**
 * Open the export file: a named path without following a symlink, checked again on the open
 * handle (regular, the user's) and only then truncated; or `<command>.json` created exclusively in
 * a new owner-only directory. Both owner-only.
 */
export async function openJsonOut(target: JsonOutTarget): Promise<JsonSink> {
  let path = target.path;
  let tempDir: string | undefined;
  if (!path) {
    tempDir = await mkdtemp(join(target.tmp, "agent-recall-axi-"));
    await chmod(tempDir, 0o700);
    path = join(tempDir, `${target.command.replace(/[^\w-]/g, "-")}.json`);
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (tempDir ? constants.O_EXCL : 0);
  let fh: FileHandle;
  try {
    fh = await open(path, flags, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    refuse(path, code === "ELOOP" ? "is a symlink" : `cannot be written (${code ?? "error"})`);
  }
  const st = await fh.stat();
  if (!st.isFile() || !ownedBy(st)) {
    await fh.close();
    refuse(path, "is not a regular file of your own");
  }
  await fh.truncate(0);
  await fh.chmod(0o600);
  const finalPath = path;
  let done = false;
  return {
    out: new JsonStream(fh),
    path: finalPath,
    async close() {
      done = true;
      await fh.close();
      return finalPath;
    },
    async abort() {
      if (done) return;
      done = true;
      await fh.close().catch(() => undefined);
      await rm(tempDir ?? finalPath, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Run `fill` into an open export; a failure removes the partial file (INTERNAL_ERROR naming it unless typed). */
export async function fillJsonOut(sink: JsonSink, fill: (out: JsonStream) => Promise<void>): Promise<string> {
  try {
    await fill(sink.out);
  } catch (err) {
    await sink.abort();
    if (err instanceof AxiError || err instanceof AgentSessionError) throw err;
    throw new AxiError(`--json-out: writing ${collapseHome(sink.path)} failed (${(err as Error)?.message ?? String(err)}); the partial file was removed`, "INTERNAL_ERROR", [
      "Re-run with --debug for details on stderr",
    ]);
  }
  return sink.close();
}

/** Open the export, stream into it, close it: for exports written after the view is built. */
export async function writeJsonOut(target: JsonOutTarget, fill: (out: JsonStream) => Promise<void>): Promise<string> {
  return fillJsonOut(await openJsonOut(target), fill);
}

/** The `json_out:` line, placed last before `help[]` (cli.md#conventions). */
export function withJsonOutLine(text: string, path: string): string {
  const line = renderDocument({ json_out: collapseHome(path) });
  const at = text.search(/^help\[\d+\]:/m);
  if (at === -1) return text.endsWith("\n") ? `${text}${line}\n` : `${text}\n${line}`;
  return `${text.slice(0, at)}${line}\n${text.slice(at)}`;
}
