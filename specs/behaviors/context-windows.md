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
- The `compaction` event is the last event of the window it closes. Its summary is the next
  *event* after it (silent entries may come between): any other event, a human prompt included,
  ends the wait and leaves the compaction without a summary. That summary opens the next window.
- A session with no compaction has one window, `0`, which is also `last`.
- **A summary with no boundary before it** (a log that predates the structured entry: a
  `summary` event with no `compaction` waiting for it) is itself the boundary, when at least one
  event precedes it. It opens the next window, so the window before it ends at the event just
  before it. `compactions` lists it with `trigger` `unknown`, its own id as both `id` and
  `summary`, and empty `pre`/`post`. A summary with no event before it is no boundary: it is
  window 0's opening summary.
- **Sidechains never cut the main session.** A `compact_boundary`, an `isCompactSummary` entry or
  a legacy summary sentence on an `isSidechain` entry of a main session file belongs to a
  subagent's context, not the main one: it is a `notice` with `meta.source: parent`, never a
  boundary. In a subagent session, text without a human origin that opens with the summary
  sentence is the parent's prompt (`notice`, `meta.source: parent`), not a summary.
- An event's window is the number of boundaries before it in file order: a `compaction` counts
  after itself, a boundary-less `summary` (with events before it) before itself. `show` prints that number; every
  listing's `--window k` keeps exactly the events whose number is `k`, and `compactions` reports
  the same boundaries, so every command agrees on where a window begins and ends.
- `--window k` past the last window (or `k..` from one) is `VALIDATION_ERROR` naming the valid
  range (`windows 0..1`). On the pan verbs, an anchor outside the selected window is
  `VALIDATION_ERROR` naming the anchor's window; counts, `at_start` and `at_end` are then over
  that window. `turns --window k` lists the turns whose opening prompt lies in window `k`, each
  counted whole (a turn that a compaction cuts is listed once, in the window where it began).
- Selecting a window (anything but `all`) locates its boundaries through the cache's offset
  table (`architecture.md#cache`), building it when absent, as a seek does; the default `all`
  never needs it.
- `compactions <session>` lists every boundary with trigger, pre/post token counts, the summary
  id and the window it opens; `--full` adds the dropped tokens, the event counts of the windows
  on both sides and the summary text, so an agent can see how much history each summary stands
  in for.
- A window's **opening summary** is a `summary` that is the window's first event (at or after the
  window's start). When `--window` selects a window that begins with one, `human` and
  `resume-pack` (whose default window is `last`) include it as a `C`-class layer, clearly
  labeled, never merged into the human text. A summary further into a window opens nothing.
- Cold-start logic keys on the structured boundary (`system/compact_boundary`), not on the summary's
  opening sentence; the sentence is a fallback for logs that predate the structured entry.
- The compaction record's `preservedMessages` (uuids the harness kept verbatim across the boundary)
  is surfaced by `show <compaction-id>` as `preserved: <n> events` with their ids, so an agent can
  tell which recent events survived compaction untouched.

## Principles

**Inherited:**
- [Session transcripts are the true full-resolution memory](../principles.md#session-transcripts-are-the-true-full-resolution-memory) — a window is a slice of it, not a different record.
- [Deterministic output for the same file](../principles.md#deterministic-output-for-the-same-file) — `resume-pack` for a given window is reproducible.
