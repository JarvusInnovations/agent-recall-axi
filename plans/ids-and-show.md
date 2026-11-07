---
status: in-progress
depends: [reader-and-event-model]
specs:
  - specs/data-model.md
  - specs/cli.md
  - specs/behaviors/id-stability.md
  - specs/behaviors/truncation.md
  - specs/behaviors/authority.md
issues: [1]
pr: 5
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

- [x] `parseId` accepts `7a2f1c3e:418` and `7a2f1c3e:418.2`, rejects `7a2f1c:418`, `418`,
      `7a2f1c3e:0`, `7a2f1c3e:418.0`; a bare `418` is accepted only with `--session`.
- [x] Fixture with two sessions sharing a 7-char prefix: an 8-char prefix resolves uniquely; a
      fixture with two sessions sharing 8 chars → `AMBIGUOUS_SESSION` with both candidates in
      `details`.
- [x] `latest` resolves to the fixture with the newest mtime; a subagent fixture resolves by its
      agentId prefix and prints `kind: subagent`, `parent:`.
- [x] `show` of a `call` prints `input`, `result`, `result_status`, `result_text`, `authority: C`;
      of a `result` prints `call`; of a `compaction` prints `trigger`, `pre_tokens`, `post_tokens`,
      `summary`, `preserved: <n> events`.
- [x] `show <id-of-multi-block-entry>` prints `blocks[4]` with `.1`..`.4`; `show <id>.3` prints
      only the third.
- [x] `show <pointer-result>` prints `pointer: … (exists)` and the preview; `--full` prints the
      file contents; with the file deleted prints `(missing)` and exit 0.
- [x] `show <silent-seq>` prints `kind: silent` + raw and hints nearest event ids; `show
      <beyond-eof>` → `NOT_FOUND` with the line count.
- [x] Id stability test: list a fixture's ids, append 500 lines (including a new compaction and
      a rewritten `sessions-index.json`), re-resolve every id → identical entries; truncate the
      fixture by one line → next read prints the rewrite `notice:` exactly once.
- [x] Truncation tests: a 300-char row head ends with `…` and the footer counts it; a URL spanning
      the cut is kept whole; a `call` target path is never cut; `show` text over 4,000 chars ends
      with ` … (truncated, N chars total)` and the `--full` hint appears; under the cap, no hint.
- [x] `--fields authority` adds `H|C|D` per `authority.md`.
- [x] `zoom` output is byte-identical to `show` for the same arguments.
- [x] `tail latest`, `tail <8-hex prefix>` and `events <uuid>` resolve through `resolveSession`
      (from `reader-and-event-model`).

## Risks / unknowns

- **Reclassifying from a cold seek** — `show` needs preceding context (pending tool ids). Approach
  scans from file start until the offset cache exists; acceptable at this stage, measured in `pan`.
- **Prefix namespace sharing** — main uuids and agentIds are both hex; collisions are improbable
  at 8 chars but are reported, never resolved by preference.

## Notes

Spec readings this plan settled, written into `cli.md`, `data-model.md` and `api.md` in the two
leading `docs(specs):` commits:

- **`--project`/`--all` on every command that resolves a `<session>` or `<id>`.**
  `time-and-scope.md` already pointed `NO_SESSIONS` at them, but `cli.md` usage lines never
  listed them.
- **`show --session <ref>`** is what makes "a bare `418` only with `--session`" testable at the
  CLI. With both a full id and `--session`, the id's `<s8>` must be that session's.
- **`latest` is the newest main session.** A subagent file is often touched last, but it is
  reached by its agentId, never as `latest`.
- **`show --fields` is a projection** (keep only these fields). Every field already prints by
  default, so a detail view has nothing to add.
- **The `show` shape:** `event:` for one event; `entry:` + `t` + `blocks[N]` for a bare
  multi-event id; `uuid`/`parent_uuid` close every entry; absent fields are omitted. A silent
  entry prints `kind: silent`, `type` and `raw:` with nearest-event hints. A malformed line adds
  `malformed: true`; a trailing line still being written adds `partial: true`.

Decisions recorded only here:

- `turn` is the nearest preceding `human`/`human.slash`; a compaction belongs to the window it
  closes (window = compactions strictly before it); the summary after it opens the next window.
  `views` owns turn segmentation and may refine this, but it must agree with `show`.
- `preserved: <n> events` counts the events of the entries whose uuids the boundary lists, as
  seen before the boundary in the file.
- `show` caps `H` text at 4,000 chars like every kind, per the caps table, with the marker and
  `--full`. `authority.md`'s verbatim guarantee is read as "never rewritten", and a marked cut is
  not a rewrite. `human` and `resume-pack` keep their own budgets.
- `--raw` prints the parsed line as nested TOON, not literal JSON, so stdout stays TOON. Each
  string value over 4,000 chars is cut with the house marker unless `--full`.
- `--raw` with a block id prints the whole line (`entry:`); the block is not validated.
- A single-event entry's id is the entry form. `<id>.1` of it is `NOT_FOUND` naming the right id,
  never silently accepted.
- A call target is "a path" when it is in the event's `files` (path-valued input). Such a target
  is never cut. In a shell command, path-like tokens are kept whole and the rest is cut.
- The rewrite identity is length + first-line hash + the last read line's offset/length/hash.
  It stores an offset, not the seq that `architecture.md#cache` names: seq bookkeeping arrives
  with the offset table in `pan`. A notice prints once on `events`, `tail` and `show`; then the
  new identity is recorded.
- `AMBIGUOUS_SESSION` candidates carry `title: (pending)` until titles land.
- Listing hints name a session by `<s8>` plus the scope flag it resolved in. When the caller
  gave a path, they name it by path and point `show` hints at `--session <path>`. `sessions`
  and the home view now hint `tail <s8>`.
- Tests get a throwaway `XDG_CACHE_HOME` from the vitest global setup and the run helper. An
  early local run without it wrote fixture identities into the real cache, which was deleted.
- `show` scans from the file start (no offset cache yet), so its cost grows with the entry's
  position. It was not measured here. The plan put that measurement in `pan`, which now owns it
  as a Validation item.

## Follow-ups

- Deferred to [`pan`](pan.md): `show` seeks by seq through the offset table and rebuilds link
  context from the enclosing turn, instead of scanning from the file start; the identity record
  gains the last-indexed seq.
- Deferred to [`sessions-and-recall`](sessions-and-recall.md): `AMBIGUOUS_SESSION` candidates
  carry real titles instead of `(pending)`.
