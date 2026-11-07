# Behavior: Id stability

## Rule

An id printed once is valid for the life of the file. Ids are a pure function of the file's bytes
and the entry's position; the tool keeps no state an id depends on.

## Applies To

Every id the tool prints or accepts: session short ids, entry ids, event ids, and the ids inside
`help[]` hints.

## Details

### What makes ids stable

- `seq` is the 1-based line number. Agent log files are append-only, so a line never moves.
- `<s8>` is a fixed 8-character prefix of a uuid that never changes.
- `.n` indexes *all* content blocks of the entry, hidden ones included, so hiding or showing
  `thinking` never renumbers a tool call.
- Ids do not depend on filters, scope, time zone, or which command produced them.
- The tool never shortens ids dynamically. A git-style "shortest unique prefix" would change as
  sessions accumulate; 8 characters is the printed form and the minimum accepted prefix.

### Resolution

- An entry id whose `seq` exceeds the file's line count → `error: 7a2f1c3e:9999 is beyond the end
  of the session (4120 lines)`, `code: NOT_FOUND`, with a hint to `tail`.
- An entry id that points at a silent entry (one that yields no event) is still valid: `show`
  prints it raw with `kind: silent` and hints the nearest event ids before and after. Pan commands
  started from a silent entry begin at the nearest event in the direction of travel.
- A block index that does not exist → `code: NOT_FOUND` listing the entry's block ids.
- Any prefix of 8 or more hex characters resolves a session; fewer → `code: VALIDATION_ERROR`
  explaining the minimum.

### Append-only is assumed

Session files are append-only; that is the operator's decision and the premise of this id scheme.
The tool does not remap, repair, or renumber ids after a rewrite, and no command is specified to
work across one. What it does owe is a notice: if a writer ever rewrites a log in place, earlier
ids point at different lines and the tool must not hide it:

- The cache (`architecture.md#cache`) records, per file, the byte length, a hash of the first
  line (once it is complete) and the offset, length and hash of the last complete line read. On
  the next read, a shorter file or a changed hash marks the file `rewritten` and the cache for it
  is discarded. An empty file or a first line still being written records no head hash, so the
  append that completes it is never a rewrite. (The last-indexed seq joins the record with the
  line-offset table.)
- A listing over a file marked `rewritten` since the last read carries `notice: session file was
  rewritten since <time>; ids printed earlier may have moved` once, then the mark clears.
- Validation for the Claude Code adapter includes a fixture that appends to a file between two
  reads and asserts every previously printed id resolves to the same entry.

## Principles

**Inherited:**
- [Stable ids](../principles.md#stable-ids-an-id-printed-once-is-valid-for-the-life-of-the-file) —
  this spec is its mechanism.
- [File order is the truth](../principles.md#file-order-is-the-truth-timestamps-are-evidence) —
  position, not time, is the id.
