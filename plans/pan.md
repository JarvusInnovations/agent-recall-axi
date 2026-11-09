---
status: done
pr: 11
depends: [ids-and-show]
specs:
  - specs/cli.md
  - specs/api.md
  - specs/architecture.md
  - specs/behaviors/time-and-scope.md
issues: [1]
---

# Plan: Pan

## Scope

`around`, `next`, `prev` (and `tail` rebased onto the same engine), the line-offset cache that
makes seeking by seq cheap on large files, and the edge hints (`at start/end of session`,
continuation commands). `--before`/`--after`/`--context` as visible-event counts.

## Implements

- `specs/cli.md#around-id--next-id--prev-id` and `#tail-session`.
- `specs/api.md` — `around`, `next`, `prev`, `tail`.
- `specs/architecture.md#streaming-and-memory` and `#cache` — offset table (every 256th line),
  incremental refresh for appended files, invalidation on rewrite.
- `specs/behaviors/time-and-scope.md` — counts are over visible events.

## Approach

1. `src/lib/cache/index.ts`: offset table + last-indexed seq/hash per file; build lazily on first
   seek, extend on append; `cache status` reports it.
2. `src/lib/events.ts`: `seekToSeq` (nearest checkpoint, then forward), context reconstruction
   for tool links (scan back to the enclosing turn start), `around`/`next`/`prev` over visible
   kinds; `atStart`/`atEnd`.
3. `commands/pan.ts`: shared renderer; header `anchor:`; footer with edge ids; positional `<n>`.
4. Travel from silent/hidden anchors begins at the nearest visible event in the direction of
   travel, noted in the header.
5. Exact `count: <shown> of <matching>` for newest-last listings (`tail`, default `events`): keep
   a per-kind visible-event count in the cache so the header no longer falls back to
   `count: N (newest; earlier rows exist)` (deferred from
   [`reader-and-event-model`](reader-and-event-model.md)).
6. `show` seeks by seq through the offset table and rebuilds call/result context from the
   enclosing turn, instead of the forward scan from the file start it shipped with; the
   per-file identity record in `src/lib/cache/store.ts` gains the last-indexed seq (deferred
   from [`ids-and-show`](ids-and-show.md)).

## Validation

- [x] `around <id>` default prints 5 visible rows before, the anchor, 5 after; `--before 2 --after
      0` prints 3 rows ending at the anchor; `--context 3` equals `--before 3 --after 3`.
- [x] `next <id> 7` and `next <id> --limit 7` print the same 7 rows, all after the anchor; `prev`
      symmetric, rows in file order.
- [x] Hidden kinds (`thinking`, `result`) between visible rows do not count toward `n`; with
      `--kind all` they do.
- [x] At the file end, the header carries `at_end: true` and the footer omits `next`; symmetric
      at the start.
- [x] Anchor on a silent entry: header notes the nearest visible start; `show` still works for the
      silent id.
- [x] Offset cache: first `around` on the 200 MB fixture builds the table (< 4 s); the second
      completes under 300 ms; appending 1,000 lines extends the table without a rebuild (test
      inspects checkpoint count); truncating the file invalidates it and prints the rewrite notice.
- [x] `cache status` lists the fixture with checkpoint count and size; `cache clear` removes the
      directory; every pan command still works afterwards.
- [x] Deleting the cache directory mid-run never produces an error (recreated or bypassed).
- [x] With a warm cache, `tail <200 MB fixture>` prints `count: 20 of <exact matching>`; with the
      cache absent it still prints the honest fallback (from `reader-and-event-model`).
- [x] With a warm cache, `show` of an id near the end of the 200 MB fixture completes under
      300 ms and prints the same bytes as the cold forward scan, links included (from
      `ids-and-show`).

## Risks / unknowns

- **Link reconstruction from a seek** — a `result` whose call lies far before the anchor. Scan
  back to the turn start (human prompt) which bounds the search in practice; fall back to
  `call: unknown` with no error.
- **Cache concurrency** — two processes indexing the same file. Write via temp file + rename;
  readers tolerate a missing or partial table.

## Notes

Spec readings this plan settled, in the leading `docs(specs): pan headers, edges and the
offset-table record` commit and the later wording fix `docs(specs): anchor_note wording and
tail's use of an existing table`:

- **Rebuilt as PR #11** on develop after `find` (#6) merged; it supersedes #9. The original
  commits were cherry-picked without conflicts, and a review round followed (below).
- **Checkpoints carry classification state, not just offsets** (replaces Approach 2's "scan back
  to the enclosing turn start"). Each checkpoint records the calls still pending (id, tool,
  files), the compaction waiting for its summary, the turn and window in effect, the last event,
  and the cumulative per-kind counts. A read seeded from it classifies exactly as a scan from the
  file start, with no unbounded backward scan. The cumulative counts let `--before` pick its
  start checkpoint without scanning, so one forward read serves both directions.
- **The table is its own record and carries its own identity** (Approach 6). It records its
  last-indexed seq, end offset, head hash and the last indexed line's offset, length and hash. It
  lives in `index/<hash>.json` beside the identity record, rather than inside it. The table is
  discarded when that identity no longer matches the file; `checkRewrite` also deletes it when
  it detects a rewrite. Keeping it separate avoids rewriting a ~100 KB record on every read, and
  avoids write races between the two records. `architecture.md` and `id-stability.md` say so.
- `anchor_note:` explains a silent or hidden anchor. `at_start: true` / `at_end: true` are
  printed only when true. `count:` is `<shown> of <every visible event of those kinds>`. The
  labels are `rows`, `next` and `prev`. The empty state is `next: 0 events after <id> (at end of
  session)` (TOON quotes it, since it contains `:`).
- `--context` sets both sides, and an explicit `--before`/`--after` overrides its side. A bare
  id of a multi-event entry anchors on the whole entry. `next`/`prev --full` without `n` lifts
  the row cap, as on `events`. The pan verbs also take `--fields`, `--session` and
  `--project|--all`.
- `tail`'s footer is `prev <first-id>` (cli.md#tail-session). The spec'd `resume-pack <session>`
  footer is not printed yet, because that command is still planned (deferred below). `events`
  keeps its `--to`/`--from` range footers, which carry the bound.
- `tail` never builds a table. It uses an existing one, extending it over an append of up to
  8 MB, and otherwise prints the old honest fallback.
- `show` seeks to the checkpoint at or before the entry. It falls back to the forward scan
  (`showFromStart`) for a compaction, whose preserved count needs every earlier uuid (#10), and
  for a result with no linked call (its `tool` may come from a call before the checkpoint).
  `show` builds the table only up to the entry it reads. (Review round: the unlinked-result
  fallback is gone, because the tool map is now seeded.)
- A pan row waits for its partner before the read stops: a call for its result, and a
  compaction for its summary. The property test caught a missing summary id here.
- `Line.end` was added to the reader, so table offsets come from the bytes read, never from
  re-encoding decoded text.
- `cache status` prints `cache`, `size`, `tracked`, `count`, then
  `indexed[N]{session,lines,checkpoints,size,state,path}`, with state `fresh | appended |
  rewritten | missing`. `cache clear` deletes the directory, and `--project` deletes only that
  project's records. Clearing an absent cache is a no-op.
- **Perf, measured by hand on a loaded 8-core host (load average ~11) on the 200 MB fixture:**
  - The table build (the first `around`) takes 2.7 s with 97 MB peak RSS. It took 5.8 s until
    only the last indexed line was hashed, instead of every line.
  - Warm `around` takes 0.26–0.29 s and warm near-end `show` 0.22–0.29 s (best of 5). The
    `--help` floor on the same host is 0.16 s; process start-up and module load dominate.
- **The perf test's 300 ms bound** is 300 ms (×2 on CI), or the host's floor for the same
  command graph (`show` of line 1, best of five) plus 100 ms, whichever is larger. Under the full
  parallel suite on this loaded host, a flat 300 ms flaked; in isolation the flat bound held.
- **"Same bytes as the cold forward scan"** is checked at the library level. The seeked `show`
  returns a `Shown` deep-equal to `showFromStart`, on the 200 MB file and on ~250 ids of the
  generated pan session; rendering is a pure function of `Shown` and the flags. Warm and cold CLI
  outputs are also compared byte for byte.
- **"Deleting the cache directory mid-run"** is tested between commands (the cache is deleted,
  corrupted, or made unwritable) and through the library's swallow-all writes. A deletion inside
  a single process's read is covered by that code path, not by a dedicated test.
- **Review round** (each fix has a test that failed before the fix; the rulings are in `docs(specs): review
  rulings for the offset table, tail, the hold rule and the cache's contents` and `docs(specs):
  cache clear --project by stored path; fresh with a partial tail`):
  1. Checkpoints dropped the tool-use id → tool map, so a late duplicate question result was
     classified `result` after a seek but `human.answer` cold, and counts depended on how the
     table was built. The map is now a seq-stamped `<seq>\t<use>\t<tool>` log stored once per
     table and searched on demand. A parsed map cost about 40 ms per seek on the 200 MB file;
     the log costs nothing until a miss. The table format went from version 1 to 2.
  2. Pan and `events()` held rows by different rules (lines vs held events; compaction
     summaries). Both now use `heldEvents()`. `find.ts` keeps its own copy, which folds results
     in, under the same rule.
  3. The table records the package version and is discarded on a mismatch.
  4. With a table, `tail` and the default `events` read their rows forwards from the
     checkpoint (the `prev`-from-the-end engine), so the rows and the exact count agree. This
     closes the Scope's "tail rebased onto the same engine".
  5. The perf floor is `show` of line 1 with an unusable cache location.
  6. `privacy.md` lists what the cache may hold and names `recall`'s planned term index as the
     one exception to "never text". A test greps built tables for fixture text. It passed
     before and after, since no text was ever stored.
  7. Hygiene: temp files are cleaned up on a failed rename. `clear --project` matches by
     stored path. A partial trailing line counts as `fresh`. Records not owned by the user, or
     group/other-writable, are ignored. Nothing is written through a symlinked directory.
  8. Pan headers always carry `count:`.
  9. The spec now states `tail`'s 8 MB extension bound.
- Evidence: `bun run check` and `bun run build` are clean. `bun run test` was run twice:
  - Run 1: 20 files, 208 tests, all passed.
  - Run 2: one perf failure. The cold build took 4.12 s against the 4 s bound, at load average
    about 12 on 8 cores; the build is dominated by `JSON.parse` of every line.
  - The perf project alone, right after: 11 tests, all passed.
  - By hand: cold build 3.3–3.5 s with 128 MB RSS. Warm `around`/`show` 0.26–0.30 s best of 7,
    against a 0.28 s floor.

## Follow-ups

- Issue [#10](https://github.com/JarvusInnovations/agent-session-axi/issues/10) — `show` of a
  compaction scans from the file start (its preserved count needs per-uuid event counts).
- Deferred to [`resume-pack-library`](resume-pack-library.md) — `tail`'s
  `resume-pack <session>` footer (cli.md#tail-session), once the command exists.
