/**
 * The normalized model (specs/data-model.md). Adapters produce these; nothing downstream of an
 * adapter reads the source JSON.
 */

export const KINDS = [
  "human",
  "human.queued",
  "human.slash",
  "human.answer",
  "assistant",
  "thinking",
  "call",
  "result",
  "compaction",
  "summary",
  "hook",
  "skill",
  "notice",
  "notice.task",
] as const;

export type Kind = (typeof KINDS)[number];
export type Authority = "H" | "C" | "D";

/** specs/behaviors/authority.md#classes */
export const AUTHORITY: Record<Kind, Authority> = {
  human: "H",
  "human.queued": "H",
  "human.slash": "H",
  "human.answer": "H",
  assistant: "C",
  thinking: "C",
  call: "C",
  summary: "C",
  result: "D",
  compaction: "D",
  hook: "D",
  skill: "D",
  notice: "D",
  "notice.task": "D",
};

/** Event listings show every kind except these unless `--kind` says otherwise. */
export const HIDDEN_BY_DEFAULT: readonly Kind[] = ["thinking", "result"];
export const DEFAULT_KINDS: readonly Kind[] = KINDS.filter((k) => !HIDDEN_BY_DEFAULT.includes(k));

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

export interface Project {
  /** The log directory (`<root>/<encoded>`). */
  dir: string;
  /** The encoded directory name. */
  encoded: string;
  /** The working directory the agent ran in; decoded from `encoded` only when no entry has `cwd`. */
  cwd: string;
  /** Whether `cwd` came from an entry (true) or the lossy name decoding (false). */
  cwdFromEntry: boolean;
  /** Count of `*.jsonl` directly in `dir`. */
  sessions: number;
}

export type SessionKind = "main" | "subagent";

export interface Session {
  /** uuid for a main session, agentId for a subagent session (from the filename). */
  id: string;
  /** `<s8>`: the first 8 characters of `id`. */
  short: string;
  kind: SessionKind;
  /** Parent session uuid (subagent only). */
  parent?: string;
  path: string;
  /** `<dir>/<id>/`; for a subagent, the parent's sidecar. May not exist. */
  sidecar: string;
  project?: Project;
  adapter: string;
}

export interface Entry {
  /** 1-based line number. */
  seq: number;
  /** Byte offset of the line's first byte. */
  offset: number;
  /** Source `type`, verbatim (undefined for malformed lines). */
  type?: string;
  uuid?: string;
  parentUuid?: string;
  /** ISO-8601 timestamp when present. */
  t?: string;
  sidechain?: boolean;
  /** The parsed line; undefined when malformed. */
  raw?: Record<string, unknown>;
  /** The line could not be parsed as a JSON object. */
  malformed?: boolean;
}

export interface EventId {
  /** `<s8>` */
  session: string;
  seq: number;
  /** 1-based content-block index, when the entry yields several events. */
  block?: number;
}

export interface Pointer {
  /** Absolute path of the persisted output (relocated into the session sidecar when needed). */
  path: string;
  /** The path as written in the stored notice. */
  stored: string;
  /** The size the notice reports, in bytes (`42.8KB` → 42800). */
  bytes: number;
  /** The stored preview text. */
  preview: string;
  /** Whether `path` is readable now. */
  exists: boolean;
}

/** A call's result status; rendered `ok 1.2k`, `error 340`, `persisted 42.8k`, `image`, `pending`. */
export interface CallStatus {
  state: "ok" | "error" | "persisted" | "image" | "pending";
  /** Characters of result text (`ok`/`error`) or the persisted size in bytes (`persisted`). */
  size?: number;
}

export interface Event {
  id: EventId;
  t?: string;
  kind: Kind;
  authority: Authority;
  /** Whole text, never cut by the library. */
  text: string;
  /** Length of `text` in characters. */
  size: number;
  tool?: string;
  target?: string;
  input?: unknown;
  /** `call`: the linked result's id once read. */
  result?: EventId;
  /** `call`: status of the linked result (`pending` until one is read). */
  status?: CallStatus;
  /** `result` / `human.answer`: the call's id when known. */
  call?: EventId;
  error?: boolean;
  pointer?: Pointer;
  /** Subagent session this event links to. */
  agent?: string;
  files?: string[];
  meta?: Record<string, unknown>;
  /** Source tool-use id (`toolu_…`); internal linkage key. */
  toolUseId?: string;
}

export interface SeqRange {
  /** Inclusive start seq. */
  from?: number;
  /** Exclusive end seq. */
  to?: number;
}
