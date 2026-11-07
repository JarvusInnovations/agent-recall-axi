# Behavior: Errors and exit codes

## Rule

Errors are TOON on stdout (`error`, `code`, `help[]`), never a stack trace, never a raw exception.
Exit 2 for usage, 1 for an operation that could not be satisfied, 0 for everything else, including
definitive empty results.

## Applies To

Every command.

## Details

### Codes

| code | exit | when | help |
| --- | --- | --- | --- |
| `USAGE` | 2 | missing or malformed argument | the command's usage line |
| `UNKNOWN_FLAG` | 2 | a flag the command does not declare | `valid flags for \`<cmd>\`: …` inline, `--help` and `--tz` always allowed |
| `VALIDATION_ERROR` | 2 | a value that does not parse (bad `<when>`, short prefix, bad id) | the grammar, one line |
| `NOT_FOUND` | 1 | a session or id that resolves to nothing | nearest ids or `sessions` |
| `AMBIGUOUS_SESSION` | 1 | a prefix matching several sessions | `details:` with candidates and titles; for an id, `--session <uuid>` per candidate (an id's `<s8>` cannot be lengthened) |
| `NO_SESSIONS` | 1 | no log directory for the current scope | `--project <path>` or `--all` |
| `UNREADABLE` | 1 | a file exists but cannot be read | the path and the permission needed |
| `INTERNAL_ERROR` | 1 | anything unexpected, wrapped as `unexpected failure: <message>` | file an issue; `--debug` for the stack on stderr |

`UNREADABLE` is raised when the unreadable file is the one the command was asked to read. In a
listing over many files (`sessions`, the home view, cross-session `find`), one unreadable or
vanished file never fails the listing: it is skipped, the header reports `unreadable: <n>`, and a
`help[]` line names the first path.

### Not errors

- Zero matches: `hits: 0 events match phrase "<phrase>" in 7a2f1c3e (4,120 lines scanned)` (the
  query as `find` prints it, `cli.md#find`), exit 0, with
  a hint to widen (`--all`, drop a filter).
- A malformed line in a log: skipped, counted, surfaced as `malformed: 2 lines` in the session
  header; `show <id>` of such a line prints it raw.
- A missing persisted-output file: `pointer: … (missing)`, exit 0.
- An unknown entry `type`: silent entry, exit 0.

### Rules

- Validate flags and arguments before opening any file.
- Unknown flags are rejected by name against the command's declared set; renamed flags get a
  targeted hint (`--n was renamed; use --limit`).
- Dependency names never appear in messages; hints reference this tool's commands.
- Progress and debug text go to stderr only.

## Principles

**Inherited:**
- [Deterministic output for the same file](../principles.md#deterministic-output-for-the-same-file).
