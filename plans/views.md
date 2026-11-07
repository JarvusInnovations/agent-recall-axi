---
status: planned
depends: [pan]
specs:
  - specs/cli.md
  - specs/api.md
  - specs/data-model.md
  - specs/behaviors/context-windows.md
  - specs/behaviors/authority.md
  - specs/behaviors/truncation.md
issues: [1]
---

# Plan: Views — turns, human, tools, compactions, windows

## Scope

Turn segmentation and `turns`; compaction windows, `--window` on every listing, `compactions`;
`human` (verbatim block output with budget, `--rows`); `tools` (status folding, `--name`,
`--file`, `--errors`, `--full` block form). Completes the `--window` grammar deferred by `find`.

## Implements

- `specs/data-model.md#turn`, `#window`.
- `specs/cli.md#turns-session`, `#human-session`, `#tools-session`, `#compactions-session`, and
  `--window` on `events`/`find`/`tail`.
- `specs/api.md` — `turns`, `windows`, `compactions`, `humanMessages`, `toolCalls`.
- `specs/behaviors/context-windows.md` — window indexing, summary placement, `preserved`.
- `specs/behaviors/authority.md` — `human` header `authority: H (verbatim)`; summary labeled `C`.
- `specs/behaviors/truncation.md` — `human` budget, `omitted:` line, `--full`.

## Approach

1. `src/lib/windows.ts`: boundary seqs (cached), window → seq range, `last`, `k..`.
2. `src/lib/turns.ts`: segment on `human`/`human.slash` events; count events/calls/queued; `ended`
   from the next boundary; turn 0 handling.
3. `humanMessages`: collect `H` events in range; newest-kept budget; `omitted` + `continueTo`;
   attach the window's opening `summary`.
4. `toolCalls`: filter by name/file/errors; status from linked result; `--full` block form.
5. Commands + footers per spec; `events`/`find`/`tail` gain `--window`.

## Validation

- [ ] `turns <fixture>` prints one row per human prompt with `events`, `calls`, `ended`
      (`stop`/`compaction`/`open` each exercised by fixtures); turn 0 appears only when the
      fixture has pre-prompt hooks.
- [ ] `human <fixture>` prints every `H` event verbatim: a byte-for-byte test against the
      fixture's source strings, including a multi-line message, a queued message (without its
      wrapper), a slash command and an answer; no `summary`/`skill`/`hook`/`notice` text appears.
- [ ] `human --window last` on the compaction fixture prints the post-boundary messages and then
      `summary:` with `authority: C`; `--window 0` prints the earlier ones and no summary.
- [ ] `human --budget 300` drops oldest messages, prints `omitted: n` and a `--to <id>`
      continuation that, when run, yields exactly the omitted messages.
- [ ] `human --rows` prints the standard row table.
- [ ] `tools <fixture>` rows show `ok 1.1k`, `error 340`, `persisted 42.8k`, `image`, `pending`
      across fixtures; `--name read`, `--file *.env`, `--errors` filter as specified; `--full`
      prints input JSON and result text blocks.
- [ ] `compactions <fixture>` lists each boundary with trigger, pre/post tokens, summary id and
      window index; `--full` appends summaries; the single-window fixture prints the definitive
      empty line.
- [ ] `events --window 1`, `find --window last`, `tail --window 0` restrict correctly; `--window 5`
      on a two-window fixture → `VALIDATION_ERROR` naming the valid range.
- [ ] Deterministic: running `human`/`turns`/`tools` twice yields identical bytes.

## Risks / unknowns

- **Turn boundaries with queued messages** — a `human.queued` never opens a turn; a test asserts
  a turn containing two queued messages counts `queued: 2`.
- **Pre-structured compaction logs** — summary-only fixture must still produce a window boundary
  at the summary (boundary and summary coincide; `compaction` row synthesized with `trigger:
  unknown`).

## Notes

(at closeout)

## Follow-ups

(at closeout)
