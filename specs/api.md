# API: Library surface

What another program (first consumer: the opsbots kit's cold-start pack) imports from
`agent-session-axi`. The CLI in `cli.md` is a thin rendering of these functions; a behavior
available in the CLI and not here is a bug.

## Module

```ts
import {
  openRoot, listProjects, listSessions, resolveSession, openSession,
  events, around, next, prev, tail, turns, windows, compactions,
  humanMessages, toolCalls, find, recall, show, buildResumePack,
  parseId, formatId, parseWhen, parseSpan,
  type Session, type Event, type Turn, type Window, type Pointer, type ResumePack,
  type FindQuery, type Hit, type RecallResult, type Scope,
  AgentSessionError,
} from "agent-session-axi";
```

All functions are async or return async iterables; none writes to stdout, calls `process.exit`,
or reads flags. Time zone is an explicit argument wherever a time is rendered (the library returns
`Date`s and ISO strings; rendering belongs to the caller).

## Scope and sessions

```ts
interface Scope { root?: string; project?: string | "all"; cwd?: string; subagents?: boolean }

openRoot(opts?: { root?: string }): Promise<Root>            // ~/.claude/projects or CLAUDE_CONFIG_DIR
listProjects(scope?: Scope): AsyncIterable<Project>
listSessions(scope?: Scope, opts?: { since?: Date; from?: Date; to?: Date; limit?: number }): AsyncIterable<Session>
resolveSession(ref: string, scope?: Scope): Promise<Session>  // path | uuid | agentId | ≥8-hex prefix | "latest"
openSession(path: string): Promise<Session>                   // ignores scope
sessionStats(session: Session): Promise<SessionStats>         // turns, calls, compactions, humans, lines, bytes, last, title
```

`resolveSession` throws `AgentSessionError` with `code: "NOT_FOUND" | "AMBIGUOUS_SESSION" |
"NO_SESSIONS" | "VALIDATION_ERROR"`; `AMBIGUOUS_SESSION` carries `details.candidates`.

## Ids

```ts
interface EventId { session: string /* s8 */; seq: number; block?: number }
parseId(text: string): EventId | null                          // null when not an id
formatId(id: EventId): string                                  // "7a2f1c3e:418.2"
resolveId(text: string, scope?: Scope, opts?: { session?: string }): Promise<{ session: Session; id: EventId }>
                                                               // a bare "<seq>" only with opts.session
```

## Reading

```ts
interface ListOpts {
  kinds?: Kind[] | "all";          // default: all but thinking, result
  window?: number | "last" | "all" | `${number}..`;   // k.. runs to the end (behaviors/context-windows.md)
  from?: Date | EventId; to?: Date | EventId;   // half-open; ids select by position
  limit?: number;                  // 0 = unbounded
  newestLast?: boolean;            // default true when no `from`
}

events(session: Session, opts?: ListOpts): AsyncIterable<Event>
tail(session: Session, n: number, opts?: Pick<ListOpts, "kinds">): Promise<Event[]>
around(session: Session, id: EventId, before: number, after: number, opts?): Promise<{ rows: Event[]; anchor: EventId; atStart: boolean; atEnd: boolean }>
next(session: Session, id: EventId, n: number, opts?): Promise<{ rows: Event[]; atEnd: boolean }>
prev(session: Session, id: EventId, n: number, opts?): Promise<{ rows: Event[]; atStart: boolean }>
show(session: Session, id: EventId): Promise<Shown>           // the entry, its events, linkage, nearest ids
turns(session: Session, opts?: ListOpts): AsyncIterable<Turn>
windows(session: Session): Promise<Window[]>
compactions(session: Session): Promise<Event[]>               // kind "compaction", with meta + summary id
humanMessages(session: Session, opts?: ListOpts & { budget?: number }): Promise<{ messages: Event[]; matching: number; omitted: number; continueTo?: EventId; summary?: Event }>
toolCalls(session: Session, opts?: ListOpts & { name?: string; file?: string; errors?: boolean }): AsyncIterable<Event>
readPointer(pointer: Pointer, session: Session): Promise<{ text: string; exists: boolean; followed: boolean; reason?: string }>
linkedResult(session: Session, event: Event): Promise<Event | undefined>   // a call's result, a result's call
```

The pan results also carry `matching` (every visible event of the session, of the kinds asked)
and, when the anchor is not a visible event, `anchorNote` (`"silent"` or the hidden kind) with the
nearest visible ids in each direction. `opts` takes `kinds`; `around`/`next`/`prev` build or
extend the line-offset table (`architecture.md#cache`); `tail` never creates one, and uses one
that exists, extending it over an append of up to 8 MB (a larger append falls back to the
backward read).

`Shown` carries the `Entry` (with `raw`), the line count, the events the id selects (one for an
event id, all of them for a bare id of a multi-event entry, none for a silent entry) each with
its `turn`, `window`, linked `result` event and, for a compaction, the preserved-event count, and
the nearest event ids before and after a silent entry. An id past the end throws `NOT_FOUND`.

`cacheStatus(opts?)` lists the cache directory, its size and every indexed file with its state
(`fresh | appended | rewritten | missing`); `clearCache(opts?: { paths?: string[] })` deletes the
directory, or only the records whose stored path is one of `paths` or lies under one of them (a
project's log directory, so records of logs since deleted go too). Both swallow cache I/O failures.

`checkRewrite(path, opts?)` compares the file with the identity the cache recorded at the last
read (`behaviors/id-stability.md#append-only-is-assumed`) and returns `{ rewritten, since? }`.

`Event` is the type in `data-model.md#event`, with `text` uncut (the library never truncates;
callers render). `Event.result`/`Event.call` are ids; `linkedResult(session, call)` fetches the
partner.

## Searching

```ts
interface FindQuery {
  phrase?: string; regex?: boolean;
  file?: string;            // substring or glob
  tool?: string;            // substring
  kinds?: Kind[];
  from?: Date | EventId; to?: Date | EventId; window?: number | "last" | "all" | `${number}..`;
  context?: number | { before: number; after: number };
  limit?: number;
  deep?: boolean;           // search persisted-output files
}
interface Hit { event: Event; why: ("phrase" | "file" | "tool" | "kind")[]; context: Event[] }

find(session: Session, q: FindQuery): AsyncIterable<Hit>
findAcross(scope: Scope, q: FindQuery & { since?: Date }): AsyncIterable<Hit & { session: Session }>
recall(phrase: string, opts?: { scope?: Scope; since?: Date; regex?: boolean; file?: string; tool?: string; kinds?: Kind[]; limit?: number }):
  Promise<{ sessions: RecallResult[]; scanned: { sessions: number; bytes: number; ms: number; index: "fresh" | "partial" | "none" } }>
interface RecallResult { session: Session; hits: number; first: EventId; last: Date }
```

At least one of `phrase`, `file`, `tool`, `kinds` is required; otherwise `VALIDATION_ERROR`.

## Resume pack

```ts
interface ResumePackOpts { window?: number | "last"; budget?: number; tools?: number; claims?: number }
interface ResumePack {
  session: Session; window: { index: number; count: number };
  summary?: Event;            // C
  human: Event[];             // H, verbatim, oldest first
  tools: Event[];             // D-linked calls, newest last
  claims: Event[];            // C
  omitted: { human: number; continueTo?: EventId };
  budget: { used: number; limit: number };
}
buildResumePack(session: Session, opts?: ResumePackOpts): Promise<ResumePack>
```

Deterministic for a given file and options. The budget policy is the one in
`data-model.md#resume-pack`; the kit renders the pack itself or calls `renderResumePack(pack,
{ tz })` from the `agent-session-axi/render` subpath, which produces the CLI's exact TOON.

## Time grammar

```ts
parseWhen(text: string, opts: { now?: Date; tz: string; endOfDay?: boolean }): Date   // throws VALIDATION_ERROR
parseSpan(text: string): number                                                    // ms
```

Exposed so a caller can accept the same `--from/--to/--since` vocabulary as the CLI.

## Errors

```ts
class AgentSessionError extends Error {
  code: "USAGE" | "VALIDATION_ERROR" | "NOT_FOUND" | "AMBIGUOUS_SESSION" | "NO_SESSIONS" | "UNREADABLE" | "INTERNAL_ERROR";
  suggestions: string[];
  details?: Record<string, unknown>;
}
```

The CLI converts these to `AxiError` one-to-one.

## Stability

The library ships at `0.x`: the types above are the contract the first plan set builds to, and
breaking changes bump the minor version and are listed in the release notes. The whole surface,
and the `render` subpath in particular, is **unstable until the ops kit consumes it**; the first
kit release that imports it is what promotes the contract to stable (and starts the path to 1.0).
The `render` subpath follows the CLI's output rules exactly.

## Principles

**Inherited:**
- [Library first, CLI on top](principles.md#library-first-cli-on-top)
- [Deterministic output for the same file](principles.md#deterministic-output-for-the-same-file)
- [Human messages are the highest-authority record](principles.md#human-messages-are-the-highest-authority-record-and-the-tool-never-summarizes-them) — `humanMessages` and `ResumePack.human` are verbatim.
