---
status: done
pr: 16
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

- [x] `sessions` on a fixture project prints `{id,started,last,turns,title}`; titles follow the
      precedence (three fixtures: custom title, ai-title only, neither); `--fields calls,
      compactions,humans,live,bytes,lines` all populate.
- [x] A stale `sessions-index.json` (wrong `messageCount`, missing a session) never changes
      `turns` or omits a session; a listed-but-deleted session is not shown.
- [x] `--subagents` adds subagent rows with `kind`/`parent`; without it they are absent but still
      resolvable by id.
- [x] Home view on the fixture project prints `project:`, five sessions, `latest`, `last_human`
      with id and time, and five `help[]` lines; with no matching project prints `project: none`
      and five cross-project sessions. Timing test: 100 generated sessions < 300 ms.
- [x] `find "phrase" --project <fixture-project>` returns hits from two sessions with distinct
      `<s8>` prefixes and `scanned: 2 sessions`; `--all` spans both fixture projects; `--since`
      excludes the old one.
- [x] `recall "phrase"` groups by session with `hits` and `first`, newest first; `scanned:` and
      `index: none` on first run, `index: fresh` on the second with identical results; results
      also identical with the cache deleted.
- [ ] Measured: `recall` over 20 copies of the 200 MB fixture completes cold (no index) and warm
      (indexed); both timings recorded in Notes with the verdict on whether an indexed store is
      needed.
- [x] `recall` with no matches prints the definitive empty line with the scanned count and a
      `--since 1y` hint.
- [x] Cache directory and files are created `0700`/`0600`; `cache clear --project` removes only
      that project's entries; `cache status` reports sizes.
- [x] A fixture whose newest timestamp lies more than 256 KB before the end of the file lists
      that timestamp as `last` (from `reader-and-event-model`).
- [x] `find <s8> "phrase"` prints a `find "phrase" --all` hint that runs, and `find "phrase"`
      with no session searches the current project (from `find`).
- [x] An ambiguous prefix's `AMBIGUOUS_SESSION` `details.candidates` show each session's real
      title (from `ids-and-show`).
- [x] Relative times appear only in `sessions` and home; a test with a frozen clock asserts
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

Spec readings settled, in the leading `docs(specs): session stats, home sources, cross-session
find, recall and --json-out readings` commit, then `docs(specs): the span grammar takes years`
and `docs(specs): the resume pack carries the session title`:

- **recall searches H and C events only.** A call matches on its text and input, never on its
  result's text, and `--kind` with a D kind is `VALIDATION_ERROR` pointing at `find --all`. The
  term index covers exactly H, C and call text (architecture.md already said so), and the plan
  requires an indexed recall to equal a scanned one. Both hold only if recall tests what the
  index holds. Tool output stays `find`'s.
- **The term index skips only what cannot match.** Tokens are lower-cased runs of letters,
  digits and `_`. Every word run of a phrase lies inside a word run of any text that contains
  the phrase, so a line becomes a candidate when every phrase run is a substring of one of its
  tokens. Candidates are verified by classifying from their checkpoint. A `--regex` phrase, or one
  with no word characters, scans (`index: none`). An appended file is indexed from the index's
  last seq, in the same pass that extends the table (`partial`).
- **Stats ride on the table** (format 4 → 5). The tail record carries the first and newest
  timestamps, the model, and the line positions of the last `custom-title` entry, the last
  `ai-title` entry and the first `human` event. A `stats/` mirror carries the table's identity, so
  a listing reads about 600 bytes per session. The title is read back from its line, never
  cached as text. The real logs checked locally (key names only) carry `custom-title` entries next
  to `custom-title.json`, so the entry joined the precedence after the json file.
- **`sessions` computes stats for every session in scope**, so order and `last` are exact. The
  first touch is one streaming pass per session; after that, the mirror is read.
  `sessions-index.json` accelerates the home view only: its `summary`/`modified` are used while
  `fileMtime` matches, and never for counts.
- **Home view**: main sessions ordered by mtime (as `latest` resolves). Each row comes from cached
  stats (an append of up to 8 MB extends them), else the index, else the mtime with a 1 MB head
  read for the title and an empty `turns` cell. `last_human` is a 4 MB backward read; its line is
  numbered from the nearest point the cache knows (the mirror's end or a table checkpoint), or
  by a newline count from the file start. While `resume-pack` was planned, the first hint was
  `human <latest> --window last`; since #14 merged it is `resume-pack <latest>`.
- **Cross-session `find`/`recall`** read every main and subagent session in scope, newest mtime
  first, and skip a file last modified before the window's start. An id bound without a session
  is `VALIDATION_ERROR`. `find --all` defaults to 90 days and says so (`since:`). Paging continues
  the last shown hit's session by id and offers `--limit 0`.
- **`--json-out[=path]`**: the path is given only with `=`. Exports stream library objects with
  ids as printed and ISO times. A given path is written `0600`; with no path, the export goes to
  `<command>.json` in a fresh `0700` directory under `TMPDIR`. A missing directory is
  `VALIDATION_ERROR` before any read. `resume-pack` carried the flag too, so it writes the pack.
- **Spans take `y`** (365 days): recall's spec'd `--since 1y` hint did not parse.
- **Performance work**: the per-entry stats step first cost about 0.7 s on the 200 MB table build.
  A canonical-timestamp fast path and no per-line closures brought it back to noise (3.9–4.8 s
  against 3.7–4.2 s without stats, at load average about 14). `listSessions` lists sidecar
  directories once instead of a stat per session.
- **Home budget test**: 300 ms (×2 on CI), or the floor plus 100 ms when the floor is slower. The
  floor is `sessions --project <missing>`: it loads the same graph and makes the first Intl call
  (about 38 ms here, which every command pays), then stops. Two cases are covered: 100 small
  sessions cold, and a warm 64 MB latest session. On this host (load average about 14), the final
  code passed 3 of 3 standalone runs and both full-suite runs. Before the `listSessions` change,
  the cold case missed by up to 12 ms in 2 of 5 runs, so it sits close to the bound on a loaded
  host.
- **recall at scale, measured by hand** on 20 hard links of one generated 200 MB session (4.2 GB;
  distinct paths, so 20 tables and indexes), load average about 14:
  - cold: 101.9 s, peak RSS 269 MB;
  - warm (`index: fresh`): 3.5 s, peak RSS 195 MB;
  - cache: 117 MB for the 20 sessions (about 1.6 MB table and 4.4 MB terms each).

  **Verdict: no indexed store (SQLite) is needed.** The warm path answers 4.2 GB in seconds, and
  most of its time is loading the per-session table and terms JSON. The cold pass is a one-time
  cost per session, honestly reported in `scanned:`. That Validation box stays unchecked: the
  host had about 300 MB of free disk, so these were hard links, not copies, and they shared the
  page cache.
- One cold 200 MB session alone peaks at about 165 MB RSS (sessions: 128 MB). The live heap fits
  in 60 MB (the run passes with `--max-old-space-size=60`); the excess is young-generation
  garbage from token collection. Filed as #18.
- Evidence on the final tree: `bun run check`, `bun run build` and `bun run check:types` are
  clean. `bun run test` passed twice in full, 30 files and 329/329 each.
- Rebased onto develop after #14 merged, keeping both sides of each conflict (exports, cli
  wiring, fixture builder). Absorbed #14's deferrals: the real title in the `resume-pack` header
  (`ResumePack.title`), and the new exports in `test/api.test.ts` and `test/consumer/consumer.ts`.

## Follow-ups

- Issue [#17](https://github.com/JarvusInnovations/agent-session-axi/issues/17): single-session
  headers still print `(title pending)`; a deterministic title there costs a whole-file pass.
- Issue [#18](https://github.com/JarvusInnovations/agent-session-axi/issues/18): a cold `recall`
  of a 200 MB session peaks at about 165 MB RSS (young-generation churn in token collection).
- Tracked as: the plan's 20-copy `recall` measurement on real copies (not hard links) needs a
  host with about 5 GB free; the hard-link timings above stand in until then.
- Tracked as: the home view's hook mode is owned by [`skill-and-hook`](skill-and-hook.md).
