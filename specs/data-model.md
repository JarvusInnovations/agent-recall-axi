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
4. `latest` — the main session in scope with the most recent file modification time (a
   subagent transcript is reached by its `agentId`, never as `latest`).

Scope for 2–4 is the current project (the project whose `cwd` equals the working directory),
widened by `--project <path>` or `--all` (`cli.md`). A path (1) ignores scope.

### Session short id (`<s8>`)

The first 8 hex characters of the session uuid (or of the `agentId` for a subagent session). A
session file whose name is not a uuid or `agent-<agentId>` (a copied or renamed log opened by
path) gets the first 8 hex characters of the SHA-1 of its basename, so every printed id still
round-trips through the resolver.
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
  event, and the block form otherwise. When a string-content entry (no stored blocks) yields more
  than one event (a hook wrapper followed by the prompt the human typed), its parts are numbered
  `.1`, `.2`, … in text order; inside a stored text block the hook output instead rides on the
  block's event as `meta.hook`/`meta.hook_text`, since a block has exactly one id. Ids are printed in the form they resolve to; a bare entry id
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
| `title` | string | first of: `custom-title.json` (`customTitle`), the last `custom-title` entry (`customTitle`), the last `ai-title` entry (`aiTitle`), the head of the first `human` event; one line, cut to the row head (200 chars). The last entry of a kind wins even when it is empty (a cleared title), and an empty value falls through to the next source. Single-session headers use the cheap sources only (`cli.md#conventions`) |
| `turns`, `calls`, `compactions`, `humans` | counts | computed on demand; `turns` counts `human` and `human.slash` events (the prompts that open a turn), `compactions` the window boundaries (as `compactions` lists them), `humans` the `human*` events |
| `live` | boolean | `last` is within 5 minutes of now |
| `model` | string | the `message.model` of the last assistant entry |

`started`, `last`, the counts and `title` come from one streaming pass over the file, the same
pass that builds the line-offset table, and are cached with it (`architecture.md#cache`); an
append re-reads only the appended lines. The cache keeps where the title came from (its line),
never its text (`behaviors/privacy.md`).

The per-project `sessions-index.json` is an optional accelerator for the home view: an entry's
`summary` (title) and `modified` (last) are used only while its `fileMtime` equals the file's
modification time in milliseconds. It may be missing or stale and is never required for
correctness: it never supplies counts (`messageCount` is not a turn count), a session absent from
the index is still listed, and a session in the index whose file is gone is not.

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
an error. Most silent entries have no `timestamp` and no `uuid`. The same applies one level down
for `attachment` entries: only the `attachment.type` values named in the kinds table
(`queued_command`, `hook_success`, `hook_additional_context`) yield events; every other subtype
(reminders, tool deltas, token notices) is a silent entry.

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
| `human.slash` | H | `user` text matching `<command-name>…</command-name>` | `/<name> <args>` reconstructed from `<command-name>` (a `/` prefixed when absent) and `<command-args>` kept as stored (not trimmed), joined by one space (just `/<name>` when the args are empty); the one `H` kind whose text is reconstructed rather than stored as typed; `<command-message>` and `<local-command-stdout>` go to `meta` |
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
- **Parent prompts are not human.** In a `kind: subagent` session, and on sidechain entries in a
  main file, `user` text without `origin.kind == "human"` is the parent agent's prompt: it is
  `notice` with `meta.source: parent`, never `human.*`. The human-bias rule above does not apply,
  because the adapter can prove no human typed it: a pure subagent run has 0 human messages
  (`cli.md#human-session`). For the same reason a compaction boundary or summary on a sidechain
  entry of a main file is `notice` (`meta.source: parent`), and in a subagent session text without
  a human origin opening with the summary sentence is the parent's prompt
  (`behaviors/context-windows.md`).

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
older logs, only when it opens the text (the sentence quoted mid-result is not a notice). Files
live under the session sidecar, `tool-results/<id>.txt`; a stored path that no longer exists is
looked up there by basename.

**Containment.** A pointer is followed (`show --full`, `find --deep`) only when its real path, after
relocation and symlink resolution, is a regular file inside `<sidecar>/tool-results/`. Any other
path is still printed with its preview, marked `followed: false` with the reason, and never read.

## Turn

| field | notes |
| --- | --- |
| `id` | the opening `human` / `human.slash` event id |
| `t` | its time |
| `prompt` | its text head |
| `events` | count of events in the turn (all kinds, hidden included) |
| `calls` | count of `call` events |
| `queued` | count of `human.queued` events that arrived during the turn |
| `ended` | `compaction` (a boundary fell inside: a compaction, or a boundary-less summary that is a boundary; a summary that opens the file is none); otherwise `stop` (a next human prompt follows, or the file ends after an assistant text) or `open` (the last turn, when the last of its `assistant`, `thinking`, `call`, `result`, `human.answer` and `human.queued` events is not an assistant text: the agent was still working when the file ends, whether the session is live or was cut off). Decided from the file alone, never the clock |
| `duration` | last event time − first event time |

A session's first events before any human prompt (hooks, skills, reminders) form turn 0 with no
`prompt`; it is listed only when non-empty, and its `id` is its first event's id.

## Window

An event's window is the number of boundaries before it in file order: a `compaction` counts after
itself (it is the last event of the window it closes), a `summary` no compaction was waiting for
counts before itself when at least one event precedes it (it opens the next window). Window 0
begins at the file start; `last` names the highest window. The `summary` that is the next event
after a compaction belongs to the new window (it is what the agent saw first). Boundaries on
sidechain entries of a main file are not boundaries (`behaviors/context-windows.md`).

## Resume pack

A deterministic three-layer structure built from one session (`api.md#resume-pack`), the
library's answer to "what was I doing", over one window (default `last`). Layers in print order:

| layer | content | authority |
| --- | --- | --- |
| `summary` | the window's opening `summary` event, if any | C |
| `human` | every `H`-class event in the window — `human`, `human.queued`, `human.slash`, `human.answer` — verbatim, oldest first | H |
| `tools` | the last N (default 10) `call` events of the window with `target` and linked result status (a `persisted` status names the pointer), newest last | C (results D) |
| `claims` | the last M (default 3) `assistant` events of the window, verbatim, oldest first | C |

Sized by a budget (default 16,000) that **bounds the rendered pack**: the layers as printed (from
the first layer's key to the last claim, `help[]` excluded) take at most `budget.used` bytes,
and `used` stays within the limit unless the newest human message alone exceeds it. So the
whole output is at most the budget plus the header and footer blocks plus the newest human
message, which is never cut (and, past that point, the layers' fixed key lines and a dropped
summary's one-line note, under 150 bytes). Without TOON in the library, each printed event is charged its
encoded cost: the UTF-8 length of its text as a JSON string (quotes and escapes included, which
TOON never exceeds), for the summary its text as printed (cut at 4,000 chars with the house
marker), for a call its tool and its target as its row prints it, plus its id and a fixed
per-event overhead for keys, time, kind and indentation; each layer's key line is a fixed
charge. The constants are the renderer's layout and live next to it (`src/output/`). A budget
of `0` means no budget.

**What drops**, one event at a time while `used` exceeds the budget: the oldest claim; once no
claim is left, the oldest tool call; once no call is left, the oldest human message but the
newest; then the opening summary (`C`, so it goes before the last `H` message). No human, claim
or call text is ever cut. Dropped human messages are reported as `omitted.human` with
`continueTo`, the oldest kept message's id: the exclusive `--to` that yields exactly the
omitted ones within the window; a dropped summary as `omitted.summary`, its id.

## Timestamps

Every event carries its entry's ISO-8601 UTC timestamp. Rendering is local time (`TZ` env, else
the system zone) per `behaviors/row-format.md`. Timestamps are not monotonic in file order
(`principles.md#file-order-is-the-truth-timestamps-are-evidence`): `--from`/`--to`/`--since` filter
by timestamp, ordering is always by `seq`.
