# Behavior: Row format

## Rule

Every listing prints events as rows of one shape, `{id,t,kind,text}`, as a TOON table whose label
names what the rows are (`events`, `hits`, `tail`). Commands that list something other than events
(`sessions`, `turns`, `tools`, `recall`) print their own small schema, documented in `cli.md`, and
still open every row with an id and a time.

## Applies To

`events`, `around`, `next`, `prev`, `tail`, `find`, `human` (row mode), `tools`, `turns`,
`sessions`, `recall`, `compactions`, the home view, and the `tools`/`claims` layers of
`resume-pack`.

## Details

### Columns

| column | content |
| --- | --- |
| `id` | the event id, always in full `<s8>:<seq>[.<n>]` form (`behaviors/id-stability.md`) |
| `t` | local time. `HH:MM:SS` when every row in the listing falls on one local calendar day, in which case the listing header carries `day: YYYY-MM-DD`; otherwise `MM-DD HH:MM:SS`, and the header carries `days: YYYY-MM-DD..YYYY-MM-DD`. Zone from `--tz`, else `TZ`, else the system zone; the header names it once (`tz: America/New_York`) |
| `kind` | the event kind verbatim (`human`, `human.queued`, `call`, `result`, …) |
| `text` | the event's head, one line |

### `text` by kind

- `human*`, `assistant`, `summary`, `skill`, `notice*`: the text itself, newline runs collapsed to a
  single space, cut to the head length (`behaviors/truncation.md`).
- `human.slash`: the reconstructed command, `/name args`.
- `call`: `<tool> <target> → <status>`, where `status` is the linked result's status:
  `ok <size>`, `error <size>`, `persisted <size>` (a pointer exists), `image`, or `pending` (no
  result in the file yet). `target` is cut to 120 characters. Example:
  `Bash bun test → error 3.4k`.
- `result`: the stored text head, prefixed `error: ` when `is_error`. Result rows are hidden by
  default in event listings because their status already rides on the call row; `--kind result`
  or `show` surfaces them.
- `compaction`: `compacted auto 998.6k→25.1k, summary 7a2f1c3e:1203` (trigger, pre→post tokens,
  the summary event id).
- `hook`: `<hook event> <exit>: <stdout head>`.

### Sizes

Character counts render as a bare integer below 1000, then `1.2k`, then `3.4M`, one decimal.

### Default visibility

Event listings show every kind except `thinking` and `result` (both reachable by `--kind` and
`show`). `notice*`, `skill` and `hook` rows are shown: they are short and they explain gaps an agent
would otherwise misread (why the model suddenly knew a skill, why a turn ended). `--kind` takes a
comma list and replaces the default set; `--kind all` shows everything.

These defaults are a first call on token cost versus legibility; revisit them after a month of
unattended bot use, with real `--kind` usage from the bots' own session logs as the evidence.

### Headers and footers

A listing opens with a header block (`session: <s8> <title>`, `day:`/`days:`, `tz:`,
`count: <shown> of <matching>`) and closes with `help[]` lines that are complete commands for the
natural next moves: continue in each direction (`next`/`prev` from the edge ids), zoom (`show`),
and widen (`--limit`, `--full`). `help[]` is block form, one line per entry. Detail views
(`show`) omit `help[]` unless something was truncated.

### Relative times

Only the `sessions` listing and the home view print relative times (`last: 3m ago`), and only in
addition to an absolute time. Every other output is reproducible byte-for-byte for the same file
and arguments (`principles.md#deterministic-output-for-the-same-file`).

## Principles

**Inherited:**
- [The row format is the product](../principles.md#the-row-format-is-the-product) — this spec is
  that format; a new command conforms to it or justifies a new schema here.
- [Pan and zoom, not dump](../principles.md#pan-and-zoom-not-dump) — the footer is how a row
  becomes a vantage point.
