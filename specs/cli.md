# CLI

The command surface of `agent-recall-axi`. Every command is a rendering of a library function
(`api.md`); output follows `behaviors/row-format.md`, caps follow `behaviors/truncation.md`, time
and scope grammar follow `behaviors/time-and-scope.md`, errors follow `behaviors/errors.md`.

## Conventions

- Shape: `agent-recall-axi <command> [args] [flags]`. Flags come after the command (the SDK
  rejects leading flags). `--x v` and `--x=v` both work; `--` ends flags.
- The one global flag is `--tz <iana>`. `--help`/`-h` is always accepted.
- Every command that resolves a `<session>` or an `<id>` (`turns`, `events`, `human`, `tools`,
  `find`, `around`/`next`/`prev`, `tail`, `show`, `compactions`, `resume-pack`) also accepts
  `--project <p>` or `--all`, which widen the scope the reference resolves in
  (`behaviors/time-and-scope.md#which-sessions-session---project---all`); a path ignores them.
- Every command declares its flags; unknown ones fail with the valid set inline.
- Listing flags shared by all row commands: `--limit <n>`, `--kind <a,b|all>`, `--head <n>`,
  `--full`, `--fields <a,b>`, `--json-out[=path]`, `--window <k|last|all>`, `--from`, `--to`,
  `--since`.
- `--json-out[=path]` writes the complete, uncapped result as JSON to `path` (or an owner-only
  temp file whose path is printed) while stdout keeps the TOON view. There is no JSON stdout mode.
  The path is given only with `=` (`--json-out=out.json`; a bare `--json-out` means the temp
  file). A bare `--json-out` followed by an argument ending in `.json` is `USAGE` saying to write
  `--json-out=<that>`. The result is the library's (`api.md`): every row the filters match with no
  `--limit`, budget or head cut, the id fields the library returns (`id`, `result`, `call`,
  `turn`, `first`, `continueTo`, `summary`, `compaction`) as printed (`7a2f1c3e:418`) and
  everything else as stored (a call input is never rewritten), times as ISO-8601 UTC, streamed to
  the file item by item (never held whole). A command whose view already reads every matching item
  (`turns`, `tools`, `find`, a cross-session `find`) writes the export during that one read; one
  whose view reads only part of the log (`events`' newest rows, `human`'s budget) reads it once
  more for the export. A given path is resolved against the working directory and opened before any log is
  read: created owner-only (`0600`) or truncated, never through a symlink, and refused
  (`VALIDATION_ERROR`) when it is not a regular file owned by the current user or its directory
  does not exist. The temp file is `<command>.json`, created exclusively in a new owner-only
  (`0700`) directory under the system temp directory (`TMPDIR`). A failure while writing removes
  the partial file and is `INTERNAL_ERROR` naming the path. The output names the file in a
  `json_out:` line, the last before `help[]`.
- Single-session headers (`session: <s8> <title>`, `scope: <s8> <title>`) take the title from the
  cheap sources only, so they depend on the file and its sidecar, never the cache: the
  `custom-title.json` sidecar, else the `sessions-index.json` entry whose `fileMtime` matches the
  file, else the first `human` event in the file's first 1 MB, else `(untitled)`; one line, cut
  to the row head. `sessions`, `search`, `resume-pack` and `AMBIGUOUS_SESSION` candidates use the
  full precedence (`data-model.md#session`).
- Default `--limit` values are chosen so the common case fits in one call; the header always
  carries `count: <shown> of <matching>` and the footer the way to see more.
- Examples below use the synthetic session `7a2f1c3e` and generic paths. Output examples are
  illustrative of shape, not literal fixtures.
- A hint names a session by its `<s8>` only when no other session in scope shares those 8
  characters; otherwise by its full id (`tail <uuid>`, `show <id> --session <uuid>`), so every
  hint resolves as printed.
- Hints and suggested commands name the tool `agent-recall-axi`. Run from the skill bundle,
  which is not on `PATH`, they name it by the shim's path instead (`~/` for the home directory,
  with only the rest shell-quoted when it needs quoting, `~/'my skills/…'`, so the `~` still
  expands; the same for every path a hint carries), unless `agent-recall-axi` on `PATH` resolves to that shim or bundle; the
  npm bin is on `PATH` by installation and keeps the bare name.
- `help[]` lines carry forward `--project`/`--all`/`--tz` when they were given, and a paging hint
  (`next`/`prev`/`--from`/`--to` continuations) also carries the caller's `--kind`, `--limit`,
  `--head`, `--full` and the bounding `--to`, so the next page shows the same view of the range.

## Zoom ladder

```
sessions                 which sessions exist                    (zoomed out)
turns <session>          one row per human prompt
events / tail / around / next / prev   rows                       (pan)
show <id>                one entry, whole                         (zoom in)
show <id> --full         ...with persisted output followed
```

`find` and `search` enter the ladder at any rung; `human`, `tools`, `compactions` are kind-scoped
views of the rows rung; `resume-pack` is a fixed composite for cold starts.

---

## Home view (no arguments)

Content first: the sessions of the current project and where the latest one left off.

```
bin: ~/.local/bin/agent-recall-axi
description: Read, search and pan/zoom through agent session logs; TOON out, local files only
project: ~/src/widget (12 sessions)
sessions[5]{id,last,turns,title}:
  7a2f1c3e,3m ago,14,fix auth redirect loop
  91b0c4d2,2h ago,6,add pagination to listings
  ...
latest: 7a2f1c3e
last_human: 7a2f1c3e:4102 14:02:11 "ok ship it, then update the plan file"
help[5]:
  Run `agent-recall-axi resume-pack 7a2f1c3e` for a cold-start pack of the latest session
  Run `agent-recall-axi tail 7a2f1c3e` for the last 20 rows
  Run `agent-recall-axi find "<phrase>"` to search this project's sessions
  Run `agent-recall-axi search "<phrase>"` to search every project
  Run `agent-recall-axi --help` for the full command list, or `agent-recall-axi <command> --help` for usage on any command
```

- With no log directory for the working directory: `project: none for <cwd>` and
  `sessions: none in this directory`, with hints to `sessions --all`, `sessions --project <path>`
  and `search "<phrase>"`, and nothing read from other projects. The home view is what the
  SessionStart hook injects, so it stays scoped to the working directory (AXI §7): another
  project's sessions are context the agent did not ask for.
- Must complete in under 300 ms on a project with 100 sessions: it reads `sessions-index.json`
  when present and otherwise stats files and reads only the tail of the latest one. It never scans
  a whole file.
- Sessions are main sessions ordered by file modification time, newest first; `latest` is the
  first (as `latest` resolves). Each row takes its values from the cheapest source that has them:
  the cache's session stats when they match the file, or when extending them over an append fits
  the listing's budget of 8 MB of appended lines in total (exact, as `sessions` prints them); else
  the file's mtime as `last` (the matching `sessions-index.json` entry's `modified` when there is
  one) and, as `title`, `custom-title.json`, else that index entry's `summary`, else the first
  `human` event in the file's first 1 MB; `turns` is `?` without stats (unknown, never an empty cell that reads like a missing value). `last` prints as in
  `sessions` (absolute plus relative).
- `last_human` is the newest `H`-class event in the latest session's final 4 MB, read backwards
  (`<id> <time> "<head>"`, the time `HH:MM:SS` on today's local date and `MM-DD HH:MM:SS`
  otherwise); its line number comes from the cache (the stats mirror or a table checkpoint at or
  before it, counting only the bytes after that point). When the cache cannot number it, the id is
  left out (`<time> "<head>"`) and the `tail <s8>` hint says it prints the rows with their ids;
  the home view never reads or counts a whole file. `last_human: none` when the session has no
  human message, and `none in the last 4M` when the read stopped at that bound.
- **Hook mode.** When stdin is not a TTY and carries a SessionStart hook payload (JSON with
  `session_id` and `source`), the home view adapts: `source: compact` or `resume` prints
  `resume-pack <that session> --budget 6000` instead of the listing (under the same `bin` and
  `description` header, then the pack's exact bytes); `startup`/`clear` print the
  listing above. This is how an agent that just lost its context gets it back without asking.
  The read of stdin is bounded so the home view never hangs on a pipe nobody writes to: it
  stops as soon as the bytes read parse as one JSON object, at end of input, at 64 KB, when no
  byte has arrived within 200 ms, or 1 s after the first byte. Anything else prints the listing,
  never an error: an empty or non-JSON stdin, a payload without `source` or `session_id`, a
  `session_id` that is not a session id, and one that does not resolve in the working
  directory's scope (another agent's session, for instance).

---

## `sessions`

```
agent-recall-axi sessions [--project <p> | --all] [--since <span>] [--from <when>] [--to <when>]
                           [--limit <n>] [--subagents] [--fields <a,b>] [--json-out[=path]]
```

Sessions in scope, most recently active first.

Default schema: `sessions[N]{id,last,turns,title}` — four columns (AXI §2) — `id` is `<s8>`; `last`
is `MM-DD HH:MM` plus a relative suffix (`11-07 14:02 (3m ago)`); `turns` is the human-prompt
count; `title` per `data-model.md#session`.

Extra fields: `started` (`MM-DD HH:MM`), `uuid`, `path`, `project`, `bytes`, `lines`, `calls`, `compactions`, `humans`,
`live`, `kind`, `parent`, `model`.

- Default `--limit 20`. Default time window: none (all sessions in scope); `--since 7d` is the
  typical narrowing. The window selects sessions by `last`.
- Order and `last` are exact, so every session in scope has its stats computed (one streaming
  pass per session on first touch, cached; `data-model.md#session`). One unreadable file is
  skipped and counted (`behaviors/errors.md`).
- `--subagents` includes subagent sessions, with `kind` and `parent` in the default schema.
- Empty: `sessions: 0 sessions in ~/src/widget` (exit 0), hint `--all`.
- Footer hints: `turns <id>`, `resume-pack <id>`, `find --project … "<phrase>"`.

## `turns <session>`

```
agent-recall-axi turns <session> [--from <when|id>] [--to <when|id>] [--since <span>]
                        [--window <k|last>] [--limit <n>] [--full] [--json-out[=path]]
```

One row per human prompt: the mid-zoom rung.

Default schema: `turns[N]{id,t,prompt,ended}` (`data-model.md#turn`): four columns (AXI §2).
`prompt` is the head of the opening human text; `ended` is `stop`, `compaction` or `open`, the
column that keeps an agent from assuming a turn cut short by a compaction finished. `--full` adds
`events` and `calls` (the turn's event and tool-call counts).

- Default `--limit 30`, newest last; when more exist the footer says `Showing the last 30 of 112
  turns; raise --limit or narrow with --from`, followed by the runnable `turns <session> --to <first-shown-id>`
  continuation for the earlier ones.
- Turn 0 (events before the first prompt) is listed only when non-empty, with `prompt` `(session
  start)` and its first event's id.
- `--from`/`--to`/`--since`/`--window` select turns by their opening prompt (turn 0 by its first
  event); a selected turn is counted whole, past the bound if it runs on. `--full` lifts the
  prompt head cap and the row cap.
- Empty: `turns: 0 turns in 7a2f1c3e (4,120 lines)`, exit 0.
- Footer hints: `next <turn-id>` to read a turn's rows, `human <session>` for the prompts whole.

## `events <session>`

```
agent-recall-axi events <session> [--from <when|id>] [--to <when|id>] [--since <span>]
                         [--window <k|last>] [--kind <a,b|all>] [--limit <n>] [--head <n>] [--full]
                         [--fields <a,b>] [--json-out[=path]] [--project <p> | --all]
```

Rows of a session, in file order: the general range command that `tail`, `around`, `next` and
`prev` are conveniences over.

Default schema: `events[N]{id,t,kind,text}`. Default `--limit 40`, newest last unless `--from` is
given (then oldest first from that point). Default kinds: all but `thinking` and `result`.

- `--from <id> --to <id>` selects by position; with `<when>` values, by time.
- `--fields <a,b>` adds columns after `text`: `authority` (`H|C|D`, `behaviors/authority.md`),
  `size`, `tool`, `target`, `result`, `call`, `error`; a cell the event does not have is empty.
- With `--limit 0 --full` the header carries `size: 1.8M chars` before any rows.
- Footer: `prev <first-id>` / `next <last-id>` to continue, `show <id>` to zoom, the truncation
  note when heads were cut.

## `human <session>`

```
agent-recall-axi human <session> [--from <when|id>] [--to <when|id>] [--since <span>]
                        [--window <k|last>] [--budget <chars>] [--full] [--rows]
                        [--json-out[=path]]
```

Every `H`-class event, verbatim, in order: what the human asked for. The thing a cold start needs.

Default output is not a row table: each message is a block, because the text is the point.

```
session: 7a2f1c3e fix auth redirect loop
authority: H (verbatim)
tz: America/New_York
count: 9 of 9 human messages
messages[9]:
  - id: 7a2f1c3e:12
    t: 11-07 13:40:02
    kind: human
    text: |
      the login page loops back to itself after the callback...
  - id: 7a2f1c3e:388
    t: 11-07 13:52:41
    kind: human.queued
    text: also check the staging config while you're in there
  ...
```

- Includes `human`, `human.queued`, `human.slash`, `human.answer`; never `summary`, `skill`,
  `hook`, `notice`. The opening `summary` of a window is printed after the messages, under its own
  `summary:` key with `authority: C`, when `--window` selects a window that begins with one.
- Default `--budget 12000` chars, newest kept; `omitted: "7 earlier messages; continue with
  human 7a2f1c3e --to 7a2f1c3e:388"` when it bites (TOON quotes the value: it holds a `:`).
  `--full` or `--budget 0` lifts the budget. The budget is 12,000
  chars of text in total, the window's opening summary included: the summary is `C` text, capped
  at 4,000 chars with the house marker and a `show <summary-id> --full` hint, and its printed
  length counts first; the newest message is always printed, whole, even when it alone exceeds
  the budget (`H` text is never cut), and older ones are kept newest first while they fit, so the
  omitted messages are always the oldest. `omitted:` is the last header line, before the
  messages. The continuation carries the caller's
  `--from`/`--since`/`--window`, `--budget`, `--rows`, scope and `--tz`.
- `--rows` switches to the standard row table for a dense overview (the same messages, the same
  budget; row heads are cut as in any listing).
- Empty: `messages: 0 human messages in 7a2f1c3e` (a pure subagent run, for example), exit 0.

## `tools <session>`

```
agent-recall-axi tools <session> [--name <tool>] [--file <pattern>] [--errors]
                        [--from <when|id>] [--to <when|id>] [--since <span>] [--window <k|last>]
                        [--limit <n>] [--full] [--fields <a,b>] [--json-out[=path]]
```

Tool calls with their results folded in.

Default schema: `tools[N]{id,tool,target,result}`: four columns (AXI §2); order lives in the
ids — `result` is the status (`ok 1.2k`, `error 340`, `persisted 42.8k`, `image`, `pending`).

- `--name` is a case-insensitive substring of the tool name (`--name bash`, `--name mcp__`).
- `--file` filters by `files` touched (`data-model.md#files-touched`).
- `--errors` keeps only calls whose result `is_error`.
- `--fields <a,b>` adds columns after `result`: `t` (the call's time), `result_id` (the linked result's id), `error`,
  `files` (joined with `, `; `show <id>` has the exact list).
- Default `--limit 30`, newest last. `--full` adds the full input JSON and the result text to each
  row as a block (switches to block form like `human`), lifts the row cap, and prints a
  persisted output's file in place of its preview when it may be followed
  (`data-model.md#pointer`).
- Footer: `show <id>` for a call, `show <result-id> --full` to read a persisted output.
- Empty: `tools: 0 tool calls match in 7a2f1c3e`.

## `find`

```
agent-recall-axi find [<session>] [<phrase>] [--regex] [--file <pattern>] [--tool <name>]
                       [--kind <a,b|all>] [--from <when|id>] [--to <when|id>] [--since <span>]
                       [--window <k|last>] [--context <n>] [--before <n>] [--after <n>]
                       [--limit <n>] [--head <n>] [--full] [--fields <a,b>]
                       [--project <p> | --all] [--deep] [--json-out[=path]]
```

Search one session, the project, or everything, by any combination of handles. Each hit row says
why it matched.

- Positionals: with two, they are `<session>` then `<phrase>`. With one, it is `<session>` when it
  has a session reference's form (it contains `/`, starts with `.` or `~`, ends in `.jsonl`, is a
  hex string of at least 8 characters, a uuid, or `latest`; `data-model.md#session-reference`)
  and `<phrase>` otherwise. A phrase of that form is searched by naming the session first
  (`find latest 7a2f1c3e`).
- The handles combine with AND: a hit satisfies every one given. `why` names the handles given,
  in the fixed order `phrase`, `file`, `tool`, `kind`, joined with `+`.
- Searched kinds are the kinds an `events` listing shows: the `--kind` set when given (`all` is
  every kind), else every kind but `thinking` and `result`. A tool's output is searched through its call: a `call`
  matches a phrase in its linked result's text, so the hit is the call row (whose status already
  rides on it) and `show <call>` prints both. When `result` is among the searched kinds
  (`--kind result`, `--kind all`), results are searched as rows of their own and calls no longer
  match their results' text.
- `<phrase>`: case-insensitive substring over the `text` of every searched event and, for a
  `call`, over its input (stringified, and each string value as stored) and its result's text;
  `--regex` treats it as a JavaScript regular expression compiled with the `iu` flags
  (case-insensitive, Unicode: `\p{L}` works). An invalid pattern (including one invalid only
  under `u`) is `VALIDATION_ERROR`. The guard refuses the common exponential shapes, also
  `VALIDATION_ERROR`: an unbounded repetition (`*`, `+`, `{n,}`) of a group that itself holds an
  unbounded quantifier or an alternation whose branches can match overlapping text (`(a+)+`,
  `(a*)*`, `(a|ab)*`, `(\w+\s?)*`), and a run of 12 or more consecutive optional atoms
  (`a?a?a?…`). Bounded repetition (`(\d+\.){3}`) and alternations of distinct literals
  (`(foo|bar)+`) pass. A pattern that is merely slow is the caller's responsibility (#8).
- `--file <pattern>`: matches `files` touched; substring, or glob when the pattern contains `*`,
  `?` or `[` (a glob matches the whole path and its `*` and `?` match `/` too, so `*.env` matches
  `config/staging.env`). Case-sensitive, as paths are.
- `--tool <name>`: case-insensitive substring of the tool name; alone, it lists every call of that
  tool.
- `--kind`: restrict to kinds (e.g. `--kind human` is "what did the human say about X").
- At least one of `<phrase>`, `--file`, `--tool`, `--kind` is required (`code: USAGE`).
- Without `<session>`, scope is the current project (`--project` to pick, `--all` for every
  project); hits print `<s8>:<seq>` ids as always, and the header lists the sessions scanned.
  With `<session>`, `--project`/`--all` only widen where the reference resolves.
- `--deep` also searches persisted-output files for the phrase (slow; off by default; the header
  says `deep: yes` when on). Only a pointer that may be followed is read (`data-model.md#pointer`,
  containment); any other is searched by its stored preview alone. The file is streamed in
  chunks, never held whole: a substring may span chunks, but a `--regex` is tested line by line,
  so a regex match that spans lines of a persisted file is not found there (a line longer than
  1 MB is tested in 1 MB pieces).
- `--from`/`--to`/`--since` bound the search by position or time
  (`behaviors/time-and-scope.md`); `--head`, `--full` and `--fields` shape rows as in `events`.

Output: `hits[N]{id,t,kind,why,text}` where `why` is `phrase`, `file`, `tool`, `kind`, or a
combination joined with `+`; with `--context n` (default 1) each hit is followed by its
surrounding rows with `why` empty, and the table is labeled `rows` instead of `hits`. The hit row
is the one with a non-empty `why`. Default `--limit 20` hits.

- Context rows are drawn from the searched kinds and counted over them (a hidden `thinking` or
  `result` between two hits takes no slot). `--before`/`--after` set one side and override that
  side of `--context`; when both sides are 0 the table is `hits`.
- A row prints once even when it falls in the context of several hits, or is itself a hit inside
  another hit's context; rows stay in file order. A row that is a hit carries its `why` even when
  it is printed only as context of a shown hit (it lies past `--limit`).
- When more hits match than `--limit` shows, the footer carries the same query continued from the
  event after the last hit shown (`--from <id>`).

```
scope: 7a2f1c3e fix auth redirect loop
query: phrase "redirect" + file *.env*
count: 3 of 3 hits (4,120 lines scanned)
rows[9]{id,t,kind,why,text}:
  7a2f1c3e:410,13:58:01,assistant,,Checking the callback URL the server is configured with…
  7a2f1c3e:412.2,13:58:04,call,phrase+file,Read config/staging.env → ok 1.1k
  7a2f1c3e:415,13:58:09,assistant,,The redirect URI in staging.env still points at the old host…
  ...
help[3]:
  Run `agent-recall-axi around 7a2f1c3e:412.2 --before 10 --after 10` for more context
  Run `agent-recall-axi show 7a2f1c3e:412.2` for the whole call and result
  Run `agent-recall-axi find "redirect" --all` to search every project
```

- Empty: `hits: 0 events match phrase "redirect" in 7a2f1c3e (4,120 lines scanned)`, exit 0,
  with hints to drop a filter or widen scope.
- Cross-session scans report `scanned: 12 sessions, 38.4 MB` and respect `--since` (default none
  for a project, 90 days for `--all`).
- **Cross-session** (no `<session>`): every main and subagent session in scope is searched, newest
  file modification time first, each in file order, with the single-session rules; hits are
  counted across all of them and the first `--limit` printed. `--since`/`--from`/`--to` bound
  events by time as for one session, and a session whose file was last modified before the
  window's start is not read (no entry can be newer than the write that stored it); a defaulted
  window prints `since: 90d (the --all default)`. An id is a position in one session, so an id
  given to `--from`/`--to` here is `VALIDATION_ERROR` with a hint to name its session. The header
  opens `scope: <project cwd> (project)` or `scope: all projects`, then `query:`, `scanned:`,
  `count: <shown> of <n> hits`; an unreadable file is skipped and counted. Hints name sessions
  as everywhere (`<s8>` unless shared in scope) and carry the scope flag; past `--limit` the
  footer continues the last shown hit's session (`find <s8> … --from <id>`) and offers
  `--limit 0` for every hit. Empty: `hits: 0 events match <query> in <scope> (12 sessions,
  38.4 MB scanned)`, with a hint to widen (`--all`, or `--since 1y` under `--all`).
- The single-session footer carries `find <query> --all` (the same handles, `--tz`, never an id
  bound) unless the search was already across every project.

## `around <id>` · `next <id>` · `prev <id>`

```
agent-recall-axi around <id> [--before <n>] [--after <n>] [--context <n>] [--kind …] [--head <n>] [--full]
                         [--fields <a,b>] [--window <k|last>] [--session <ref>] [--project <p> | --all]
agent-recall-axi next <id> [<n>] [--limit <n>] [--kind …] [--head <n>] [--full] [--fields <a,b>]
                       [--window <k|last>] [--session <ref>] [--project <p> | --all]
agent-recall-axi prev <id> [<n>] [--limit <n>] [--kind …] [--head <n>] [--full] [--fields <a,b>]
                       [--window <k|last>] [--session <ref>] [--project <p> | --all]
```

The pan verbs. Same rows as `events`; the difference is where they start.

- `around`: `--before 5 --after 5` by default; the anchor row is included and marked by a header
  line `anchor: <id>`. `--context <n>` sets both sides; an explicit `--before` or `--after`
  overrides its side. Output label `rows`.
- `next`: the `n` visible events after the anchor (exclusive), default 20; `prev`: the `n` before,
  default 20, printed in file order. The optional positional `<n>` equals `--limit` (both given and
  different: `code: USAGE`). `--full` without an `n` lifts the row cap, as on `events`. Output
  labels `next` and `prev`.
- Counts are over visible events (`--kind` applies before counting).
- A bare entry id of an entry that yields several events anchors on the whole entry: `around`
  shows every visible block of it as the anchor, `next`/`prev` start after/before all of them.
- Header: `session:`, `anchor: <id>`, `day:`/`days:`, `tz:`, and `count: <shown> of <matching>`
  where `<matching>` is every visible event of the session (of the kinds shown); it is printed
  even when no rows are (`count: 0 of 4120`).
- Starting from a silent entry or a hidden-kind event is fine: travel begins at the nearest
  visible event in the direction of travel, and the header says so in `anchor_note:` (for example
  `silent entry, not shown; travel starts at the nearest visible event (7a2f1c3e:416)`, or
  `thinking (not a shown kind), not shown; …`). `show` of the anchor still works.
- Footer: the exact continuation in both directions using the edge ids
  (`next 7a2f1c3e:431`, `prev 7a2f1c3e:402`), carrying the caller's `--kind`, `--head`, `--full`,
  `--fields` (and, for `next`/`prev`, an explicit `n` as `--limit`), and `show <anchor>`. When a
  direction is exhausted the header carries `at_end: true` / `at_start: true` (a header field, not
  an error) and the footer omits that direction's continuation.
- Empty: `next: 0 events after 7a2f1c3e:431 (at end of session)` (and the `prev` mirror), exit 0.
- `<id>` may be a bare `<seq>` only with `--session <ref>`; listings never print that form. An id
  past the end of the file is `code: NOT_FOUND` with a `tail` hint, as for `show`.
- These commands seek through the cache's line-offset table (`architecture.md#cache`), building
  it on first use; a session they read is indexed afterwards.

## `tail <session>`

```
agent-recall-axi tail <session> [<n>] [--limit <n>] [--kind …] [--head <n>] [--full] [--fields <a,b>]
                       [--window <k|last>] [--project <p> | --all]
```

The last `n` visible rows (default 20): "what was I doing". Equivalent to `events <session>` with
the default limit, kept as a verb because it is the most common call. Footer: `prev <first-id>`,
`resume-pack <session>`.

`tail` and the default `events` never create the offset table (a `--window` selection is a seek
and does, `behaviors/context-windows.md`). When one already exists (a pan
command or `show` built it), they extend it over an append of up to 8 MB and read their rows
forwards from the checkpoint before the window, the same engine as `prev` from the end, so the
rows and the exact count `count: 20 of 4120` always agree. Without a table (or when more than
8 MB was appended since it was built) they read the file backwards and the header says
`count: 20 (newest; earlier rows exist)` unless the read reached the file start.

## `show <id>` (alias: `zoom`)

```
agent-recall-axi show <id> [--full] [--raw] [--fields <a,b>] [--session <ref>] [--project <p> | --all]
```

One entry or one event, whole. The zoom.

Detail view, block form; no `help[]` unless something was truncated or a pointer exists.

```
event: 7a2f1c3e:412.2
t: 2026-11-07 13:58:04 America/New_York
kind: call
authority: C
turn: 7a2f1c3e:388
window: 1
tool: Read
target: config/staging.env
input:
  file_path: config/staging.env
result: 7a2f1c3e:413
result_status: ok 1.1k
result_text: "1\tAPP_HOST=staging.example.test\n2\tOAUTH_REDIRECT=https://old.example.test/callback\n…"
uuid: 3c04f2b0-…
help[1]:
  Run `agent-recall-axi show 7a2f1c3e:413 --full` for the complete result (1.1k chars)
```

- A `call` shows its input in full (capped at 4,000 chars unless `--full`) and its linked result's
  status and text; a `result` shows its text and `call`; a `compaction` shows `trigger`,
  `pre_tokens`, `post_tokens`, `dropped_tokens`, `summary: <id>`, `preserved: <n> events`.
- A pointer prints `pointer: <path> (42.8k, exists|missing)` and the preview; `--full` prints the
  file, but only a regular file inside the session's `tool-results/` (`data-model.md#pointer`).
  A pointer outside it prints `followed: false` with the reason, and the preview, never the file.
- `H` text prints whole; `C`/`D` text, input JSON, result text and `meta` strings are capped at
  4,000 chars with the house marker and a `--full` hint (`behaviors/truncation.md#caps`).
- A bare entry id for a multi-event entry prints every block as `blocks[N]` with its `.n` id.
- `--raw` prints the stored line under `raw:` instead of the model view: the parsed line as nested
  TOON (a malformed line as a string), every string value capped at 4,000 chars with the house
  marker unless `--full`. It works for any seq, silent and malformed entries included; a block
  index only names the line.
- An event prints `event: <id>`; an entry that yields several events prints `entry: <id>` and its
  `t`, then `blocks[N]`. `uuid`/`parent_uuid` close every entry. Fields an event does not have are
  omitted, never printed empty.
- `<id>` may be a bare `<seq>` only with `--session <ref>`; with both, the id's `<s8>` must be
  that session's.
- A silent entry prints `kind: silent`, its `type` and `raw:`, with hints to `show` the nearest
  event before and after; a malformed line adds `malformed: true` and prints the line as text.
- `--fields <a,b>` keeps only the named fields (the `event:`/`entry:` id always prints).
- `zoom` accepts exactly the same arguments and prints exactly the same output; `--help` for it
  says it is an alias.

## `compactions <session>`

```
agent-recall-axi compactions <session> [--full]
```

Where the context window closed, and what stood in for the lost history.

Default schema: `compactions[N]{id,t,summary,window}`: four columns (AXI §2) — `summary` the
summary event id (one `show` recovers what was lost), `window` the index of the window the
boundary opens (the value `--window` takes). `--full` switches to block form: each boundary with
`trigger`, `pre`/`post` token counts (`998.6k`, `25.1k`), `dropped`, the event counts
of the windows before and after it, and its summary's text. A boundary-less summary is listed
with `trigger` `unknown` (`behaviors/context-windows.md`). Empty: `compactions: 0 in
7a2f1c3e (one window, 4,120 lines)`.
Footer: `show <compaction-id>` for the preserved events, `human <session> --window <k>` for what
the human said after the last boundary.

## `search <phrase>`

```
agent-recall-axi search <phrase> [--regex] [--file <pattern>] [--tool <name>] [--kind <a,b>]
                         [--since <span>] [--from <when>] [--to <when>] [--project <p> | --all]
                         [--limit <n>] [--json-out[=path]]
```

The flagship memory verb, named for the word an agent reaches for first. The pre-rename verb
`recall` is not a command: it fails `VALIDATION_ERROR` (exit 2) with the targeted hint
``recall is now `search` `` and the usage line, so a remembered `recall` costs one corrected call,
not a guess. (The library function keeps the name `recall`; `api.md`.)

"Have I dealt with this before?" in one call: `find` across every session the agent can read,
grouped by session.

Default scope `--all`, default `--since 90d`. Output: `sessions[N]{id,project,last,hits,first}`
where `project` is the project `cwd` collapsed to `~`, `hits` the match count, `first` the id of
the earliest hit; the header carries `scanned: 83 sessions, 412 MB, 2.1s` and the footer the
`find <id> "<phrase>"` to dig into each. Default `--limit 20` sessions, most recently active first.

- Empty: `sessions: 0 of 83 scanned mention "<phrase>" since 90d`, exit 0, hint `--since 1y`.
- Uses the cache's term index when present and falls back to a streaming scan; the header says
  which (`index: fresh|partial|none`).
- **What it searches.** `search` matches as `find` does, over what the human and the agent said and
  the calls the agent made: the `H` and `C` kinds of an `events` listing (`human*`, `assistant`,
  `call`, `summary`; `--kind` may name any `H` or `C` kind, `thinking` included, and naming
  another is `VALIDATION_ERROR` pointing at `find --all`). A call matches on its text and input,
  never its result's text: tool output is `find`'s (`find "<phrase>" --all`). These are exactly the
  texts the term index covers (`architecture.md#cache`), so an indexed and a scanned `search`
  return the same sessions, hits and first ids.
- `--since`/`--from`/`--to` bound events by time as in `find`; a session whose file was last
  modified before the window's start is not read and not counted in `scanned:`. `--since` and
  `--from` both set the start (`USAGE`).
- `hits` counts matching events; sessions with none are not listed; ties in `last` by id. `last`
  is `MM-DD HH:MM` (no relative suffix). `--project <p>` narrows to one project, `--all` is the
  default. The footer carries `find <id> "<phrase>"` for each of the first five sessions shown
  (scope and `--tz` carried) and, when more sessions matched, the `--limit 0` continuation.
- `index:` is `fresh` when every session read was answered by an index that already covered the
  file, `none` when none was (first run, a `--regex` phrase, or a phrase with no letters or
  digits, which the index cannot narrow), and `partial` otherwise (some sessions indexed, some
  new or appended).

## `resume-pack <session>`

```
agent-recall-axi resume-pack <session> [--window <k|last>] [--budget <chars>] [--tools <n>]
                              [--claims <n>] [--project <p> | --all] [--json-out[=path]]
```

The three-layer cold-start block (`data-model.md#resume-pack`), deterministic and budgeted.
Default `--window last`, `--budget 16000`, `--tools 10`, `--claims 3`.

```
session: 7a2f1c3e fix auth redirect loop
window: 1 (last; windows 0..1)
budget: 5.8k of 16.0k used
layers: summary C; human H (verbatim); tools C (results D); claims C
days: 2026-11-07..2026-11-08
tz: America/New_York
summary:
  id: 7a2f1c3e:1203
  t: 11-07 13:39:58
  text: |
    ...
human[4]:
  - id: 7a2f1c3e:1210
    t: 11-07 13:40:02
    kind: human
    text: |
      ...
tools[10]{id,tool,target,result}:
  7a2f1c3e:4080.1,Edit,src/auth/callback.ts,ok 52
  ...
claims[3]:
  - id: 7a2f1c3e:4101
    t: 11-08 00:02:05
    text: |
      Fixed the redirect loop by …
help[2]:
  Run `agent-recall-axi tail 7a2f1c3e` to see the last rows in order
  Run `agent-recall-axi human 7a2f1c3e --window all` for every human message in the session
```

Layer order is fixed (summary, human, tools, claims) so a consumer can read authority top-down.
The `human` layer is every `H`-class event in the window: `human`, `human.queued` (messages sent
while the agent was working), `human.slash`, and `human.answer` (replies to the agent's questions);
none is filtered out, because a cold start that misses a mid-turn correction repeats the mistake.

- **Header**: `session:`, then `window: <k> (last; windows 0..<n>)` (`(windows 0..<n>)` when `k`
  is not the last, `only window 0` for a session with one), `budget: <used> of <limit> used`
  (sizes as in `row-format.md#sizes`; `budget: <used> used (no limit)` for `--budget 0`), `layers:` naming each layer's authority class, `;`
  between layers (TOON has no comments, so the classes ride on this one line; the summary is
  named only when present),
  then `day:`/`days:` and `tz:` for the one time column every layer shares, and `omitted:` last.
- **Layers**: `summary:` is a block (`id`, `t`, `text`), printed only when the window opens with
  one (`behaviors/context-windows.md`); it is `C` text, cut at 4,000 chars with the house marker
  and a `show <summary-id> --full` hint. When the budget drops it, the layer prints in its
  place as `summary: "dropped to meet the budget; show <summary-id> --full"`. `human[n]` and `claims[n]` are block lists whose texts
  are whole and verbatim; `tools[n]{id,tool,target,result}` is the `tools` view's default row (target
  cut to 120 chars, `result` the linked status). An empty layer prints `human[0]:`,
  `tools[0]:`, `claims[0]:`; it is never left out.
- **Budget** (`data-model.md#resume-pack`): a bound on the rendered layers, so the whole output
  is at most the budget plus the header and footer blocks plus the newest human message. When
  it drops human messages the header's last line is `omitted: "<n> earlier messages; continue
  with human <session> --window <k> --to <id> --budget 0"` (quoted by TOON), which prints
  exactly the omitted ones, and the same command is a `help[]` line.
- **Flags**: `--window` takes a window index or `last`; `all` and `k..` are `VALIDATION_ERROR`
  (a pack is one window); a window past the last is `VALIDATION_ERROR` naming the index-or-`last`
  grammar and the valid range. `--budget` is a non-negative integer, `0` for no budget;
  `--tools` and `--claims` are non-negative integers (`0` empties that layer).
- **Footer**: `tail <session>`, `human <session> --window all`, plus `show <summary-id> --full`
  when the summary was cut and `show <result-id> --full` for the newest persisted output in the
  `tools` layer. Hints name the session as `tail`'s do and carry scope and `--tz`.
- Library: `buildResumePack` builds the pack, `renderResumePack` (the `render` subpath) prints
  these exact bytes (`api.md#resume-pack`).

## `hook`

```
agent-recall-axi hook install   [--scope user|project] [--agent claude|codex|opencode]
agent-recall-axi hook status    [--scope user|project]
agent-recall-axi hook uninstall [--scope user|project]
```

Explicit opt-in registration of the SessionStart hook that runs the home view (and, in hook mode,
the resume pack after a compaction). The one command that writes outside the cache
(`behaviors/privacy.md`); never installed by any other command.

- **Scope**: `user` (the default) writes each agent's user config, which suits a bot host and a
  person who wants it everywhere; `project` writes the per-repository config under the working
  directory, for a repo that wants it, and nothing outside it.
- **Targets**, user scope: Claude Code `$CLAUDE_CONFIG_DIR/settings.json` (default
  `~/.claude/settings.json`), a `SessionStart` entry; Codex `$CODEX_HOME/hooks.json` (default
  `~/.codex/hooks.json`) plus `[features] hooks = true` in `$CODEX_HOME/config.toml`; OpenCode
  the managed plugin `$XDG_CONFIG_HOME/opencode/plugins/axi-agent-recall-axi.js` (default
  `~/.config/opencode/…`). Project scope: `.claude/settings.json`, `.codex/hooks.json` and
  `.opencode/plugins/axi-agent-recall-axi.js` under the working directory. Codex reads its
  feature flag only from the user's `config.toml`, which a project install never writes: it
  reports `codex_features: not set (needs [features] hooks = true in <path>; run hook install
  --scope user or set it yourself)` unless the flag is already on. `--agent` installs one of
  the three; without it all three. `status` and `uninstall` always cover all three.
- **The command** the hook runs is the running binary: the skill shim
  (`…/skills/agent-recall-axi/scripts/agent-recall-axi`, or the bundle beside it when the
  shim is not executable) when it runs from the skill bundle, else the npm bin; as the bare name
  `agent-recall-axi` when that name on `PATH` resolves to the same file, else its absolute
  path. Claude Code and Codex run it through a shell, so their entries hold it shell-quoted
  (`'/opt/my tools/…/agent-recall-axi'`); the OpenCode plugin spawns it without a shell and
  holds it raw. The entrypoint must be one of the forms this tool installs (a file named
  `agent-recall-axi`, `agent-recall-axi.js` or `agent-recall-axi.mjs`); anything else,
  including a source checkout's `.ts`, is `VALIDATION_ERROR` naming the built bin and the shim.
- **Which entries are ours**: a `SessionStart` hook whose command, split into shell words, is
  exactly one word that this tool could have written: the bare name, or an absolute path whose
  last segment is one of the three names above, quoted or not. A command with any other word
  (a wrapper with arguments, a pipeline, another tool) is never modified or removed, whatever it
  contains. The OpenCode plugin is ours only when its first line is the SDK's managed marker for
  `agent-recall-axi`.
- **Migration from the former name.** The tool was published as `agent-session-axi` before
  `agent-recall-axi`. Entries written under that name are ours too: the same one-word rule with
  `agent-session-axi` (bare, `.js`, `.mjs`), and the plugin `axi-agent-session-axi.js` whose first
  line is the managed marker for `agent-session-axi`. `status` shows such an entry as `stale`;
  `install` rewrites it to the current command in place (the Claude Code and Codex entries) and
  removes the former plugin file after writing the new one, so an upgraded user never runs both;
  `uninstall` removes both names' entries. `AGENT_SESSION_AXI_DISABLE_HOOKS=1` is honoured as well
  as `AGENT_RECALL_AXI_DISABLE_HOOKS=1`.
- **Idempotent**: an install that changes nothing rewrites nothing (file bytes unchanged) and
  says so; our entry with another command (the binary moved) is rewritten in place (path
  repair), and a second entry of ours is removed. `uninstall` removes only our entries (and a
  group, `SessionStart` array or `hooks` object it left empty) and our plugin; every other hook,
  group, key and setting stays as it was, and a plugin file without the marker is left in place
  and reported.
- **Writes** are atomic and keep the file as it was written: a temp file in the target's
  directory, renamed over the target (through a symlink, onto the file it points at), with the
  target's mode; JSON keeps its indentation (two spaces for a new file) and every key; TOML gets
  one line added or changed and nothing else. After writing, the file is read back and our entry
  must be there (install) or gone (uninstall), or the target is an `error:`.
- **Codex `config.toml`**: `features` may be absent or a plain `[features]` table. Declared any
  other way (a `features.` dotted key or `features = { … }` inline table at the top level, a
  `[features.<sub>]` or `[[features]]` header, two `[features]` headers) or with a `hooks` value
  other than `true`/`false`, the Codex target is an `error:` and neither Codex file is written.
- `AGENT_RECALL_AXI_DISABLE_HOOKS=1` makes `install` a no-op that says so (exit 0), for a host
  or CI that must never gain a hook.

```
hook: installed (user scope)
command: agent-recall-axi
targets[3]{agent,path,state}:
  claude,~/.claude/settings.json,added
  codex,~/.codex/hooks.json,added
  opencode,~/.config/opencode/plugins/axi-agent-recall-axi.js,added
codex_features: ~/.codex/config.toml (hooks = true)
help[2]:
  Run `agent-recall-axi hook status` to check it
  Run `agent-recall-axi hook uninstall` to remove it
```

- `install` states per target: `added`, `updated` (the command or timeout was repaired),
  `unchanged`, or `unmanaged (left in place)` for an OpenCode plugin file it did not write;
  the first line is `hook: installed (<scope> scope)`, or `hook: already installed
  (<scope> scope; no changes)` when nothing changed. When any target's row is an `error:`, the
  first line never claims success: `hook: partly installed (<scope> scope; see errors)` if another
  target changed, else `hook: not installed (<scope> scope; see errors)`, and the exit is 1. `command:` is the command as the Claude
  Code and Codex entries hold it. `codex_features` is printed when Codex is a target.
- `status` states per target: `installed`, `stale` (ours, with a command other than the one
  `install` would write now), `absent`, or `error: <message>`; the first line is `hook:
  installed`, `hook: stale`, `hook: partly installed` or `hook: not installed`, with the scope,
  and `codex_features:` reports the user flag. It writes nothing. The footer suggests `hook
  install` when any target is not `installed`, else `hook uninstall`.
- `uninstall` states per target: `removed`, `absent` or `unmanaged (left in place)`; the first
  line is `hook: removed (<scope> scope)` or `hook: nothing to remove (<scope> scope)`, or, when a
  target errored, `hook: partly removed` / `hook: not removed` with `; see errors` and exit 1.
  The footer suggests `hook status` to confirm and `hook install` to add it back.
- A file that cannot be read or parsed, or whose shape is not what the agent reads (the JSON
  root or its `hooks` not a plain object, `SessionStart` present but not an array), is not
  overwritten: the target's state is `error: <message>`, the others proceed, and the command
  exits 1 after printing the table.
- Footer hints carry `--scope` when it was given. Exit 0 for every other outcome, including
  no-ops.

## `cache`

```
agent-recall-axi cache status [--full]
agent-recall-axi cache clear [--project <p> | --all]
```

Reports the cache directory, size, indexed session count and staleness; `clear` deletes it.
Nothing else depends on the cache existing.

```
cache: ~/.cache/agent-recall-axi
size: 61.3k
tracked: 4 files
count: 2 indexed
indexed[2]{session,state,path}:
  7a2f1c3e,fresh,~/.claude/projects/-src-widget/7a2f1c3e-….jsonl
  91b0c4d2,appended,~/.claude/projects/-src-widget/91b0c4d2-….jsonl
help[2]:
  Run `agent-recall-axi cache clear` to delete the cache (it is rebuilt on demand)
  Run `agent-recall-axi around <id>` to index a session
```

- The default row is `{session,state,path}` (AXI §2). `--full` adds `lines` (the last-indexed
  seq), `checkpoints` (the offset-table size) and `size` (the record's bytes on disk). `state` is `fresh` (the file is as indexed, or only a line still being written
  follows), `appended` (it grew; the next seek extends the table), `rewritten` (shorter, or the indexed head or last line changed; the next read
  discards the record) or `missing` (the file is gone).
- `tracked` counts every per-file identity record (`behaviors/id-stability.md`).
- Empty: `cache: ~/.cache/agent-recall-axi (absent)` or `count: 0 indexed`, exit 0.
- `cache clear` with no flag or `--all` deletes the whole directory; `--project <p>` deletes only
  the records stored for files under that project's log directory (logs since deleted
  included). Clearing an absent cache is a no-op, exit 0
  (`cleared: nothing to clear`).

## `update`

```
agent-recall-axi update [--check]
```

Shadows the SDK's built-in self-updater so the tool never contacts a registry
(`behaviors/privacy.md`). Print-only: reports the running version and the two ways to update,
`npx skills update agent-recall-axi` for a skill install and `npm i -g agent-recall-axi@latest`
for an npm install, choosing the first line by how the running binary was installed (run from
the skill bundle, as the hints decide it (`#conventions`), → skill first). `--check` is accepted and prints the same text; exit 0.

```
update: agent-recall-axi 0.3.1 (skill install)
help[2]:
  Run `npx skills update agent-recall-axi` to update the skill bundle
  Run `npm i -g agent-recall-axi@latest` if installed from npm
```

## Built-ins

`--help`, `<command> --help`, `-v`/`-V`/`--version` (fast path, no command graph loaded). The
SDK's `update` is not used; see above.

## Principles

**Inherited:**
- [The row format is the product](principles.md#the-row-format-is-the-product)
- [Pan and zoom, not dump](principles.md#pan-and-zoom-not-dump)
- [Many ways in](principles.md#many-ways-in)
- [Common verbs on commands, concept words in docs](principles.md#common-verbs-on-commands-concept-words-in-docs)

**Local:**
- **Every footer is a complete next command.** A hint with a placeholder is allowed only when the
  value is genuinely the agent's choice (`"<phrase>"`); ids and sessions the tool already knows are
  filled in.
- **A verb never grows a mode.** `tail`, `next`, `prev`, `around` differ only in where they start;
  anything that changes what rows look like belongs to the shared listing flags.
