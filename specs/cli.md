# CLI

The command surface of `agent-session-axi`. Every command is a rendering of a library function
(`api.md`); output follows `behaviors/row-format.md`, caps follow `behaviors/truncation.md`, time
and scope grammar follow `behaviors/time-and-scope.md`, errors follow `behaviors/errors.md`.

## Conventions

- Shape: `agent-session-axi <command> [args] [flags]`. Flags come after the command (the SDK
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
- Default `--limit` values are chosen so the common case fits in one call; the header always
  carries `count: <shown> of <matching>` and the footer the way to see more.
- Examples below use the synthetic session `7a2f1c3e` and generic paths. Output examples are
  illustrative of shape, not literal fixtures.
- A hint names a session by its `<s8>` only when no other session in scope shares those 8
  characters; otherwise by its full id (`tail <uuid>`, `show <id> --session <uuid>`), so every
  hint resolves as printed.
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

`find` and `recall` enter the ladder at any rung; `human`, `tools`, `compactions` are kind-scoped
views of the rows rung; `resume-pack` is a fixed composite for cold starts.

---

## Home view (no arguments)

Content first: the sessions of the current project and where the latest one left off.

```
bin: ~/.local/bin/agent-session-axi
description: Read, search and pan/zoom through agent session logs; TOON out, local files only
project: ~/src/widget (12 sessions)
sessions[5]{id,last,turns,title}:
  7a2f1c3e,3m ago,14,fix auth redirect loop
  91b0c4d2,2h ago,6,add pagination to listings
  ...
latest: 7a2f1c3e
last_human: 7a2f1c3e:4102 14:02:11 "ok ship it, then update the plan file"
help[5]:
  Run `agent-session-axi resume-pack 7a2f1c3e` for a cold-start pack of the latest session
  Run `agent-session-axi tail 7a2f1c3e` for the last 20 rows
  Run `agent-session-axi find "<phrase>"` to search this project's sessions
  Run `agent-session-axi recall "<phrase>"` to search every project
  Run `agent-session-axi --help` for the full command list, or `agent-session-axi <command> --help` for usage on any command
```

- With no log directory for the working directory: `project: none for <cwd>` plus the five most
  recent sessions across all projects and a hint to `--project`.
- Must complete in under 300 ms on a project with 100 sessions: it reads `sessions-index.json`
  when present and otherwise stats files and reads only the tail of the latest one. It never scans
  a whole file.
- **Hook mode.** When stdin is not a TTY and carries a SessionStart hook payload (JSON with
  `session_id` and `source`), the home view adapts: `source: compact` or `resume` prints
  `resume-pack <that session> --budget 6000` instead of the listing; `startup`/`clear` print the
  listing above. This is how an agent that just lost its context gets it back without asking.

---

## `sessions`

```
agent-session-axi sessions [--project <p> | --all] [--since <span>] [--from <when>] [--to <when>]
                           [--limit <n>] [--subagents] [--fields <a,b>] [--json-out[=path]]
```

Sessions in scope, most recently active first.

Default schema: `sessions[N]{id,started,last,turns,title}` — `id` is `<s8>`; `started` and `last`
are `MM-DD HH:MM` plus, for `last`, a relative suffix (`11-07 14:02 (3m ago)`); `turns` is the
human-prompt count; `title` per `data-model.md#session`.

Extra fields: `uuid`, `path`, `project`, `bytes`, `lines`, `calls`, `compactions`, `humans`,
`live`, `kind`, `parent`, `model`.

- Default `--limit 20`. Default time window: none (all sessions in scope); `--since 7d` is the
  typical narrowing.
- `--subagents` includes subagent sessions, with `kind` and `parent` in the default schema.
- Empty: `sessions: 0 sessions in ~/src/widget` (exit 0), hint `--all`.
- Footer hints: `turns <id>`, `resume-pack <id>`, `find --project … "<phrase>"`.

## `turns <session>`

```
agent-session-axi turns <session> [--from <when|id>] [--to <when|id>] [--since <span>]
                        [--window <k|last>] [--limit <n>] [--full] [--json-out[=path]]
```

One row per human prompt: the mid-zoom rung.

Default schema: `turns[N]{id,t,prompt,events,calls,ended}` (`data-model.md#turn`). `prompt` is
the head of the opening human text; `ended` is `stop`, `compaction` or `open`.

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
agent-session-axi events <session> [--from <when|id>] [--to <when|id>] [--since <span>]
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
agent-session-axi human <session> [--from <when|id>] [--to <when|id>] [--since <span>]
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
- Default `--budget 12000` chars, newest kept; `omitted: 7 earlier messages; continue with human
  7a2f1c3e --to 7a2f1c3e:388` when it bites. `--full` lifts the budget. The budget is 12,000
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
agent-session-axi tools <session> [--name <tool>] [--file <pattern>] [--errors]
                        [--from <when|id>] [--to <when|id>] [--since <span>] [--window <k|last>]
                        [--limit <n>] [--full] [--fields <a,b>] [--json-out[=path]]
```

Tool calls with their results folded in.

Default schema: `tools[N]{id,t,tool,target,result}` — `result` is the status (`ok 1.2k`,
`error 340`, `persisted 42.8k`, `image`, `pending`).

- `--name` is a case-insensitive substring of the tool name (`--name bash`, `--name mcp__`).
- `--file` filters by `files` touched (`data-model.md#files-touched`).
- `--errors` keeps only calls whose result `is_error`.
- `--fields <a,b>` adds columns after `result`: `result_id` (the linked result's id), `error`,
  `files` (joined with `, `; `show <id>` has the exact list).
- Default `--limit 30`, newest last. `--full` adds the full input JSON and the result text to each
  row as a block (switches to block form like `human`), lifts the row cap, and prints a
  persisted output's file in place of its preview when it may be followed
  (`data-model.md#pointer`).
- Footer: `show <id>` for a call, `show <result-id> --full` to read a persisted output.
- Empty: `tools: 0 tool calls match in 7a2f1c3e`.

## `find`

```
agent-session-axi find [<session>] [<phrase>] [--regex] [--file <pattern>] [--tool <name>]
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
  Run `agent-session-axi around 7a2f1c3e:412.2 --before 10 --after 10` for more context
  Run `agent-session-axi show 7a2f1c3e:412.2` for the whole call and result
  Run `agent-session-axi find "redirect" --all` to search every project
```

- Empty: `hits: 0 events match phrase "redirect" in 7a2f1c3e (4,120 lines scanned)`, exit 0,
  with hints to drop a filter or widen scope.
- Cross-session scans report `scanned: 12 sessions, 38.4 MB` and respect `--since` (default none
  for a project, 90 days for `--all`).

## `around <id>` · `next <id>` · `prev <id>`

```
agent-session-axi around <id> [--before <n>] [--after <n>] [--context <n>] [--kind …] [--head <n>] [--full]
                         [--fields <a,b>] [--window <k|last>] [--session <ref>] [--project <p> | --all]
agent-session-axi next <id> [<n>] [--limit <n>] [--kind …] [--head <n>] [--full] [--fields <a,b>]
                       [--window <k|last>] [--session <ref>] [--project <p> | --all]
agent-session-axi prev <id> [<n>] [--limit <n>] [--kind …] [--head <n>] [--full] [--fields <a,b>]
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
agent-session-axi tail <session> [<n>] [--limit <n>] [--kind …] [--head <n>] [--full] [--fields <a,b>]
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
agent-session-axi show <id> [--full] [--raw] [--fields <a,b>] [--session <ref>] [--project <p> | --all]
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
  Run `agent-session-axi show 7a2f1c3e:413 --full` for the complete result (1.1k chars)
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
agent-session-axi compactions <session> [--full]
```

Where the context window closed, and what stood in for the lost history.

Default schema: `compactions[N]{id,t,trigger,pre,post,summary,window}` — `pre`/`post` are token
counts (`998.6k`, `25.1k`), `summary` the summary event id, `window` the index of the window the
boundary opens. `--full` switches to block form: each boundary with `dropped`, the event counts
of the windows before and after it, and its summary's text. A boundary-less summary is listed
with `trigger` `unknown` (`behaviors/context-windows.md`). Empty: `compactions: 0 in
7a2f1c3e (one window, 4,120 lines)`.
Footer: `show <compaction-id>` for the preserved events, `human <session> --window <k>` for what
the human said after the last boundary.

## `recall <phrase>`

```
agent-session-axi recall <phrase> [--regex] [--file <pattern>] [--tool <name>] [--kind <a,b>]
                         [--since <span>] [--from <when>] [--to <when>] [--project <p> | --all]
                         [--limit <n>] [--json-out[=path]]
```

"Have I dealt with this before?" in one call: `find` across every session the agent can read,
grouped by session.

Default scope `--all`, default `--since 90d`. Output: `sessions[N]{id,project,last,hits,first}`
where `project` is the project `cwd` collapsed to `~`, `hits` the match count, `first` the id of
the earliest hit; the header carries `scanned: 83 sessions, 412 MB, 2.1s` and the footer the
`find <id> "<phrase>"` to dig into each. Default `--limit 20` sessions, most recently active first.

- Empty: `sessions: 0 of 83 scanned mention "<phrase>" since 90d`, exit 0, hint `--since 1y`.
- Uses the cache's term index when present and falls back to a streaming scan; the header says
  which (`index: fresh|partial|none`).

## `resume-pack <session>`

```
agent-session-axi resume-pack <session> [--window <k|last>] [--budget <chars>] [--tools <n>]
                              [--claims <n>] [--json-out[=path]]
```

The three-layer cold-start block (`data-model.md#resume-pack`), deterministic and budgeted.
Default `--window last`, `--budget 16000`, `--tools 10`, `--claims 3`.

```
session: 7a2f1c3e fix auth redirect loop
window: 1 of 1 (last)
budget: 5.8k of 16k used
summary:              # C — the compaction summary that opened this window, if any
  id: 7a2f1c3e:1203
  text: |
    ...
human[4]:             # H — human, human.queued, human.slash, human.answer; verbatim, oldest first
  - id: 7a2f1c3e:1210
    t: 11-07 13:40:02
    kind: human
    text: |
      ...
tools[10]{id,t,tool,target,result}:   # D — newest last
  7a2f1c3e:4080.1,14:01:20,Edit,src/auth/callback.ts,ok
  ...
claims[3]:            # C — the agent's last statements
  - id: 7a2f1c3e:4101
    t: 14:02:05
    text: |
      Fixed the redirect loop by …
help[2]:
  Run `agent-session-axi tail 7a2f1c3e` to see the last rows in order
  Run `agent-session-axi human 7a2f1c3e --window all` for every human message in the session
```

Layer order is fixed (summary, human, tools, claims) so a consumer can read authority top-down.
The `human` layer is every `H`-class event in the window: `human`, `human.queued` (messages sent
while the agent was working), `human.slash`, and `human.answer` (replies to the agent's questions);
none is filtered out, because a cold start that misses a mid-turn correction repeats the mistake.

## `hook`

```
agent-session-axi hook install [--scope user|project] [--agent claude|codex|opencode]
agent-session-axi hook status  [--scope …]
agent-session-axi hook uninstall [--scope …]
```

Explicit opt-in registration of the SessionStart hook that runs the home view (and, in hook mode,
the resume pack after a compaction). Built on the SDK's install/status/uninstall helpers; project
scope is the default for a repo that wants it, user scope for a bot host. Idempotent; repairs a
moved binary path. Never installed by any other command.

## `cache`

```
agent-session-axi cache status
agent-session-axi cache clear [--project <p> | --all]
```

Reports the cache directory, size, indexed session count and staleness; `clear` deletes it.
Nothing else depends on the cache existing.

```
cache: ~/.cache/agent-session-axi
size: 61.3k
tracked: 4 files
count: 2 indexed
indexed[2]{session,lines,checkpoints,size,state,path}:
  7a2f1c3e,4120,17,9.8k,fresh,~/.claude/projects/-src-widget/7a2f1c3e-….jsonl
  91b0c4d2,812,4,2.1k,appended,~/.claude/projects/-src-widget/91b0c4d2-….jsonl
help[2]:
  Run `agent-session-axi cache clear` to delete the cache (it is rebuilt on demand)
  Run `agent-session-axi around <id>` to index a session
```

- `lines` is the last-indexed seq, `checkpoints` the offset-table size, `size` the record's bytes
  on disk. `state` is `fresh` (the file is as indexed, or only a line still being written
  follows), `appended` (it grew; the next seek extends the table), `rewritten` (shorter, or the indexed head or last line changed; the next read
  discards the record) or `missing` (the file is gone).
- `tracked` counts every per-file identity record (`behaviors/id-stability.md`).
- Empty: `cache: ~/.cache/agent-session-axi (absent)` or `count: 0 indexed`, exit 0.
- `cache clear` with no flag or `--all` deletes the whole directory; `--project <p>` deletes only
  the records stored for files under that project's log directory (logs since deleted
  included). Clearing an absent cache is a no-op, exit 0
  (`cleared: nothing to clear`).

## `update`

```
agent-session-axi update [--check]
```

Shadows the SDK's built-in self-updater so the tool never contacts a registry
(`behaviors/privacy.md`). Print-only: reports the running version and the two ways to update,
`npx skills update agent-session-axi` for a skill install and `npm i -g agent-session-axi@latest`
for an npm install, choosing the first line by how the running binary was installed (inside a
`skills/` directory → skill first). `--check` is accepted and prints the same text; exit 0.

```
update: agent-session-axi 0.3.1 (skill install)
help[2]:
  Run `npx skills update agent-session-axi` to update the skill bundle
  Run `npm i -g agent-session-axi@latest` if installed from npm
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
