---
status: done
depends: [ids-and-show]
specs:
  - specs/cli.md
  - specs/api.md
  - specs/data-model.md
issues: [1]
pr: 6
---

# Plan: Find

## Scope

Single-session `find`: phrase (substring/regex), `--file` (substring/glob over files touched),
`--tool`, `--kind`, time and position ranges, `--window` (as a seq range; window computation
itself lands in `views`, so here `--window` is accepted only as `all` and the flag's full grammar
is deferred), `--context`/`--before`/`--after`, `--deep`, why-labels, and the `rows` vs `hits`
output. Cross-session scope lands in `sessions-and-recall`.

## Implements

- `specs/cli.md#find` — single-session form: required-filter rule, `why`, context assembly,
  `--deep`, empty state, footers.
- `specs/api.md` — `find(session, query)`, `FindQuery`, `Hit`.
- `specs/data-model.md#files-touched` and `#derived-target` — the fields `--file` and `--tool`
  match on.

## Approach

1. `src/lib/find.ts`: a streaming matcher over classified events keeping a ring buffer of
   `before` visible events and a lookahead of `after`; emits `Hit { event, why[], context[] }`.
   Phrase matching over `text` and stringified `input` for calls; `--file` over `files`; glob via
   a small matcher (`*`, `?`, `[...]`) only when glob chars are present.
2. `--deep`: for `result` events with a pointer, read the file and match; header `deep: yes`.
3. `commands/find.ts`: output `hits` when context is 0, `rows` with `why` column otherwise; header
   `scope`, `query`, `count: n of n hits (lines scanned)`; footers `around`, `show`, `--all` hint
   (which errors as not-yet-available until `sessions-and-recall`, with a clear message).

## Validation

- [x] `find <fixture> "redirect"` returns hits in every kind that contains the phrase (human,
      assistant, call input, and the call row of a result whose text contains it, per
      `specs/cli.md#find`) with `why: phrase`; case-insensitive.
- [x] `find <fixture> --file "*.env"` hits the Read/Edit calls and the Bash command that mentions
      `config/staging.env`, with `why: file`; `--file staging` (no glob) matches by substring.
- [x] `find <fixture> --tool bash` lists every shell call, `why: tool`; `--tool bash "test"`
      yields `why: phrase+tool` (the spec's fixed order).
- [x] `--kind human "deploy"` returns only human-class events.
- [x] `--context 2` prints two rows on each side with empty `why`, the hit row with `why` set,
      labeled `rows`; `--context 0` prints `hits` only; overlapping contexts are not duplicated.
- [x] `--regex "redir\w+"` works; an invalid regex → `VALIDATION_ERROR`.
- [x] `--from <id> --to <id>` limits by position; `--since 1h` by time (fixture clock injected).
- [x] `--deep` finds a phrase that exists only in a persisted-output file; without it, no hit.
- [x] No filter → exit 2 `USAGE`; zero hits → exit 0 with the definitive empty line and lines
      scanned.
- [x] Memory: find over the 200 MB fixture holds under 150 MB RSS.

## Risks / unknowns

- **Context counting across hidden kinds** — context is counted in visible events; a test with
  `thinking` between hits asserts the hidden rows do not consume context slots.
- **Shell path tokenization** — false positives (`a/b` in a sed expression). Accept; `--file`
  is a recall aid, and `why: file` makes the match inspectable.

## Notes

- **Spec settled first** (`docs(specs)` commit ahead of the code): one positional is the
  session when it has a session reference's form; handles AND together and `why` lists them in
  the fixed order phrase, file, tool, kind; searched kinds are the `events` default and a call
  matches a phrase in its linked result's text (the spec's own `phrase+file` example on a Read
  call needs this), results becoming their own rows only when `--kind` names `result` or
  `all`; `--regex` is
  case-insensitive and refuses invalid or exponential-backtracking patterns; `--file` globs
  anchor on the whole path with `*` crossing `/`. Two Validation criteria were amended to match
  in their own commit (result-text hits are call rows; `phrase+tool`, not `tool+phrase`).
- **Approach deviations.** The footer prints no `find … --all` hint: a hint that fails breaks
  "every hint resolves as printed", so it moves to `sessions-and-recall` with cross-session
  scope; `find` without a session fails with a USAGE message naming that plan. The `around`
  hint is gated on `around` being available in the reference (it lights up when `pan` merges);
  until then the footer offers `events <s> --from <hit> --limit 10`.
- **Regex guard** (`backtrackRisk`, narrowed in review): refuses an unbounded repetition of a
  group holding an unbounded quantifier or an overlapping alternation, and runs of 12+ optional
  atoms; bounded repetition and distinct-literal alternations pass. It catches the common
  exponential shapes only; a merely slow pattern is the caller's (#8). Node has no regex
  timeout, and V8's excessive-backtracks fallback did not take effect in Node 22. `--regex`
  compiles with `iu`.
- **Linking** reuses the `events()` hold: a call waits (with the rows after it) until its result
  is read, capped at 1,000 held events. Past an id `--to` bound nothing new is queued, so the
  scan reads at most 1,000 more lines to link waiting calls and then releases them `pending`
  (review: it used to read to EOF).
- **`--deep` streams** each followable persisted output in 1 MB chunks (`streamMatches`):
  substrings carry a needle-length overlap; a regex is tested line by line (spec states that a
  match spanning lines is not found there).
- **Hits past `--limit`** that fall inside a shown hit's context keep their `why`, count as
  shown, and the `--from` continuation starts after them.
- **Memory**: the perf project runs `find` over the 200 MB generated session (one hit; and
  `--tool bash` with a phrase that folds every result in) and `--deep` over a 120 MB persisted
  output (substring and regex); every run stays under 150 MB peak RSS.
- **Review round** (PR #6): spec amended first (`docs(specs): find review rulings`), then
  failing-first tests, then fixes; the shared resolver's NOT_FOUND hint now carries `--project`.

## Follow-ups

- Deferred to [`sessions-and-recall`](sessions-and-recall.md): cross-session `find` and the
  `find "<phrase>" --all` footer hint (cli.md#find example), printed only once it resolves.
- Tracked as: [`views`](views.md) already owns `--window <k|last>` on `find`.
- Issue [#7](https://github.com/JarvusInnovations/agent-session-axi/issues/7): hit rows show the
  head, so a match past the cut is invisible in the row.
- Issue [#8](https://github.com/JarvusInnovations/agent-session-axi/issues/8): guard polynomial
  regex backtracking over very long texts.
