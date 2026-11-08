/**
 * `--json-out[=path]` (specs/cli.md#conventions, specs/behaviors/privacy.md): the complete,
 * uncapped result written as JSON, streamed, while stdout keeps the TOON view. The only way
 * session content leaves stdout, and only when the caller asks.
 */
import { chmod, mkdtemp, open, stat, type FileHandle } from "node:fs/promises";
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
  if (!dir?.isDirectory()) {
    throw new AxiError(`--json-out: the directory ${collapseHome(dirname(given))} does not exist`, "VALIDATION_ERROR", ["name a file in an existing directory, or pass a bare --json-out for an owner-only temp file"]);
  }
  return { command, tmp, given, path: given };
}

const isEventId = (v: object): v is EventId => {
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  return typeof o.session === "string" && typeof o.seq === "number" && keys.every((k) => k === "session" || k === "seq" || k === "block");
};

/** A value as the export prints it: ids as printed (`7a2f1c3e:418`), times as ISO strings. */
export function jsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isEventId(value)) return formatId(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = jsonValue(v);
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

/** Open the export file (creating the owner-only temp directory when no path was given) and stream into it. */
export async function writeJsonOut(target: JsonOutTarget, fill: (out: JsonStream) => Promise<void>): Promise<string> {
  let path = target.path;
  if (!path) {
    const dir = await mkdtemp(join(target.tmp, "agent-session-axi-"));
    await chmod(dir, 0o700);
    path = join(dir, `${target.command.replace(/[^\w-]/g, "-")}.json`);
  }
  let fh: FileHandle;
  try {
    fh = await open(path, target.given ? "w" : "wx", 0o600);
  } catch (err) {
    throw new AxiError(`--json-out: cannot write ${collapseHome(path)} (${(err as NodeJS.ErrnoException).code ?? "error"})`, "VALIDATION_ERROR", ["name a writable file, or pass a bare --json-out for an owner-only temp file"]);
  }
  try {
    await fh.chmod(0o600);
    await fill(new JsonStream(fh));
  } finally {
    await fh.close();
  }
  return path;
}

/** The `json_out:` line, placed last before `help[]` (cli.md#conventions). */
export function withJsonOutLine(text: string, path: string): string {
  const line = renderDocument({ json_out: collapseHome(path) });
  const at = text.search(/^help\[\d+\]:/m);
  if (at === -1) return text.endsWith("\n") ? `${text}${line}\n` : `${text}\n${line}`;
  return `${text.slice(0, at)}${line}\n${text.slice(at)}`;
}
