---
status: in-progress
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

- [ ] `around <id>` default prints 5 visible rows before, the anchor, 5 after; `--before 2 --after
      0` prints 3 rows ending at the anchor; `--context 3` equals `--before 3 --after 3`.
- [ ] `next <id> 7` and `next <id> --limit 7` print the same 7 rows, all after the anchor; `prev`
      symmetric, rows in file order.
- [ ] Hidden kinds (`thinking`, `result`) between visible rows do not count toward `n`; with
      `--kind all` they do.
- [ ] At the file end, the header carries `at_end: true` and the footer omits `next`; symmetric
      at the start.
- [ ] Anchor on a silent entry: header notes the nearest visible start; `show` still works for the
      silent id.
- [ ] Offset cache: first `around` on the 200 MB fixture builds the table (< 4 s); the second
      completes under 300 ms; appending 1,000 lines extends the table without a rebuild (test
      inspects checkpoint count); truncating the file invalidates it and prints the rewrite notice.
- [ ] `cache status` lists the fixture with checkpoint count and size; `cache clear` removes the
      directory; every pan command still works afterwards.
- [ ] Deleting the cache directory mid-run never produces an error (recreated or bypassed).
- [ ] With a warm cache, `tail <200 MB fixture>` prints `count: 20 of <exact matching>`; with the
      cache absent it still prints the honest fallback (from `reader-and-event-model`).
- [ ] With a warm cache, `show` of an id near the end of the 200 MB fixture completes under
      300 ms and prints the same bytes as the cold forward scan, links included (from
      `ids-and-show`).

## Risks / unknowns

- **Link reconstruction from a seek** — a `result` whose call lies far before the anchor. Scan
  back to the turn start (human prompt) which bounds the search in practice; fall back to
  `call: unknown` with no error.
- **Cache concurrency** — two processes indexing the same file. Write via temp file + rename;
  readers tolerate a missing or partial table.

## Notes

(at closeout)

## Follow-ups

(at closeout)
