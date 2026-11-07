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
  turns; raise --limit or narrow with --from`.
- Turn 0 (events before the first prompt) is listed only when non-empty, with `prompt` `(session
  start)`.
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
  7a2f1c3e --to 7a2f1c3e:388` when it bites. `--full` lifts the budget.
- `--rows` switches to the standard row table for a dense overview.
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
- Default `--limit 30`, newest last. `--full` adds the full input JSON and the result text to each
  row as a block (switches to block form like `human`).
- Footer: `show <id>` for a call, `show <result-id> --full` to read a persisted output.
- Empty: `tools: 0 tool calls match in 7a2f1c3e`.

## `find`

```
agent-session-axi find [<session>] [<phrase>] [--regex] [--file <pattern>] [--tool <name>]
                       [--kind <a,b>] [--from <when|id>] [--to <when|id>] [--since <span>]
                       [--window <k|last>] [--context <n>] [--before <n>] [--after <n>]
                       [--limit <n>] [--project <p> | --all] [--deep] [--json-out[=path]]
```

Search one session, the project, or everything, by any combination of handles. Each hit row says
why it matched.

- `<phrase>`: case-insensitive substring over `text` of every visible kind and over `call` inputs
  (stringified); `--regex` treats it as a JavaScript regular expression.
- `--file <pattern>`: matches `files` touched; substring, or glob when the pattern contains `*`,
  `?` or `[`.
- `--tool <name>`: case-insensitive substring of the tool name; alone, it lists every call of that
  tool.
- `--kind`: restrict to kinds (e.g. `--kind human` is "what did the human say about X").
- At least one of `<phrase>`, `--file`, `--tool`, `--kind` is required (`code: USAGE`).
- Without `<session>`, scope is the current project (`--project` to pick, `--all` for every
  project); hits print `<s8>:<seq>` ids as always, and the header lists the sessions scanned.
- `--deep` also searches persisted-output files (slow; off by default; the header says
  `deep: yes` when on).

Output: `hits[N]{id,t,kind,why,text}` where `why` is `phrase`, `file`, `tool`, `kind`, or a
combination joined with `+`; with `--context n` (default 1) each hit is followed by its
surrounding rows with `why` empty, and the table is labeled `rows` instead of `hits`. The hit row
is the one with a non-empty `why`. Default `--limit 20` hits.

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
agent-session-axi next <id> [<n>] [--limit <n>] [--kind …] [--head <n>] [--full]
agent-session-axi prev <id> [<n>] [--limit <n>] [--kind …] [--head <n>] [--full]
```

The pan verbs. Same rows as `events`; the difference is where they start.

- `around`: `--before 5 --after 5` by default; the anchor row is included and marked by a header
  line `anchor: <id>`. Output label `rows`.
- `next`: the `n` visible events after the anchor (exclusive), default 20; `prev`: the `n` before,
  default 20, printed in file order. The optional positional `<n>` equals `--limit`.
- Counts are over visible events (`--kind` applies before counting).
- Starting from a silent entry or a hidden-kind event is fine: travel begins at the nearest
  visible event in the direction of travel, and the header says so.
- Footer: the exact continuation in both directions using the edge ids
  (`next 7a2f1c3e:431`, `prev 7a2f1c3e:402`), `show <anchor>`, and `at end of session` /
  `at start of session` when a direction is exhausted (printed as a header field, not an error).
- `<id>` may be a bare `<seq>` only with `--session <ref>`; listings never print that form.

## `tail <session>`

```
agent-session-axi tail <session> [<n>] [--limit <n>] [--kind …] [--head <n>] [--full] [--fields <a,b>]
                       [--project <p> | --all]
```

The last `n` visible rows (default 20): "what was I doing". Equivalent to `events <session>` with
the default limit, kept as a verb because it is the most common call. Footer: `prev <first-id>`,
`resume-pack <session>`.

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
boundary opens. `--full` appends each summary's text as a block. Empty: `compactions: 0 in
7a2f1c3e (one window, 4,120 lines)`.

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
