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
resolveId(text: string, scope?: Scope): Promise<{ session: Session; id: EventId }>
```

## Reading

```ts
interface ListOpts {
  kinds?: Kind[] | "all";          // default: all but thinking, result
  window?: number | "last" | "all";
  from?: Date | EventId; to?: Date | EventId;   // half-open; ids select by position
  limit?: number;                  // 0 = unbounded
  newestLast?: boolean;            // default true when no `from`
}

events(session: Session, opts?: ListOpts): AsyncIterable<Event>
tail(session: Session, n: number, opts?: Pick<ListOpts, "kinds">): Promise<Event[]>
around(session: Session, id: EventId, before: number, after: number, opts?): Promise<{ rows: Event[]; anchor: EventId; atStart: boolean; atEnd: boolean }>
next(session: Session, id: EventId, n: number, opts?): Promise<{ rows: Event[]; atEnd: boolean }>
prev(session: Session, id: EventId, n: number, opts?): Promise<{ rows: Event[]; atStart: boolean }>
show(session: Session, id: EventId, opts?: { full?: boolean; followPointer?: boolean }): Promise<Event | Event[] | RawEntry>
turns(session: Session, opts?: ListOpts): AsyncIterable<Turn>
windows(session: Session): Promise<Window[]>
compactions(session: Session): Promise<Event[]>               // kind "compaction", with meta + summary id
humanMessages(session: Session, opts?: ListOpts & { budget?: number }): Promise<{ messages: Event[]; omitted: number; continueTo?: EventId; summary?: Event }>
toolCalls(session: Session, opts?: ListOpts & { name?: string; file?: string; errors?: boolean }): AsyncIterable<Event>
readPointer(pointer: Pointer): Promise<{ text: string; exists: boolean }>
```

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
  from?: Date | EventId; to?: Date | EventId; window?: number | "last";
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

The library is pre-1.0; the types above are the contract the first plan set builds to. Breaking
changes bump the minor version until 1.0 and are listed in the release notes. The `render`
subpath is provided for the kit's convenience and follows the CLI's output rules exactly.

## Principles

**Inherited:**
- [Library first, CLI on top](principles.md#library-first-cli-on-top)
- [Deterministic output for the same file](principles.md#deterministic-output-for-the-same-file)
- [Human messages are the highest-authority record](principles.md#human-messages-are-the-highest-authority-record-and-the-tool-never-summarizes-them) — `humanMessages` and `ResumePack.human` are verbatim.
