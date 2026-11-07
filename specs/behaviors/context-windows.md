# Behavior: Context windows and compactions

## Rule

A session is divided into windows by its compaction boundaries. Commands default to the whole
file; `--window` narrows to one window, and `resume-pack` defaults to the last window because that
is what the agent's live context held when it was interrupted.

## Applies To

`events`, `turns`, `human`, `tools`, `find`, `compactions`, `resume-pack`.

## Details

- Window indexes are 0-based in file order. `--window last` is the highest; `--window all` is the
  default and may be omitted; `--window 2` is exact; `--window 2..` runs to the end.
- The `compaction` event is the last event of the window it closes. The `summary` event that
  follows it opens the next window.
- A session with no compaction has one window, `0`, which is also `last`.
- `compactions <session>` lists every boundary with trigger, pre/post token counts, dropped tokens,
  the summary id and the window sizes on both sides, so an agent can see how much history each
  summary stands in for.
- After a boundary, `human` output and `resume-pack` include the opening `summary` as a `C`-class
  layer, clearly labeled, never merged into the human text.
- Cold-start logic keys on the structured boundary (`system/compact_boundary`), not on the summary's
  opening sentence; the sentence is a fallback for logs that predate the structured entry.
- The compaction record's `preservedMessages` (uuids the harness kept verbatim across the boundary)
  is surfaced by `show <compaction-id>` as `preserved: <n> events` with their ids, so an agent can
  tell which recent events survived compaction untouched.

## Principles

**Inherited:**
- [Session transcripts are the true full-resolution memory](../principles.md#session-transcripts-are-the-true-full-resolution-memory) — a window is a slice of it, not a different record.
- [Deterministic output for the same file](../principles.md#deterministic-output-for-the-same-file) — `resume-pack` for a given window is reproducible.
