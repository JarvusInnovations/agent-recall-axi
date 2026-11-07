---
status: planned
depends: []
specs:
  - specs/architecture.md
  - specs/data-model.md
  - specs/behaviors/row-format.md
  - specs/behaviors/errors.md
  - specs/behaviors/time-and-scope.md
  - specs/behaviors/privacy.md
issues: [1]
---

# Plan: Reader and event model

## Scope

The foundation everything else stands on: the synthetic fixture builder, the streaming
seq-stamped reader, the Claude Code adapter that turns entries into events of every kind in
`data-model.md#kinds`, project/session scope resolution, and the CLI harness (`runAxiCli`,
flags, reference, output, errors) with three commands that prove the row format end to end:
`sessions` (minimal schema, no stats yet), `events`, and `tail`. Also CI.

Out of scope: id *resolution* beyond formatting (`ids-and-show`), truncation beyond a plain head
cut (`ids-and-show`), turn segmentation and windows (`views`), the cache (`pan`), titles and
session stats (`sessions-and-recall`), the skill bundle (`skill-and-hook`).

## Implements

- `specs/architecture.md` — project structure, library/CLI split, adapter interface, streaming
  reader, CI shape, fixture policy.
- `specs/data-model.md` — Project, Session, Entry, Event with every kind and authority, derived
  target, files touched, Pointer parsing (following the pointer lands in `ids-and-show`).
- `specs/behaviors/row-format.md` — `{id,t,kind,text}` rows, `text` by kind, headers/footers, day
  vs multi-day time rendering.
- `specs/behaviors/errors.md` — codes, exit mapping, fail-loud flags, malformed lines counted.
- `specs/behaviors/time-and-scope.md` — `<when>`/`<span>` grammar, `--tz`, project scope,
  `--project`/`--all`.
- `specs/behaviors/privacy.md` — read-only opens; no writes under the log root.

## Approach

1. **Fixture builder** (`test/fixtures/build.ts`): a small DSL that emits jsonl lines of each
   shape with a stable, generic vocabulary, plus a sidecar dir (`tool-results/`, `subagents/`,
   `custom-title.json`) and `sessions-index.json`. Commit the generated fixtures and a test that
   regenerating them yields identical bytes.
2. **Reader** (`src/lib/reader.ts`): forward line stream with `seq`, tolerant of a trailing
   partial line (live file); backward block reader for newest-last listings; head-hash helper.
3. **Adapter** (`src/lib/adapters/claude-code/`): `detect`, `listProjects` (`~/.claude/projects`
   or `CLAUDE_CONFIG_DIR`), `listSessions` (main + `subagents/`), `entries`, `classify`.
   `classify` is a pure function with a context of pending `tool_use` ids → call event ids so
   results link to calls (parallel, out-of-order). Covers: string vs array content; `human` /
   `human.queued` (attachment `queued_command` with human origin) / `human.slash` / `human.answer`;
   `assistant` (merged text blocks) / `thinking` / `call`; `result` with `is_error`, non-text
   block tokens, `<persisted-output>` pointer parse (with and without wrapper); `compaction` from
   `system/compact_boundary` + `summary` from `isCompactSummary`, and the summary-only fallback;
   `hook` from `hook_success` / `hook_additional_context` / `stop_hook_summary`; `skill` from
   `isMeta` "Base directory for this skill:"; `notice` / `notice.task`; silent entry list;
   unknown types silent; malformed lines counted.
4. **Scope** (`src/lib/scope.ts`): cwd → project dir by `cwd` field, ancestor fallback,
   `--project` (path | encoded | unique substring), `--all`.
5. **Time** (`src/lib/time.ts`): grammar from `time-and-scope.md`, half-open ranges, tz rendering.
6. **CLI harness**: `bin/agent-session-axi.ts` (fast path + dynamic import), `src/version.ts`,
   `src/cli.ts` (`runAxiCli`, `formatError`), `src/flags.ts` (FlagSpec, unknown-flag error with
   valid set), `src/reference.ts` (DESCRIPTION + COMMAND_GROUPS for all planned commands, marked
   `planned` until they exist so `--help` is honest), `src/output/` (render, schema, sizes, times,
   block-form `help[]`).
7. **Commands**: `sessions` (id, started, last, title=`(pending)` placeholder → replaced in
   `sessions-and-recall`; make the placeholder explicit, not a lie), `events`, `tail`. Home view
   prints a minimal listing (no `last_human` yet).
8. **`update` shadow**: register `update` (print-only, channel inferred from the entrypoint path)
   so the SDK built-in never runs; no network anywhere (`privacy.md`).
9. **CI** (`.github/workflows/ci.yml`): check, build, test, smoke test (`sessions --project
   /nonexistent` → exit 1, `code: NO_SESSIONS`, no stack trace).

## Validation

- [ ] `bun run check`, `bun run build`, `bun run test` pass on a clean checkout; CI green.
- [ ] `node dist/bin/agent-session-axi.js --version` prints the bare version; a test shows it does
      not load `src/cli` (module registry check) and runs within 3× the `node -e` floor.
- [ ] Fixture suite exists with one file per shape listed in `architecture.md#fixtures`; a test
      regenerates them and diffs clean; `grep -ri` for a denylist of real-world markers (home paths
      with usernames, `@` emails) finds nothing under `test/fixtures`.
- [ ] `classify` tests assert, per fixture: every kind in `data-model.md#kinds` is produced at
      least once with the right authority; a `tool_result` arriving three entries after its call,
      interleaved with another call's result, links to the right call in both directions.
- [ ] Pointer fixture: `event.pointer` has `path`, `bytes: 42.8k`-equivalent number, `exists: true`;
      a second fixture with the file removed yields `exists: false` and no error.
- [ ] Compaction fixture: `compaction` event with `meta.trigger`, `pre_tokens`, `post_tokens`,
      followed by a `summary` event; the summary-only legacy fixture still yields `summary`.
- [ ] Queued-command fixture: `human.queued` text equals `attachment.prompt` exactly (no
      `<system-reminder>` wrapper); slash fixture yields `/name args`.
- [ ] Silent/unknown/malformed fixture: zero events, `malformed: 1` in the session header,
      exit 0.
- [ ] `events <fixture>` prints `events[N]{id,t,kind,text}` with full `<s8>:<seq>` ids, `day:` header
      for a one-day fixture and `MM-DD HH:MM:SS` times for a two-day fixture; `thinking` and
      `result` rows absent by default and present with `--kind all`.
- [ ] `tail <fixture>` prints the last 20 visible rows by default; `tail <fixture> 5` and
      `--limit 5` agree.
- [ ] `events <fixture> --bogus` → exit 2, `code: UNKNOWN_FLAG`, valid flags listed inline;
      `events` with a leading flag → the SDK's "Flags must come after the command".
- [ ] `update` and `update --check` print the version and the two update commands, exit 0, and a
      test with network disabled (`--network none` sandbox or a blocked resolver) passes; `--help`
      shows no SDK `built-in` block.
- [ ] `sessions --project /nonexistent` → exit 1, `code: NO_SESSIONS`, hint names `--project`/`--all`.
- [ ] A test opens every fixture through the adapter and asserts no file under the fixture root
      changed (mtime + hash) — read-only guarantee.
- [ ] `--tz Asia/Tokyo` changes rendered times and the `tz:` header; `TZ` env is honored when
      the flag is absent.
- [ ] A 200 MB generated fixture: `tail` completes under 2 s with peak RSS under 150 MB.

## Risks / unknowns

- **Log format drift** — Claude Code adds entry types and fields often. Mitigation: unknown types
  are silent, unknown fields ignored, fixtures encode the shapes observed in Nov 2026 and the
  adapter's classification table is the one place to extend.
- **Append-only assumption** — ids depend on it. Mitigation: head-hash recorded now, rewrite
  detection lands in `ids-and-show`.
- **`queued_command` origin variants** — non-human origins (`task-notification`, `peer`) exist;
  anything not `human` becomes `notice.task`/`notice`, never `human.queued`.
- **Project `cwd` decoding** — the encoded dir name is lossy; prefer the `cwd` field; a project
  dir with no entries carrying `cwd` is listed by its encoded name.

## Notes

(at closeout)

## Follow-ups

(at closeout)
