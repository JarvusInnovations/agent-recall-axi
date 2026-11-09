# Behavior: Truncation and the `--full` escape hatch

## Rule

Default views cut long content to a head and say so; nothing is omitted without a visible mark and
a way to get the whole thing. `--full` lifts every cap on the command it is given and follows
persisted-output pointers. Hints about `--full` appear only when something was actually cut.

## Applies To

Every command.

## Details

### Caps

| where | default | flag |
| --- | --- | --- |
| row `text` head | 200 chars | `--head <n>` |
| row `call` target | 120 chars | `--head <n>` (same flag; target gets min(n, 120)) |
| `show` text of `C`/`D` events, input JSON, result text, `meta` strings | 4,000 chars each | `--full` |
| `show` text of `H` events | never cut | — |
| `human` total output | 12,000 chars including the window's opening summary (itself capped at 4,000 as `C` text); the newest human message always prints whole; older messages drop oldest-first | `--budget <chars>`, `--full` |
| `resume-pack` total | 16,000 bytes of rendered layers (the output is at most that plus header, footer and the newest human message, `data-model.md#resume-pack`); claims drop first, then calls, then the oldest human messages, then the opening summary; the newest human message always prints whole | `--budget <chars>`, `--budget 0` |
| rows per listing | `--limit` default per command (`cli.md`) | `--limit <n>`; `--limit 0` = no cap |
| `recall` sessions scanned | last 90 days | `--since`, `--from` |

### Marks

- A cut row head ends with `…`. The listing footer says how many rows were cut and how to see one
  whole (`show <id>`) or all (`--full`).
- A cut `show` field ends with ` … (truncated, 8432 chars total)`, the house marker.
- A result whose stored text is a persisted-output preview prints `pointer: <path> (42.8k, exists)`
  and the preview; `--full` prints the file's contents instead of the preview. A missing file prints
  `pointer: <path> (42.8k, missing)` and the preview, with no error.
- A `human` or `resume-pack` output that dropped older messages to meet its budget carries
  `omitted: "7 earlier messages; continue with human <session> --to <id>"` (TOON quotes the
  value, which holds a `:`) as the last line of its header block, before the messages
  (`resume-pack` adds `--window <k> --budget 0`: its one window, and every omitted message).
- `human`'s and `resume-pack`'s opening summary over 4,000 chars ends with the house marker, and a
  `show <summary-id> --full` hint follows; `--full` prints it whole.

### Cuts never land inside

- a URL (the cut moves to the URL's end);
- a path that is the `target` of a `call` row (the path is kept whole, the rest of the target is
  cut);
- an id.

### `--full` is total for one command

`--full` on a listing lifts the head cap on every row and the row cap (`--limit`), and switches
`call` rows to include the full target. It does not change which kinds are shown (`--kind` does).
An agent that wants a whole session as rows runs `events <session> --full --limit 0` and gets a
`size:` header first; no default path produces that output.

## Principles

**Inherited:**
- [Session transcripts are the true full-resolution memory](../principles.md#session-transcripts-are-the-true-full-resolution-memory) — a cut is a rendering choice; the bytes are one flag away.
- [Pan and zoom, not dump](../principles.md#pan-and-zoom-not-dump).
