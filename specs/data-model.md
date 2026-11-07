# Data model

The normalized model every command, id and row is written against. Adapters (`architecture.md`)
produce it from a concrete log format; nothing downstream of an adapter reads the source JSON.
Vocabulary here is the vocabulary of the specs and `--help`; command names stay plain verbs
(`principles.md#common-verbs-on-commands-concept-words-in-docs`).

## Overview

```
Project  1 ──< Session  1 ──< Entry (one file line)  1 ──< Event (one addressable row)
                   │                                          │
                   └──< Session (subagent, kind=subagent)     └── Pointer (persisted output file)
Session  1 ──< Window (slice between compactions)  1 ──< Turn  1 ──< Event
```

- **Project** — the directory an agent ran in; one log directory per project.
- **Session** — one log file. A subagent's transcript is a session of `kind: subagent` with a
  `parent`.
- **Entry** — one line of the file. Every entry has a `seq` (its 1-based line number). Only
  message-bearing entries yield events; the rest are *silent entries*, retained for `show --raw`
  and counts but never rows.
- **Event** — one row. An entry yields zero, one or several events (an assistant line holding text
  plus three parallel tool calls yields four).
- **Turn** — a human prompt and everything that followed it until the next human prompt.
- **Window** — the events between two compaction boundaries; the last window is what the agent's
  live context held.
- **Pointer** — a reference from a `result` event to a file holding its full output.

## Identifiers

### Session reference (`<session>`)

Any of, resolved in this order:

1. A path to a log file (absolute or relative; must exist).
2. A full session uuid, or a full subagent `agentId`.
3. A hex prefix of at least 8 characters of either. Ambiguity is an error listing the candidates
   (`code: AMBIGUOUS_SESSION`), never a guess.
4. `latest` — the session in scope with the most recent file modification time.

Scope for 2–4 is the current project (the project whose `cwd` equals the working directory),
widened by `--project <path>` or `--all` (`cli.md`). A path (1) ignores scope.

### Session short id (`<s8>`)

The first 8 hex characters of the session uuid (or of the `agentId` for a subagent session).
Printed on every row that leaves a session's context (`recall`, cross-session `find`) and as the
first component of every entry id. Fixed width; never shortened further, never lengthened by the
tool (`behaviors/id-stability.md`).

### Entry id and event id

```
<s8>:<seq>            an entry (one file line)            7a2f1c3e:418
<s8>:<seq>.<n>        the n-th content block of that entry 7a2f1c3e:418.2
```

- `seq` is the 1-based line number of the entry in its file. Lines are never renumbered because
  the file is append-only; silent entries leave visible gaps in the sequence, which is expected.
- `n` is the 1-based index of the block among *all* content blocks stored on the entry, including
  blocks the view hides (thinking). An event's id is the entry id when the entry yields exactly one
  event, and the block form otherwise. Ids are printed in the form they resolve to; a bare entry id
  of a multi-event entry resolves to the whole entry (`show` prints all its events).
- A subagent session's events are `<agentId8>:<seq>`. The namespace is shared with main sessions;
  the resolver searches both and reports ambiguity rather than preferring one.
- A `<seq>` without `<s8>` is accepted only where the command already names the session (for
  example `around <session> 418`); listings always print the full form.

### Tool-call linkage

A `call` event carries the source tool-use id (`toolu_…`) internally. The `result` whose
`tool_use_id` matches is linked both ways: the call row knows `result: <id>` and the result row
knows `call: <id>`. Linkage is by id, never by adjacency: results may land several entries later
and in a different order than the calls (parallel tool use).

## Project

| field | type | source (Claude Code) |
| --- | --- | --- |
| `dir` | path | `~/.claude/projects/<encoded>` |
| `cwd` | path | the `cwd` field of the first entry that has one; falls back to decoding `<encoded>` (`/` and `.` became `-`), which is lossy and only used when no entry carries `cwd` |
| `sessions` | count | `*.jsonl` directly in `dir` |

## Session

| field | type | notes |
| --- | --- | --- |
| `id` | uuid or agentId | from the filename |
| `short` | `<s8>` | derived |
| `kind` | `main` \| `subagent` | subagent files live under `<dir>/<parent-uuid>/subagents/agent-<agentId>.jsonl` |
| `parent` | session id | subagent only |
| `path` | path | the log file |
| `sidecar` | path | `<dir>/<id>/` — holds `tool-results/`, `subagents/`, `custom-title.json`; may be absent |
| `project` | Project | |
| `started` | timestamp | first entry timestamp in file order |
| `last` | timestamp | max entry timestamp (file mtime when the file has none) |
| `bytes`, `lines` | numbers | file size and line count (lines are counted lazily) |
| `title` | string | first of: `custom-title.json`, the last `ai-title` entry, the head of the first `human` event |
| `turns`, `calls`, `compactions`, `humans` | counts | computed on demand; `humans` counts `human*` events |
| `live` | boolean | `last` is within 5 minutes of now |

The per-project `sessions-index.json` is an optional accelerator for `sessions` (title, counts,
mtime); it may be missing or stale and is never required for correctness. A session absent from
the index is still listed; a session in the index whose file is gone is not.

## Entry

| field | notes |
| --- | --- |
| `seq` | 1-based line number |
| `type` | the source `type` string, kept verbatim |
| `uuid`, `parentUuid` | when present; `show` prints them, rows do not |
| `t` | the entry `timestamp`, when present |
| `sidechain` | `isSidechain` |
| `raw` | the parsed line, for `show --raw` |

**Silent entries** (no events, in the Claude Code adapter): `ai-title`, `custom-title`,
`last-prompt`, `mode`, `permission-mode`, `atis-latch`, `bridge-session`, `api-request`,
`api-request-blob`, `api-request-shape`, `file-history-snapshot`, `file-history-delta`,
`queue-operation`, `session-owner`, `tools-used`, `pr-link`, `frame-link`, `history-suppression`,
`artifact-*`, and any `type` the adapter does not recognize. An unrecognized type is counted, never
an error. Most silent entries have no `timestamp` and no `uuid`.

## Event

The row. Fields marked **row** appear in the default listing schema; the rest are `show` fields or
opt-in columns (`--fields`).

| field | row | type | notes |
| --- | --- | --- | --- |
| `id` | row | event id | |
| `t` | row | time | the entry's timestamp, rendered per `behaviors/row-format.md` |
| `kind` | row | enum | below |
| `text` | row | string | the head (listings) or whole text (`show`, `human`) |
| `authority` | | `H` \| `C` \| `D` | derived from `kind`, `behaviors/authority.md` |
| `size` | | chars | total length of `text` before any head cut |
| `turn` | | event id | the `human` event that opened the turn |
| `window` | | integer | 0-based compaction window index |
| `tool` | | string | `call`/`result` only: tool name |
| `target` | | string | `call` only: derived primary argument (below) |
| `input` | | object | `call` only: the full tool input |
| `result` | | event id | `call` only |
| `call` | | event id | `result` only |
| `error` | | boolean | `result` only: `is_error` |
| `pointer` | | Pointer | `result` only, when the stored text is a preview of a persisted file |
| `agent` | | agentId | `call` to a subagent-spawning tool, and `notice.task`: the subagent session this links to |
| `files` | | paths | files this event touched (below) |
| `meta` | | object | adapter-specific facts worth surfacing (`trigger`, `pre_tokens`, `hook`, `skill`, `command`, `source`) |

### Kinds

| kind | authority | source (Claude Code) | `text` |
| --- | --- | --- | --- |
| `human` | H | `user` entry, string or text-block content, not `isMeta`, not `isCompactSummary`, no `tool_result`; or `origin.kind == "human"` | verbatim |
| `human.queued` | H | `attachment` with `attachment.type == "queued_command"` and a human origin (the message sent while the agent was working); also `user` with `promptSource == "queued"` | `attachment.prompt` verbatim, never the `<system-reminder>` wrapper the model saw |
| `human.slash` | H | `user` text matching `<command-name>…</command-name>` | `/<name> <args>` reconstructed from `<command-name>` and `<command-args>`; `<command-message>` and `<local-command-stdout>` go to `meta` |
| `human.answer` | H | `tool_result` whose call was a question tool (`AskUserQuestion` and MCP variants) | the answer text |
| `assistant` | C | `text` blocks of an `assistant` entry (contiguous text blocks of one entry merge into one event) | verbatim |
| `thinking` | C | `thinking` blocks; hidden unless `--kind thinking` | verbatim |
| `call` | C | `tool_use` block | `<tool> <target>` |
| `result` | D | `tool_result` block in a `user` entry; string or text/image/document/tool_reference blocks | text content; non-text blocks become `[image]`, `[document]`, `[tool_reference]` tokens |
| `compaction` | D | `system` entry with `subtype == "compact_boundary"` | `Conversation compacted` plus `meta.trigger`, `meta.pre_tokens`, `meta.post_tokens`, `meta.dropped_tokens` |
| `summary` | C | `user` entry with `isCompactSummary == true` (string begins "This session is being continued…") | the summary verbatim |
| `hook` | D | `attachment` of type `hook_success` / `hook_additional_context`; `system` with `subtype == "stop_hook_summary"`; older `user` turns whose text is a hook stdout wrapper | the hook stdout / context; `meta.hook` = hook event name, `meta.exit` |
| `skill` | D | `isMeta` `user` text beginning `Base directory for this skill:` | the skill body; `meta.skill` = name, `meta.path` |
| `notice` | D | any other injected text the human did not type: `<system-reminder>` blocks, image placeholders (`[Image: …]`), interruption notices, `isMeta` text not otherwise classified, `system` entries of other subtypes (`turn_duration`, `away_summary`, `informational`, `local_command`) | verbatim, tags stripped |
| `notice.task` | D | a `<task-notification>` payload (subagent completion) in user text or a `queued_command` attachment with a non-human origin | the notification summary; `meta.status`, `agent` |

Rules:

- A `user` entry may hold several blocks of different kinds (a `tool_result` followed by a
  `text` system reminder). Each block is classified on its own.
- `human.*` never includes text the adapter can prove the human did not type (`isMeta`,
  `isCompactSummary`, hook wrappers, reminders). When the adapter cannot tell, the text is `human`:
  misfiling injected text as human is the safer error, because `human` is printed and `notice` is
  often hidden.
- A `user` entry with `queuePriority == "later"` (a scheduled wake-up) is still `human` or
  `human.slash`; `meta.scheduled = true`.
- Sidechain entries (`isSidechain == true`) inside a main session file are events of that session
  (they are rare in current logs; subagents normally have their own file).

### Derived target (`call.target`)

The first of: a path-valued input (`file_path`, `path`, `notebook_path`, `filePath`, `file`,
`filename`); the `command` of a shell tool; `pattern` or `query`; `description` of a subagent tool;
`skill` of a skill tool; `url`; the first string-valued input otherwise. Shell commands keep their
first 120 characters in rows (`behaviors/truncation.md`).

### Files touched (`files`)

The union of: every path-valued input key above; `toolUseResult.filePath` and
`toolUseResult.file.filePath` when present; and, for shell tools, command tokens that look like
paths (contain `/` or end in a dot-extension, quotes stripped, `~` kept). `find --file` matches
against this list. Paths are stored as written; matching is substring unless the pattern contains
a glob character (`cli.md#find`).

### Pointer

| field | notes |
| --- | --- |
| `path` | absolute path parsed from the stored notice |
| `bytes` | the size the notice reports (`Output too large (42.8KB)` → 42.8 KB) |
| `preview` | the stored preview text (≈2 KB) |
| `exists` | whether `path` is readable now |

Recognized notices: text wrapped in `<persisted-output>…</persisted-output>` containing
`Output too large (<size>). Full output saved to: <path>`; the same sentence without the wrapper in
older logs. Files live under the session sidecar, `tool-results/<id>.txt`.

## Turn

| field | notes |
| --- | --- |
| `id` | the opening `human` / `human.slash` event id |
| `t` | its time |
| `prompt` | its text head |
| `events` | count of events in the turn (all kinds, hidden included) |
| `calls` | count of `call` events |
| `queued` | count of `human.queued` events that arrived during the turn |
| `ended` | `stop` (next human prompt or end of file after an assistant text), `compaction` (a boundary fell inside), `open` (last turn of a live session) |
| `duration` | last event time − first event time |

A session's first events before any human prompt (hooks, skills, reminders) form turn 0 with no
`prompt`; it is listed only when non-empty.

## Window

Window `k` is the events after the `k`-th `compaction` and before the `(k+1)`-th; window 0 begins
at the file start. `last` names the highest window. The `summary` event that follows a boundary
belongs to the new window (it is what the agent saw first).

## Resume pack

A deterministic three-layer structure built from one session (`api.md#buildresumepack`), the
library's answer to "what was I doing":

| layer | content | authority |
| --- | --- | --- |
| `human` | every `human*` event in the chosen window, verbatim, oldest first | H |
| `tools` | the last N `call` events with `target`, result status and pointer, newest last | D |
| `claims` | the last M `assistant` events, verbatim | C |
| `summary` | the window's opening `summary` event, if any | C |

Sized by a character budget: `human` is never cut below its newest message; `claims` shrinks
first, then `tools`, then older `human` messages drop with a note of how many were omitted and the
id to continue from.

## Timestamps

Every event carries its entry's ISO-8601 UTC timestamp. Rendering is local time (`TZ` env, else
the system zone) per `behaviors/row-format.md`. Timestamps are not monotonic in file order
(`principles.md#file-order-is-the-truth-timestamps-are-evidence`): `--from`/`--to`/`--since` filter
by timestamp, ordering is always by `seq`.
