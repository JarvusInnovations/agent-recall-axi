---
status: planned
depends: [reader-and-event-model]
specs:
  - specs/data-model.md
  - specs/cli.md
  - specs/behaviors/id-stability.md
  - specs/behaviors/truncation.md
  - specs/behaviors/authority.md
issues: [1]
---

# Plan: Ids and show

## Scope

The id grammar end to end — parse, format, resolve (uuid, agentId, ≥8-hex prefix, `latest`,
path; entry and block ids; ambiguity; silent entries) — and `show`/`zoom`, the zoom rung, with
`--full`, `--raw`, pointer following and the truncation module that every later listing uses.
Includes rewritten-file detection (head hash + length) and the id-stability test.

Out of scope: pan verbs (`pan`), search (`find`), the offset cache (`pan`).

## Implements

- `specs/data-model.md#identifiers` — session reference, `<s8>`, entry/event ids, block index,
  tool-call linkage lookups.
- `specs/cli.md#show-id-alias-zoom` — detail view by kind, `blocks[N]` for multi-event entries,
  `--raw`, pointer display, `zoom` alias.
- `specs/behaviors/id-stability.md` — resolution failures, silent-entry handling, rewrite notice.
- `specs/behaviors/truncation.md` — caps, marks (`…` in rows, house marker in detail), URL/path/id
  protection, `--full`, pointer `exists|missing`.
- `specs/behaviors/authority.md` — `authority:` on `show`; `--fields authority` on rows.

## Approach

1. `src/lib/ids.ts`: `parseId` (strict regex, null otherwise), `formatId`, `resolveSession`
   (filename prefix scan over scope incl. `*/subagents/agent-*.jsonl`; `AMBIGUOUS_SESSION` with
   candidates + titles; `latest` by mtime), `resolveId`.
2. `src/lib/events.ts`: `show` → by seq via a forward scan to the line (offset cache arrives in
   `pan`), classify with a context rebuilt from the preceding entries so result/call links hold.
3. `src/output/truncate.ts`: `head(text, n)` with URL/path/id protection; `detail(text, cap)`
   with the house marker; size formatting.
4. `commands/show.ts`: block-form detail per kind; `blocks[N]` for bare multi-event entry ids;
   `--raw` for any seq incl. silent/malformed; `--full` reads the pointer file; `zoom` registered
   as the same handler with alias `--help`.
5. Rewrite detection in `src/lib/cache/store.ts` (the store itself is created here with only the
   identity record; indexes come later): first-line hash, length; `notice:` once on change.
6. Retrofit `events`/`tail` rows to use `truncate.head` and to print the truncation footer, and
   switch their `<session>` argument from path-only (`commands/common.ts#sessionFromArg`) to
   `resolveSession` (deferred from [`reader-and-event-model`](reader-and-event-model.md)).

## Validation

- [ ] `parseId` accepts `7a2f1c3e:418` and `7a2f1c3e:418.2`, rejects `7a2f1c:418`, `418`,
      `7a2f1c3e:0`, `7a2f1c3e:418.0`; a bare `418` is accepted only with `--session`.
- [ ] Fixture with two sessions sharing a 7-char prefix: an 8-char prefix resolves uniquely; a
      fixture with two sessions sharing 8 chars → `AMBIGUOUS_SESSION` with both candidates in
      `details`.
- [ ] `latest` resolves to the fixture with the newest mtime; a subagent fixture resolves by its
      agentId prefix and prints `kind: subagent`, `parent:`.
- [ ] `show` of a `call` prints `input`, `result`, `result_status`, `result_text`, `authority: C`;
      of a `result` prints `call`; of a `compaction` prints `trigger`, `pre_tokens`, `post_tokens`,
      `summary`, `preserved: <n> events`.
- [ ] `show <id-of-multi-block-entry>` prints `blocks[4]` with `.1`..`.4`; `show <id>.3` prints
      only the third.
- [ ] `show <pointer-result>` prints `pointer: … (exists)` and the preview; `--full` prints the
      file contents; with the file deleted prints `(missing)` and exit 0.
- [ ] `show <silent-seq>` prints `kind: silent` + raw and hints nearest event ids; `show
      <beyond-eof>` → `NOT_FOUND` with the line count.
- [ ] Id stability test: list a fixture's ids, append 500 lines (including a new compaction and
      a rewritten `sessions-index.json`), re-resolve every id → identical entries; truncate the
      fixture by one line → next read prints the rewrite `notice:` exactly once.
- [ ] Truncation tests: a 300-char row head ends with `…` and the footer counts it; a URL spanning
      the cut is kept whole; a `call` target path is never cut; `show` text over 4,000 chars ends
      with ` … (truncated, N chars total)` and the `--full` hint appears; under the cap, no hint.
- [ ] `--fields authority` adds `H|C|D` per `authority.md`.
- [ ] `zoom` output is byte-identical to `show` for the same arguments.
- [ ] `tail latest`, `tail <8-hex prefix>` and `events <uuid>` resolve through `resolveSession`
      (from `reader-and-event-model`).

## Risks / unknowns

- **Reclassifying from a cold seek** — `show` needs preceding context (pending tool ids). Approach
  scans from file start until the offset cache exists; acceptable at this stage, measured in `pan`.
- **Prefix namespace sharing** — main uuids and agentIds are both hex; collisions are improbable
  at 8 chars but are reported, never resolved by preference.

## Notes

(at closeout)

## Follow-ups

(at closeout)
