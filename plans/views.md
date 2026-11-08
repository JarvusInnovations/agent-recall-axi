---
status: done
pr: 12
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

- [x] `turns <fixture>` prints one row per human prompt with `events`, `calls`, `ended`
      (`stop`/`compaction`/`open` each exercised by fixtures); turn 0 appears only when the
      fixture has pre-prompt hooks.
- [x] `human <fixture>` prints every `H` event verbatim: a byte-for-byte test against the
      fixture's source strings, including a multi-line message, a queued message (without its
      wrapper), a slash command and an answer; no `summary`/`skill`/`hook`/`notice` text appears.
- [x] `human --window last` on the compaction fixture prints the post-boundary messages and then
      `summary:` with `authority: C`; `--window 0` prints the earlier ones and no summary.
- [x] `human --budget 300` drops oldest messages, prints `omitted: n` and a `--to <id>`
      continuation that, when run, yields exactly the omitted messages.
- [x] `human --rows` prints the standard row table.
- [x] `tools <fixture>` rows show `ok 1.1k`, `error 340`, `persisted 42.8k`, `image`, `pending`
      across fixtures; `--name read`, `--file *.env`, `--errors` filter as specified; `--full`
      prints input JSON and result text blocks.
- [x] `compactions <fixture>` lists each boundary with trigger, pre/post tokens, summary id and
      window index; `--full` appends summaries; the single-window fixture prints the definitive
      empty line.
- [x] `events --window 1`, `find --window last`, `tail --window 0` restrict correctly; `--window 5`
      on a two-window fixture → `VALIDATION_ERROR` naming the valid range.
- [x] Deterministic: running `human`/`turns`/`tools` twice yields identical bytes.

## Risks / unknowns

- **Turn boundaries with queued messages** — a `human.queued` never opens a turn; a test asserts
  a turn containing two queued messages counts `queued: 2`.
- **Pre-structured compaction logs** — summary-only fixture must still produce a window boundary
  at the summary (boundary and summary coincide; `compaction` row synthesized with `trigger:
  unknown`).

## Notes

Spec readings this plan settled, in the leading `docs(specs): views readings for windows, turns,
human, tools and compactions` commit:

- **A boundary-less summary is a boundary.** An event's window is the number of boundaries before
  it: a `compaction` counts after itself (it is the last event of the window it closes), a
  `summary` no compaction was waiting for counts before itself (it opens the next window). One
  rule (`src/lib/window-state.ts`) serves the offset table, `show`, `turns` and every
  `--window`. `compactions` lists the legacy boundary with `trigger: unknown` and the summary's
  id as both `id` and `summary`. This resolves the Risks item on pre-structured logs: the
  compaction row is synthesized in `compactions` only, never as an event row.
- **`ended: open` from the file, not the clock.** The data model said "last turn of a live
  session", and `live` depends on the clock (`principles.md#deterministic-output-for-the-same-file`).
  Now `open` means: the last turn, when the last of its assistant/thinking/call/result/answer/queued
  events is not assistant text. `compaction` wins over both other values.
- **Turns are selected by their opening prompt** (turn 0 by its first event, which is also its id)
  and counted whole, past a `--to`/window end. A turn a compaction cuts is listed once, in the
  window where it began.
- **`human` budget**: counts message text characters. The newest message is always printed whole
  (H is never cut); older ones are kept newest first while they fit, so the omitted ones are always
  the oldest and `--to <oldest kept>` yields exactly them. The `omitted:` line sits after `count:`
  in the header. The continuation carries `--from`/`--since`, `--window`, `--budget`, `--rows`,
  scope and `--tz`. The summary prints after the messages under `summary:` with `authority: C`.
- **Block form**: TOON's encoder renders uniform objects as a table, so `human`, `tools --full` and
  `compactions --full` use `renderBlockList` (the expanded `- key: value` list form, each item
  encoded by the library encoder). A test decodes the output and compares every text.
- **`--window` everywhere**: `events`, `tail`, `around`/`next`/`prev`, `find`, `turns`, `human`,
  `tools`. A selection other than `all` resolves through the offset table, building it when absent
  (so `tail --window` builds one, unlike plain `tail`). The table records `bounds`: compaction id,
  summary id, start position and cumulative per-kind counts at the window start. Its format went
  from version 2 to 3. On the pan verbs, counts, `at_start` and `at_end` are over the window, and
  an anchor outside it is `VALIDATION_ERROR` naming its window. A window past the last is
  `VALIDATION_ERROR` naming the range. `k..` runs to the end.
- **`tools`**: `--fields result_id,error,files` (the row schema's `result` is the status, so the
  id needed its own name). `--full` follows persisted outputs (`readPointer`, containment as in
  `show`). A late duplicate result does not change a call's status: the first linked result wins,
  as in `show` and `events`.
- **Module layout for the downstream plans**: `heldEvents` and the range helpers moved, unchanged,
  to `src/lib/hold.ts` so `windows.ts` can read boundary entries without an import cycle;
  `tableFor` moved into `cache/index.ts`. `resolveWindow` is the one helper every command calls.
  `turns()`, `humanMessages()`, `toolCalls()`/`toolCallsWithResults()`, `windows()`,
  `boundaries()`, `compactions()` and `openingSummary()` are exported from the package entry.
- **Seeded vs cold**: for each window of the generated pan session (its second compaction sits on
  a checkpoint boundary), `events`/`humanMessages`/`toolCalls`/`turns` read from the window's
  seeded checkpoint deep-equal a cold read filtered by the shared window rule. `show`'s window and
  the CLI pan count agree with them. A table extended across an append records the same windows
  as one built cold.
- **Review round** (PR #12). The rulings went into `docs(specs): views review rulings`, ahead of
  the fixes. `test/views-review.test.ts` has one test per finding; 11 of its 13 failed against the
  pre-fix source, and the other two are coverage the review asked for.
  1. `human`'s opening summary is `C` text: capped at 4,000 chars with the house marker and a
     `show <summary-id> --full` hint, and its capped length counts against the 12,000 total. The
     newest message still always prints whole.
  2. Sidechain boundaries no longer cut the main session. A `compact_boundary`, `isCompactSummary`
     or summary sentence on an `isSidechain` entry of a main file is `notice` (`source: parent`).
     So is a subagent's parent prompt that opens with the summary sentence.
  3. A compaction's summary is the next event after it; any other event ends the wait
     (classify's `link`). The opening summary is the window's first event, when that is a summary.
  4. The `turns` empty state counts the file's lines.
  5. `resolveWindow` validates library values (integer ≥ 0, `k..`, `last`, `all`). The range
     error's example index lies inside the range.
  6. Boundary reads release a wanted compaction at once (`heldEvents` `noHold`). Not observable
     through output, so it has no dedicated test.
  7. `events`/`tail --window` stop after the window's end once nothing waits for a partner. Also
     not observable, so no dedicated test; the window header's `malformed:` count comes from the
     table.
  8. The `turns` footer reads as `cli.md` says, followed by the `--to` continuation.
  9. `omitted:` stays the last header line, as `truncation.md` now says.
  10. A summary with no event before it is window 0's opening summary, not a boundary (the
      `compaction-legacy` fixture now has one window, and turn 0 ends `stop`).
  11. `tools --fields files` joins with `, `.
  12. A shared-`<s8>` session with several messages exercises `human`'s `omitted:` continuation
      under its full id. Cold output (no usable cache) is compared byte for byte with warm output
      (table present) for `human`, `turns`, `tools`, `compactions`, `events` and `tail`.
  13. `human.slash` keeps its args as stored; `authority.md` names it as the one reconstructed
      `H` kind.

  The window rule now tracks whether any event came before (`WindowCounter.seen`, seeded from a
  checkpoint's per-kind counts). The table format went from version 3 to 4.
- **Evidence (after the review round)**: `bun run check` and `bun run build` are clean.
  `bun run test` was run twice in full:
  - Both runs: unit 242/242.
  - Each run had one perf failure, the pan plan's `around` bounds: warm 406 ms against a 361 ms
    bound, then a cold build of 4,000.3 ms against 4,000 ms. The load average was about 11 on
    8 cores.
  - The perf project alone, run twice: 11/11, then one miss (359 ms against 350 ms).
- **Evidence (first pass)**: four full runs, unit 229/229 each. One run was fully green; the other
  three had one perf miss each. Measured by hand on a generated 200 MB file against
  `origin/develop`, built the same way: warm `around` took 291 ms there vs 285 ms here, and the
  cold build was 3.3–3.9 s for both, so the misses are host load, not a regression.
- Only synthetic fixtures exercise pre-`compact_boundary` logs (`compaction-legacy`).

## Follow-ups

- Issue [#13](https://github.com/JarvusInnovations/agent-session-axi/issues/13): `find --window`
  reports `lines scanned` counted from the file start, though the read starts at the window's
  checkpoint.
- Tracked as: [`resume-pack-library`](resume-pack-library.md) builds on `humanMessages`,
  `openingSummary`, `toolCalls` and `resolveWindow` (it owns the `resume-pack` command and its
  `--window last` default).
- Deferred to [`sessions-and-recall`](sessions-and-recall.md): `--json-out` on `turns`, `human`
  and `tools` (still registered as planned there, as on every listing).
