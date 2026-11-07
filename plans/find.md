---
status: in-progress
depends: [ids-and-show]
specs:
  - specs/cli.md
  - specs/api.md
  - specs/data-model.md
issues: [1]
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

- [ ] `find <fixture> "redirect"` returns hits in every kind that contains the phrase (human,
      assistant, call input, and the call row of a result whose text contains it, per
      `specs/cli.md#find`) with `why: phrase`; case-insensitive.
- [ ] `find <fixture> --file "*.env"` hits the Read/Edit calls and the Bash command that mentions
      `config/staging.env`, with `why: file`; `--file staging` (no glob) matches by substring.
- [ ] `find <fixture> --tool bash` lists every shell call, `why: tool`; `--tool bash "test"`
      yields `why: phrase+tool` (the spec's fixed order).
- [ ] `--kind human "deploy"` returns only human-class events.
- [ ] `--context 2` prints two rows on each side with empty `why`, the hit row with `why` set,
      labeled `rows`; `--context 0` prints `hits` only; overlapping contexts are not duplicated.
- [ ] `--regex "redir\w+"` works; an invalid regex → `VALIDATION_ERROR`.
- [ ] `--from <id> --to <id>` limits by position; `--since 1h` by time (fixture clock injected).
- [ ] `--deep` finds a phrase that exists only in a persisted-output file; without it, no hit.
- [ ] No filter → exit 2 `USAGE`; zero hits → exit 0 with the definitive empty line and lines
      scanned.
- [ ] Memory: find over the 200 MB fixture holds under 150 MB RSS.

## Risks / unknowns

- **Context counting across hidden kinds** — context is counted in visible events; a test with
  `thinking` between hits asserts the hidden rows do not consume context slots.
- **Shell path tokenization** — false positives (`a/b` in a sed expression). Accept; `--file`
  is a recall aid, and `why: file` makes the match inspectable.

## Notes

(at closeout)

## Follow-ups

(at closeout)
