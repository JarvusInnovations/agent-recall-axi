/**
 * The file-level work behind `hook` (specs/cli.md#hook): which entries are ours, shell quoting,
 * the Claude Code / Codex hooks JSON merge, the Codex `config.toml` feature flag, and atomic
 * writes that keep a file as it was written. No output, no flags.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { NAME } from "../invocation.js";

/** The file names this tool installs as a hook command (cli.md#hook). */
export const OUR_FILES = new Set([NAME, `${NAME}.js`, `${NAME}.mjs`]);
export const TIMEOUT_SECONDS = 10;

/**
 * The words of a simple shell command, or undefined when it is not simple (an unquoted
 * operator, expansion or glob character, or an unterminated quote): only a simple command can be
 * one this tool wrote.
 */
export function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === " " || c === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return undefined;
      word += command.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!;
        if (d === "$" || d === "`") return undefined;
        if (d === "\\" && j + 1 < command.length && '"\\$`'.includes(command[j + 1]!)) word += command[++j];
        else word += d;
      }
      if (j >= command.length) return undefined;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= command.length) return undefined;
      word += command[++i];
    } else if ("|&;<>()$`*?[]{}#~\n\r".includes(c)) {
      return undefined;
    } else word += c;
  }
  if (inWord) words.push(word);
  return words;
}

/** A command this tool could have written: one word, the bare name or an absolute path to one of OUR_FILES. */
export function isOurCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const words = shellWords(command);
  if (!words || words.length !== 1) return false;
  const w = words[0]!;
  return w === NAME || (w.startsWith("/") && OUR_FILES.has(basename(w)));
}

/** POSIX single-quoting, only when needed. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export class SettingsError extends Error {}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** A hooks JSON file as read: its document plus how it was written, so a rewrite keeps the layout. */
export interface JsonFile {
  exists: boolean;
  text: string;
  doc: Json;
  indent: string;
  eol: string;
  trailing: boolean;
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SettingsError(`cannot read: ${(err as Error).message}`);
  }
}

/** Read and shape-check a Claude Code / Codex hooks file (cli.md#hook); throws SettingsError. */
export function readHooksJson(path: string): JsonFile {
  const text = read(path);
  if (text === undefined) return { exists: false, text: "", doc: {}, indent: "  ", eol: "\n", trailing: true };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new SettingsError(`not valid JSON (${(err as Error).message})`);
  }
  if (!isObject(doc)) throw new SettingsError("the file is not a JSON object");
  if (doc.hooks !== undefined) {
    if (!isObject(doc.hooks)) throw new SettingsError("hooks is not an object");
    if (doc.hooks.SessionStart !== undefined && !Array.isArray(doc.hooks.SessionStart)) throw new SettingsError("hooks.SessionStart is not an array");
  }
  const indent = /^\{\r?\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
  return { exists: true, text, doc, indent, eol: text.includes("\r\n") ? "\r\n" : "\n", trailing: /\n$/.test(text) };
}

export function serializeJson(file: JsonFile, doc: Json): string {
  const body = JSON.stringify(doc, null, file.indent).replace(/\n/g, file.eol);
  return file.trailing ? `${body}${file.eol}` : body;
}

interface Entry {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}

function groupsOf(doc: Json): unknown[] {
  return isObject(doc.hooks) && Array.isArray(doc.hooks.SessionStart) ? doc.hooks.SessionStart : [];
}

/** The commands of our entries, in file order. */
export function ourCommands(doc: Json): string[] {
  const out: string[] = [];
  for (const g of groupsOf(doc)) {
    if (!isObject(g) || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) if (isObject(h) && isOurCommand(h.command)) out.push(h.command as string);
  }
  return out;
}

/** Our entry made exactly `command` (the first one repaired, any other removed); the new document and whether it changed. */
export function withOurEntry(doc: Json, command: string): { doc: Json; changed: boolean } {
  const next = structuredClone(doc);
  let changed = false;
  if (!isObject(next.hooks)) {
    next.hooks = {};
    changed = true;
  }
  const hooks = next.hooks as Json;
  if (!Array.isArray(hooks.SessionStart)) {
    hooks.SessionStart = [];
    changed = true;
  }
  const groups = hooks.SessionStart as unknown[];
  let found = false;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (!isObject(g) || !Array.isArray(g.hooks)) continue;
    const before = g.hooks.length;
    g.hooks = (g.hooks as unknown[]).filter((h) => {
      if (!isObject(h) || !isOurCommand(h.command)) return true;
      if (found) return false;
      found = true;
      const e = h as Entry;
      if (e.command !== command || e.type !== "command" || e.timeout !== TIMEOUT_SECONDS) {
        e.command = command;
        e.type = "command";
        e.timeout = TIMEOUT_SECONDS;
        changed = true;
      }
      return true;
    });
    if ((g.hooks as unknown[]).length !== before) {
      changed = true;
      if ((g.hooks as unknown[]).length === 0) groups.splice(gi--, 1);
    }
  }
  if (!found) {
    groups.push({ matcher: "", hooks: [{ type: "command", command, timeout: TIMEOUT_SECONDS }] });
    changed = true;
  }
  return { doc: next, changed };
}

/** Our entries removed, with any group, SessionStart array or hooks object that removal emptied. */
export function withoutOurEntries(doc: Json): { doc: Json; changed: boolean } {
  const next = structuredClone(doc);
  if (!isObject(next.hooks) || !Array.isArray(next.hooks.SessionStart)) return { doc, changed: false };
  const hooks = next.hooks;
  let changed = false;
  const kept: unknown[] = [];
  for (const g of hooks.SessionStart as unknown[]) {
    if (!isObject(g) || !Array.isArray(g.hooks)) {
      kept.push(g);
      continue;
    }
    const rest = (g.hooks as unknown[]).filter((h) => !(isObject(h) && isOurCommand(h.command)));
    if (rest.length === g.hooks.length) {
      kept.push(g);
      continue;
    }
    changed = true;
    if (rest.length) kept.push({ ...g, hooks: rest });
  }
  if (!changed) return { doc, changed: false };
  if (kept.length) hooks.SessionStart = kept;
  else {
    delete hooks.SessionStart;
    if (Object.keys(hooks).length === 0) delete next.hooks;
  }
  return { doc: next, changed: true };
}

/**
 * Write `text` to `path` atomically: a temp file in the target's directory renamed over it. A
 * symlinked target is written through (onto the file it points at), and an existing file's mode
 * is kept.
 */
export function atomicWrite(path: string, text: string): void {
  let target = path;
  let mode: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path);
    mode = statSync(target).mode & 0o7777;
  } catch {
    // a new file (or a dangling link, written as a new file at the path)
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: mode ?? 0o644 });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new SettingsError(`cannot write: ${(err as Error).message}`);
  }
}

export function readText(path: string): string | undefined {
  return read(path);
}

// ── Codex config.toml: the [features] hooks flag ──────────────────────────────────────────────

/** A dotted TOML key or header name as its segments, quotes removed. */
function keyPath(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const c of raw) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ".") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export interface FeaturesState {
  kind: "absent" | "plain" | "bad";
  reason?: string;
  /** The `[features]` header's line index. */
  header?: number;
  /** The last non-blank line of the features table. */
  end?: number;
  /** The `hooks = …` line inside it, and its value. */
  hooksLine?: number;
  hooks?: boolean;
}

const HEADER = /^\s*(\[\[?)\s*([^\]]*?)\s*(\]\]?)\s*(?:#.*)?$/;
const KEY = /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=(.*)$/;

/** How `features` is declared in a Codex config (cli.md#hook). */
export function featuresState(text: string): FeaturesState {
  const lines = text.split(/\r?\n/);
  let table: string[] | null = null; // null: the root table
  let state: FeaturesState = { kind: "absent" };
  const bad = (reason: string): FeaturesState => ({ kind: "bad", reason });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const h = HEADER.exec(line);
    if (h) {
      const path = keyPath(h[2]!);
      if (path[0] === "features") {
        if (h[1] === "[[") return bad("features is declared as an array of tables ([[features]])");
        if (path.length > 1) return bad(`features has a sub-table ([${h[2]}])`);
        if (state.kind === "plain") return bad("[features] is declared twice");
        state = { kind: "plain", header: i, end: i };
      }
      table = path;
      continue;
    }
    const k = KEY.exec(line);
    if (!k) continue;
    const path = keyPath(k[1]!);
    if (table === null && path[0] === "features") return bad("features is declared as a top-level key (a dotted key or an inline table)");
    if (table !== null && table.length === 1 && table[0] === "features") {
      state.end = i;
      if (path[0] === "hooks") {
        if (path.length > 1) return bad("features.hooks is not a boolean");
        const v = /^\s*(true|false)\s*(?:#.*)?$/.exec(k[2]!);
        if (!v) return bad("features.hooks is not true or false");
        if (state.hooksLine !== undefined) return bad("features.hooks is set twice");
        state.hooksLine = i;
        state.hooks = v[1] === "true";
      }
    }
  }
  return state;
}

/** The config with `[features] hooks = true`, or SettingsError when features is not absent or plain. */
export function withCodexHooksFeature(text: string): { text: string; changed: boolean } {
  const st = featuresState(text);
  if (st.kind === "bad") throw new SettingsError(st.reason!);
  if (st.kind === "plain" && st.hooks === true) return { text, changed: false };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let next: string;
  if (st.kind === "absent") {
    if (!text.trim()) next = `[features]${eol}hooks = true${eol}`;
    else next = `${text}${/\n$/.test(text) ? "" : eol}${eol}[features]${eol}hooks = true${eol}`;
  } else {
    const lines = text.split(/\r?\n/);
    if (st.hooksLine !== undefined) lines[st.hooksLine] = lines[st.hooksLine]!.replace(/=(\s*)false/, "=$1true");
    else lines.splice(st.end! + 1, 0, "hooks = true");
    next = lines.join(eol);
  }
  // The result must hold exactly one plain [features] table with hooks = true.
  const check = featuresState(next);
  if (check.kind !== "plain" || check.hooks !== true) throw new SettingsError("the updated config did not validate");
  return { text: next, changed: true };
}

/** `[features] hooks = true` is set in this config text. */
export function codexHooksEnabled(text: string | undefined): boolean {
  if (text === undefined) return false;
  const st = featuresState(text);
  return st.kind === "plain" && st.hooks === true;
}
