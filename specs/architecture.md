# Architecture

## Stack

- **TypeScript** on **bun** for development (`bun run`, `bun install`, `vitest`); the published
  artifact runs on plain **Node ≥ 22** with no bun dependency.
- **axi-sdk-js** (`runAxiCli`, `AxiError`, the session-hook helpers, `axi-sdk-js/fast-path`) and
  **@toon-format/toon** at the output boundary. Internal logic is plain objects; TOON is produced
  once, in `src/output/`.
- No other runtime dependencies. Log parsing, id resolution, time grammar and the term index are
  hand-written on Node builtins (`fs`, `readline`, `path`, `os`, `crypto`).
- Tests: `vitest`, driven by synthetic fixture logs under `test/fixtures/` (never captured real
  sessions; see `## Fixtures`).

## Project structure

```
bin/agent-recall-axi.ts         fast path (--version) then dynamic import of src/cli
src/
  version.ts                     leaf: reads package.json; imports node builtins only
  cli.ts                         runAxiCli wiring, formatError, main(argv)
  reference.ts                   DESCRIPTION + COMMAND_GROUPS: the one description of the surface
  flags.ts                       FlagSpec + parseFlags (fail-loud unknown flags, --tz global)
  commands/                      one file per verb; thin: parse flags → call lib → render
    home.ts sessions.ts turns.ts events.ts human.ts tools.ts find.ts pan.ts (around/next/prev/tail)
    show.ts compactions.ts recall.ts resume-pack.ts hook.ts cache.ts
  output/
    render.ts                    header/rows/footer composition, block-form help[], sizes, times
    schema.ts                    FieldDef helpers; default schemas per command
    truncate.ts                  head cuts that respect URLs/paths/ids; house markers
    resume.ts                    renderResumePack: the resume-pack TOON
    resume-layout.ts             the pack's layout as byte costs (no TOON): the library's budget charges these
  render/
    index.ts                     the agent-recall-axi/render subpath (re-exports renderResumePack)
  lib/                           the library (specs/api.md); no CLI concerns
    index.ts                     public exports
    model.ts                     Session, Entry, Event, Turn, Window, Pointer, ResumePack types
    ids.ts                       parse/format/resolve ids and session refs
    scope.ts                     log root, project dirs, cwd → project, --project/--all
    time.ts                      <when>/<span> grammar, half-open ranges, tz rendering
    reader.ts                    streaming line reader with seq; tail reader; head-hash
    adapters/
      adapter.ts                 Adapter interface
      claude-code/
        detect.ts                is this file/dir a Claude Code log?
        classify.ts              entry → events (kinds, authority, targets, files, pointers)
        sessions.ts              project dirs, sidecar, subagents, sessions-index.json, titles
    session.ts                   open/list sessions; lazy stats
    events.ts                    range/around/next/prev/tail over visible kinds
    turns.ts                     turn segmentation
    windows.ts                   compaction windows
    find.ts                      filters, why-labels, context assembly, cross-session scan
    recall.ts                    grouped cross-project search over index or scan
    resume.ts                    buildResumePack with budget policy
    cache/
      store.ts                   cache dir, file identity, invalidation (rewritten detection)
      index.ts                   per-session stats + term index for recall
  hook.ts                        SessionStart payload detection (hook mode for home)
scripts/
  build-cli.ts                   esbuild → skills/agent-recall-axi/scripts/agent-recall-axi.mjs (+ --check)
  build-skill.ts                 splice COMMAND_GROUPS into SKILL.md generated region (+ --check)
skills/agent-recall-axi/
  SKILL.md                       hand-written prose + generated command reference
  scripts/agent-recall-axi      bash shim (executable)
  scripts/agent-recall-axi.mjs  committed self-contained bundle (linguist-generated)
test/
  fixtures/                      synthetic jsonl sessions (see below)
  ...                            mirrors src/
specs/ plans/                    this methodology
```

## Library + CLI

The library (`src/lib`) is the product another program calls (`specs/api.md`); the CLI is one
consumer. Rules: no `process.stdout` writes, no `process.exit`, no flag parsing, no TOON inside
`src/lib`; every function takes structured arguments and returns structured results or throws a
typed error the CLI maps to `behaviors/errors.md`. The package exports the library as
`agent-recall-axi` (`exports["."]`), the resume-pack renderer as `agent-recall-axi/render`
(`exports["./render"]`, `api.md#resume-pack`), and the CLI only as the `bin`. The `render`
subpath is the one public entry into `src/output/`: it re-exports `renderResumePack`, which
the `resume-pack` command calls too, so the CLI and a library caller cannot print different
bytes for the same pack.

## Event model and adapters

An **adapter** turns one log format into the model in `specs/data-model.md`:

```ts
interface Adapter {
  id: "claude-code";                              // adapter name, shown in `sessions --fields adapter`
  detect(path: string): Promise<boolean>;         // cheap: looks at the path shape and first line
  root(): string;                                 // default log root (~/.claude/projects)
  listProjects(root: string): AsyncIterable<Project>;
  listSessions(project: Project, opts: { subagents?: boolean }): AsyncIterable<Session>;
  entries(session: Session, range?: SeqRange): AsyncIterable<Entry>;   // streaming, seq-stamped
  classify(entry: Entry, ctx: ClassifyContext): Event[];               // pure; ctx carries pending tool_use ids
  title(session: Session): Promise<string | undefined>;
}
```

Everything above the adapter (ids, turns, windows, find, resume, rendering) is adapter-agnostic.
Adapter-specific facts that commands need (`compactMetadata`, hook names, `toolUseResult` paths)
are surfaced through `Event.meta`, never by downstream code reading `raw`. A second adapter is a
new directory under `src/lib/adapters/` plus a line in the adapter registry.

The **Claude Code adapter** reads `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, the session
sidecar `<uuid>/` (`tool-results/`, `subagents/agent-<id>.jsonl`, `custom-title.json`) and the
optional `sessions-index.json`. Its classification table is `data-model.md#kinds`. It tolerates
unknown entry types and malformed lines (counted, never fatal), string or array `message.content`,
and both the current structured compaction record and the older summary-only form. It treats the
file as append-only and never seeks by timestamp.

`CLAUDE_CONFIG_DIR`, when set, replaces `~/.claude` as the log root (Claude Code honors the same
variable).

## Ids

`data-model.md#identifiers`. Implementation notes: `seq` comes from the streaming reader's line
counter, so it is correct even for malformed lines; the resolver maps `<s8>` to a file by scanning
the scope's filenames (and `*/subagents/agent-*.jsonl`) with a prefix match, consulting the cache's
filename list first; `.n` indexes `message.content` as stored.

## Streaming and memory

Files reach tens of megabytes; the current live one may be being appended to. Every read is a
stream with a bounded window:

- `tail`/`events` (newest-last default), when no line-offset table exists, read the file
  backwards in 1 MB blocks until enough visible events are collected, then re-read that span
  forwards for classification context; with a table they read forwards from the checkpoint before
  the window instead (`cli.md#tail-session`).
- Every forward reader that yields rows (`events`, the pan verbs, `tail` with a table) holds a row
  back under one shared rule until its partner is read: a call until its result, a compaction
  until its summary. At most 1,000 visible events wait behind a held row (past an id bound, at
  most 1,000 lines are read); then it is released as it stands (`pending`). One rule, so the
  same row prints the same way whichever command reached it.
- `around`/`next`/`prev` seek by seq using the cache's line-offset table when present (built
  lazily, invalidated by size/hash), else a forward scan.
- `find`/`search` stream forwards one line at a time; memory is bounded by the context window.
- `human` and `resume-pack` read one window (from the last boundary) which the cache locates.
- No command holds a whole file in memory; a test asserts peak RSS stays under 150 MB on a 200 MB
  fixture.

## Cache

Optional, derived, disposable (`behaviors/privacy.md`). Location `$XDG_CACHE_HOME/agent-recall-axi/`; a cache left at the former `agent-session-axi/` location is never read (it is rebuilt on demand) and `cache clear` deletes it too
(default `~/.cache/agent-recall-axi/`), owner-only. Per file, keyed by its absolute path, it stores:
an identity record for rewrite detection (byte length, the first line's hash once that line is
complete, and the last complete line's byte offset, length and hash), a line-offset
table (every 256th line), session stats (`turns`, `calls`, `compactions`, `humans`, `last`,
`title`), compaction boundary seqs, and, once `search` (library `recall`) has run, a term index (lower-cased word
tokens → seqs) for `H`, `C` and `call` text. Entries refresh incrementally: an appended file re-indexes
only lines after `last-indexed seq`. The cache is never required for correctness; every command
works with it absent and reports `index: none`.

The **line-offset table** is its own record and carries its own identity: the last-indexed seq,
the byte offset just past that line, the first line's hash and the last indexed line's offset,
length and hash. A table whose identity no longer matches the file (shorter, head or last indexed
line changed) is discarded, whatever the identity record says, so a stale table is never used.
Only complete lines are indexed; a trailing line still being written is left for the next
extension. Each checkpoint (lines 1, 257, 513, …) records the line's byte offset and the
classification state at that line, so a read started there classifies exactly as a scan from the
file start would: the calls still waiting for a result (id, tool, files), the compaction waiting
for its summary, the turn and window in effect, the last event before it, and the cumulative count
of events per kind. The tool name of every tool-use id seen (which decides, for instance, whether a
late duplicate result is a `human.answer`) is the rest of that state; it is stored once per table
as a list stamped with the seq that introduced each entry, and a checkpoint's share is the entries
before its seq. Together these are the whole classification context: nothing else a line's
classification reads is carried from earlier lines. The table's tail record holds the same state
after the last indexed line, which is where an append resumes, so a table extended across appends
equals one built cold. The per-kind counts give listings an exact `<matching>`, and the cumulative
counts let a seek pick its start checkpoint without scanning. The table also lists the window
boundaries (`behaviors/context-windows.md`) in file order: for each, the compaction's id (none
for a boundary-less summary), its summary's id once read, the position where the next window
starts, and the cumulative per-kind counts there, so `--window` resolves to a position range and
an exact count without a scan, and `compactions` reads only the boundary entries.

**Session stats** (`data-model.md#session`) ride on the table: its tail record also carries the
first and newest entry timestamps, the last model name, and the positions (seq, byte offset,
length) of the lines the title can come from (the last `custom-title` and `ai-title` entries, the
first `human` event), so the counts come from the tail's per-kind counts and boundaries and the
title is read back from its line. A small stats record (`stats/`) mirrors them with the table's
identity, so a listing reads a few hundred bytes per session instead of the table; it is used only
while that identity matches the file (a trailing line still being written aside), and otherwise
the table is extended (or built) and the mirror rewritten.

The **term index** (`terms/`) is built by `search` (library `recall`), in the same pass as the table, and carries its
own identity (its last indexed seq, the byte offset past it, the first line's hash and the last
indexed line's offset, length and hash): lower-cased word tokens (runs of letters, digits and
`_`) of exactly the text `find` tests on an `H` or `C` event (its `text` and, for a `call`, its
input stringified and each string value), each mapped to the seqs of the entries that hold it,
stored sorted by token so the record keeps no trace of the order words were written in. Nothing
else is stored: no phrase, no position inside a line. A substring of a text has each of its word runs inside a word
run of that text, so a line none of whose tokens contains some word run of the phrase cannot
match it: the index only ever skips lines that cannot hold a hit, and the lines it cannot rule out
are verified by classifying them from their checkpoint. An appended file is indexed from the
index's own last seq, reading from the table checkpoint at or before it, whether or not another
command has extended the table since; only an index whose identity no longer matches the file (a
rewrite) is rebuilt. `search` never rewrites a record it did not change.

The table records the format version of the table and the package version that built it; a
mismatch on either discards it, so a classifier change never serves counts or kinds computed by
the old one. Records are written via a temp file and rename (the temp file is removed when the
rename fails), never through a symlinked `files/` or `index/` directory; a reader treats a
missing, partial or unparseable record, or one not owned by the current user or writable by
group or others, as absent.

## Time

`behaviors/time-and-scope.md`. Parsing and rendering go through `src/lib/time.ts` with an explicit
zone argument; nothing calls `Date` formatting elsewhere. Relative times appear only in the
`sessions` listing and the home view.

## Output

`src/output/` is the only module that imports `@toon-format/toon`. `render.ts` composes
header → rows or blocks → `help[]` (block form, hand-rendered because `encode` inlines primitive
arrays). `truncate.ts` owns the marks and the URL/path/id protection. The home header (`bin`,
`description`) is the SDK's.

## `update` shadow

`commands/update.ts` is registered under the SDK's reserved name so the built-in self-updater (a
registry call) never runs. It is print-only (`cli.md#update`); the install channel is inferred from
the resolved entrypoint path.

## Error handling

`AxiError` with the codes in `behaviors/errors.md`; `formatError` maps usage codes to exit 2 and
wraps anything else as `INTERNAL_ERROR` (stack to stderr only with `--debug`). Validation happens
before any file is opened.

## Build and distribution

Two channels from one source, both committed to the same tag:

1. **npm package** `agent-recall-axi`: `tsc` → `dist/`, `bin` → `dist/bin/agent-recall-axi.js`,
   `files: [dist, skills/agent-recall-axi, LICENSE, README.md]`, `engines.node >= 22`. Install
   with `npm i -g agent-recall-axi` or run with `npx -y agent-recall-axi`. Publishing follows the
   house develop→main Release-PR flow (`release-prepare`/`release-validate`/`release-publish`
   workflows) with trusted publishing after a manual first publish (`RELEASING.md`).
   `package.json` stays `0.0.0` in git; `publish-npm.yml`, on the GitHub release that
   `release-publish` creates, sets it from the tag, runs the full CI gate, checks that the
   committed bundle at the tag reports the tag's version, and runs
   `npm publish --provenance --access public` on Node 24 with `id-token: write` and no token
   (an `-rc.N` under the `next` dist-tag). A version already on the registry is skipped with a
   warning, which is how the manually published first version's release run stays green.
2. **Skill** `skills/agent-recall-axi/`: `SKILL.md` (prose + generated command reference) and a
   **committed, self-contained bundle** `scripts/agent-recall-axi.mjs` built by esbuild with every
   dependency inlined, plus an executable bash shim, so `npx skills add JarvusInnovations/agent-recall-axi`
   delivers a working tool offline, with no registry access and no install step. The bundle is
   marked `linguist-generated`, its embedded version is normalized out before the `--check` drift
   comparison, and CI fails when it or `SKILL.md` is stale. The skill's examples invoke the shim
   by resolved path (never a bare name, since the bundle is not on `PATH`).

### The skill bundle

- `scripts/build-cli.ts` (`bun run build:bundle`; `--check` is `bun run check:bundle`) runs
  esbuild on `bin/agent-recall-axi.ts` (so the bundle keeps the version fast path) with
  `bundle`, `platform: node`, `target: node22`, `format: esm`, `legalComments: none`, a shebang
  banner and a "generated, do not edit" line, and writes the bundle mode 755. esbuild's
  `// <module path>` comments are stripped, so the bytes do not depend on the dependency
  layout under `node_modules`. esbuild is pinned to
  an exact version so the bytes are reproducible.
- The version is stamped at build time: `--stamp <version>` when given (a release version,
  `X.Y.Z` or `X.Y.Z-rc.N`, no `v`; anything else exits 2), else
  `git describe --tags --match 'v[0-9]*'` without its leading `v`, else
  `<package.json version>-g<short sha>`. `src/version.ts` returns the stamp
  when it is defined and reads `package.json` otherwise (the npm channel). `--check` replaces the
  one stamped literal on both sides with a placeholder before comparing, so a commit that only
  moves the sha passes and any other byte change fails.
- **Release stamp.** `release-publish` tags `main`'s merge commit, which `develop` never
  reaches, so `git describe` on `develop` cannot name a release. The release version is
  therefore stamped explicitly: before the Release PR merges, a commit on `develop` rebuilds the
  bundle with `--stamp <version>`, so the tree at the tag (and `main`, the default branch, which
  `npx skills add` installs from) reports the release version. `release-validate.yml` fails a `Release: vX.Y.Z`
  PR whose committed bundle does not print `X.Y.Z`, and `publish-npm.yml` repeats the check at the
  tag before publishing. Between releases a rebuilt bundle reports `<package.json version>-g<sha>`
  (a development build). The order is in `RELEASING.md`.
- The bundle reads nothing at run time but the logs and its cache: no `package.json`, no
  `node_modules`, no file beside it except, for hints, the existence of the shim.
- The shim `scripts/agent-recall-axi` is bash: it resolves its own symlinks (so a link to it on
  `PATH` works, with `CDPATH` ignored), checks that `node` is on `PATH` and is 22 or newer
  (otherwise a one-line message on stderr and exit 127 or 1), and `exec`s `node` on the sibling
  `.mjs` with the arguments.
- `scripts/build-skill.ts` (`bun run build:skill`; `--check` is `bun run check:skill`) splices
  the command reference generated from `COMMAND_GROUPS` (each group a heading, each command its
  usage and summary, prefixed `scripts/agent-recall-axi`) between
  `<!-- BEGIN GENERATED: command-reference -->` and `<!-- END GENERATED: command-reference -->`;
  the prose outside the markers is hand-written and never touched, and missing markers fail the
  build.
- `SKILL.md` frontmatter carries `name` and a trigger-shaped `description`; the body states the
  privacy rule near the top, that every command is run as `scripts/agent-recall-axi` relative to
  the skill's own directory (never on `PATH`), the zoom ladder, the exploration loop, and both
  install paths. The skill directory holds only `SKILL.md` and `scripts/`.

Both channels are required, not optional: bots install this tool with `npx skills add` on hosts
that may not reach the npm registry at cold start, and a memory tool has to work exactly then. The
npm channel serves interactive installs and `npx -y`; the committed bundle serves the bots. The
other house tools ship npm alone; this one deliberately ships both.

### Version fast path

`bin/agent-recall-axi.ts` calls `tryFastPath(argv, { version })` with `version` from the leaf
`src/version.ts` before dynamically importing `src/cli.ts`, so `--version` never loads the command
graph. A test measures the fast path against the `node -e` floor in the same process.

### Session hook

`hook install|status|uninstall` (`cli.md#hook`) installs for Claude Code, Codex and OpenCode at
user or project scope. It uses the SDK for the OpenCode plugin source (generated by the SDK's
installer into a throwaway home, then copied with its command line set) and for PATH-portable
command resolution. The settings merges are this tool's own: the SDK's
`installSessionStartHooks` / `sessionStartHookStatus` / `uninstallSessionStartHooks` match entries
by a substring of the marker, write commands unquoted and files non-atomically, append a second
`[features]` table to some Codex configs, and ignore `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
`XDG_CONFIG_HOME`, each of which `cli.md#hook` rules out. The hook command is the resolved binary
(or the skill shim when installed from the skill). In hook mode the home view reads the payload on
stdin and prints a resume pack after a compaction (`cli.md#home-view-no-arguments`). Nothing
installs a hook except `hook install`.

## Fixtures

Tests never use real session logs. `test/fixtures/` holds small synthetic `.jsonl` files written by
a fixture builder (`test/fixtures/build.ts`) that emits the exact shapes the adapter must handle:
string and array content; parallel tool calls with out-of-order results; a `tool_result` with a
`<persisted-output>` pointer and its sidecar file; a structured `compact_boundary` with its
`isCompactSummary` summary; the older summary-only compaction; a `queued_command` attachment; a
slash command; `hook_success` and `stop_hook_summary`; an `isMeta` skill body; a `<system-reminder>`
block; `thinking` blocks; a subagent file under `subagents/`; every silent entry type; a malformed
line; out-of-order timestamps; a `sessions-index.json`; and a second project directory. All text is
generic (`widget`, `example.test`); no names, hosts, or paths from any real session appear.

## Branches

`main` is the default branch and the release target: it holds exactly what was last released, so
`npx skills add JarvusInnovations/agent-recall-axi` installs a released, stamped bundle and never
an unreleased development build. Work merges to `develop`; only the `Release: v*` PR from
`develop` (or a `hotfix/*` branch) merges to `main`. Because `main` is the default, PR tools open
against it first, so two workflows keep the flow: `main-guard.yml`, a required check on PRs into
`main`, fails any head other than `develop` or `hotfix/*`; `main-retarget.yml`
(`pull_request_target`, API calls only, never checks out the PR's code) moves any other PR onto
`develop` on open and says so.

## CI

`.github/workflows/ci.yml`: `bun install --frozen-lockfile`, `bun run check` (tsc), `bun run build`,
`bun run test`, `bun run check:skill`, `bun run check:bundle`, then a smoke test of the built bin
with `--version`, `--help`, and `sessions --project /nonexistent` asserting exit 1,
`code: NO_SESSIONS`, and no stack trace. Node 22.x, `fetch-depth: 0`. A second job checks out the
repository fresh and, before anything is installed (`node` only: no `bun install`, no
`node_modules`), copies the committed skill directory out of the checkout and runs it through
its shim: `--version`, then `tail`, `find` and `resume-pack` against the committed fixtures, each
with a fresh cache. It then installs and builds, runs the same commands through `dist/`, and
fails unless the outputs match byte for byte.

A scrub gate (`scripts/scrub-check.sh`, `bun run check:scrub`, run in CI before install) scans
every tracked and untracked-but-not-ignored file except `node_modules/`, `dist/` and `.git/` and
fails on a marker of the real world: a home path with a user name other than the synthetic
`user` (`/home/<name>`, `/Users/<name>`; Homebrew's `linuxbrew` prefix is allowed only in the
committed bundle, where a dependency names it), an email address outside the documentation
domains (`example.com|net|org`, `*.example`, `*.test`, `*.invalid`, `*.localhost`), and a uuid
literal outside `test/fixtures/` unless it has the synthetic `xxxxxxxx-xxxx-4000-8000-xxxxxxxxxxxx`
shape. `test/scrub.test.ts` plants each marker in a throwaway repository and asserts the failure.

## Principles

**Inherited:**
- [Library first, CLI on top](principles.md#library-first-cli-on-top)
- [An event model with adapters, Claude Code first](principles.md#an-event-model-with-adapters-claude-code-first)
- [Reads only, never sends](principles.md#reads-only-never-sends)
- [Deterministic output for the same file](principles.md#deterministic-output-for-the-same-file)
