---
status: planned
depends: [find, views]
specs:
  - specs/cli.md
  - specs/api.md
  - specs/data-model.md
  - specs/architecture.md
  - specs/behaviors/time-and-scope.md
  - specs/behaviors/privacy.md
issues: [1]
---

# Plan: Sessions and recall

## Scope

The zoomed-out rung and cross-session memory: session stats and titles (index-accelerated),
the full `sessions` schema and `--subagents`, the content-first home view with `last_human`,
cross-session `find` (`--project`/`--all`), the term index, and `recall`.

## Implements

- `specs/data-model.md#session` — stats, `title` precedence, `live`, `sessions-index.json` as an
  optional accelerator.
- `specs/cli.md#home-view-no-arguments` (non-hook mode), `#sessions`, `#find` (cross-session),
  `#recall`, `#cache`.
- `specs/api.md` — `listSessions`, `sessionStats`, `findAcross`, `recall`.
- `specs/architecture.md#cache` — stats + term index, incremental refresh.
- `specs/behaviors/time-and-scope.md` — `--project` forms, `--all`, `--subagents`.
- `specs/behaviors/privacy.md` — cache permissions, `cache clear`.

## Approach

1. `src/lib/adapters/claude-code/sessions.ts`: titles (`custom-title.json` → last `ai-title` →
   first human head), stats via the cache (computed on first touch by a single streaming pass
   that also builds the offset table), `sessions-index.json` read for `title`/`last` when the
   file's mtime matches.
2. Home view: `project:`, `sessions[5]`, `latest`, `last_human` from a tail read of the latest
   file; < 300 ms on 100 sessions (measured in CI with generated sessions).
3. `findAcross`: iterate sessions in scope newest first, apply `--since`, stream `find`, label
   hits with `<s8>`; header `scanned:`.
4. Term index: lower-cased word tokens from `H`, `C` and `call` text → seq lists, per session,
   refreshed incrementally; `recall` consults it for candidate sessions then verifies hits by
   scanning only candidate windows; falls back to streaming scan and reports `index:`.
5. `cache status|clear` complete.
6. Session `last` becomes the exact max entry timestamp from the stats pass, replacing the
   tail-256 KB read `reader-and-event-model` shipped; `title` replaces the `(pending)` placeholder
   (deferred from [`reader-and-event-model`](reader-and-event-model.md)).
7. `AMBIGUOUS_SESSION` candidates (`src/lib/ids.ts`) carry the session title from the same
   precedence instead of `(pending)` (deferred from [`ids-and-show`](ids-and-show.md)).
   The `resume-pack` header (`src/output/resume.ts`, `(title pending)` today) gets the same
   title, and `recall`, `RecallResult`, `sessionStats` and `findAcross` are exported from the
   package entry and used in `test/consumer/consumer.ts` with their spec'd signatures: `test/api.test.ts` exempts them from the `api.md` export audit only while this
   plan is not `done` (deferred from [`resume-pack-library`](resume-pack-library.md)).
8. `find`'s footer gains the `find "<phrase>" --all` hint (cli.md#find example) once
   cross-session scope runs, and `find` without `<session>` stops failing with the
   not-yet-available USAGE error (deferred from [`find`](find.md), which omitted the hint
   rather than print one that fails).
9. `--json-out[=path]` (cli.md#conventions): the flag has been registered as `planned:
   sessions-and-recall` on every listing since `reader-and-event-model`, including the views
   `turns`, `human` and `tools`. Write the complete, uncapped result as JSON (owner-only temp file
   when no path is given) while stdout keeps the TOON view (deferred from [`views`](views.md)).

## Validation

- [ ] `sessions` on a fixture project prints `{id,started,last,turns,title}`; titles follow the
      precedence (three fixtures: custom title, ai-title only, neither); `--fields calls,
      compactions,humans,live,bytes,lines` all populate.
- [ ] A stale `sessions-index.json` (wrong `messageCount`, missing a session) never changes
      `turns` or omits a session; a listed-but-deleted session is not shown.
- [ ] `--subagents` adds subagent rows with `kind`/`parent`; without it they are absent but still
      resolvable by id.
- [ ] Home view on the fixture project prints `project:`, five sessions, `latest`, `last_human`
      with id and time, and five `help[]` lines; with no matching project prints `project: none`
      and five cross-project sessions. Timing test: 100 generated sessions < 300 ms.
- [ ] `find "phrase" --project <fixture-project>` returns hits from two sessions with distinct
      `<s8>` prefixes and `scanned: 2 sessions`; `--all` spans both fixture projects; `--since`
      excludes the old one.
- [ ] `recall "phrase"` groups by session with `hits` and `first`, newest first; `scanned:` and
      `index: none` on first run, `index: fresh` on the second with identical results; results
      also identical with the cache deleted.
- [ ] Measured: `recall` over 20 copies of the 200 MB fixture completes cold (no index) and warm
      (indexed); both timings recorded in Notes with the verdict on whether an indexed store is
      needed.
- [ ] `recall` with no matches prints the definitive empty line with the scanned count and a
      `--since 1y` hint.
- [ ] Cache directory and files are created `0700`/`0600`; `cache clear --project` removes only
      that project's entries; `cache status` reports sizes.
- [ ] A fixture whose newest timestamp lies more than 256 KB before the end of the file lists
      that timestamp as `last` (from `reader-and-event-model`).
- [ ] `find <s8> "phrase"` prints a `find "phrase" --all` hint that runs, and `find "phrase"`
      with no session searches the current project (from `find`).
- [ ] An ambiguous prefix's `AMBIGUOUS_SESSION` `details.candidates` show each session's real
      title (from `ids-and-show`).
- [ ] Relative times appear only in `sessions` and home; a test with a frozen clock asserts
      every other command's output is clock-independent.

## Risks / unknowns

- **Scan cost at scale** — hundreds of sessions, gigabytes. The decision is a dependency-free
  term index in the cache dir with default `--since 90d`; the first `recall` is honest about its
  cost (`scanned:` with time). SQLite (or any native dependency) is considered only if a measured
  scan over a realistic corpus (the 200 MB fixture × 20, recorded in Notes) is too slow for the
  bots' use, and that measurement is part of this plan's closeout.
- **Title quality** — `ai-title` may be absent on bots' sessions; the first-human-head fallback
  is always available.

## Notes

(at closeout)

## Follow-ups

(at closeout)
