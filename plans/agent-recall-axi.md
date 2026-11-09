---
status: in-progress
depends: [sessions-four-columns]
specs:
  - specs/cli.md
  - specs/architecture.md
  - specs/api.md
  - specs/principles.md
  - specs/data-model.md
  - specs/behaviors/privacy.md
  - specs/behaviors/truncation.md
  - specs/behaviors/time-and-scope.md
  - specs/behaviors/row-format.md
  - specs/behaviors/errors.md
---

# Plan: Rename to `agent-recall-axi`, `search` verb, four-column defaults

## Scope

The tool's job is agent memory across a large, disorganized set of sessions. The name should say so
before the catalog entry (kunchenguid/axi#266) merges and the name spreads into installed hooks.
**In:**
- **Rename.** `agent-session-axi` becomes `agent-recall-axi` for the package, bin, skill, hook marker,
  env var, cache dir and repository. It is not `recall-axi`, because catalog names read as `<service>-axi`
  and that would suggest a wrapper for the Recall.ai API.
- **Verb.** The CLI verb `recall` becomes `search`, the verb agents guess first, which also avoids
  `agent-recall-axi recall`. A typed `recall` gets a targeted hint.
- **Migration.** Hooks installed under the former name are recognized and repaired in place, and the
  former OpenCode plugin is removed.
- **Columns.** Every default table is four columns or fewer, except `find` and `search`, where the
  catalog entry records a justified principle 2 exception:
  - `turns` drops `events` and `calls` (`--full`).
  - `tools` drops `t` (`--fields t`).
  - The `resume-pack` tools layer drops `t`.
  - `compactions` drops `trigger`, `pre` and `post` (`--full`).
  - `cache status` drops `lines`, `checkpoints` and `size` (new `--full`).

**Out:**
- The library API keeps the function name `recall`, which now matches the package name.
- `find` and `search` keep five columns. `t` dates cross-session hits, and `hits` ranks which session
  to open first.

## Implements

- `specs/cli.md`: the rename throughout; `search` and the `recall` hint; trimmed schemas; hook
  migration.
- `specs/architecture.md`: the cache location, and the former cache cleared by `cache clear`.
- `specs/api.md` and the behaviors: the rename, and `search` where they mean the CLI verb.

## Approach

Rename mechanically across src, test, scripts, the skill and workflows; plans/ stays as historical
record. `FORMER_NAME` joins the ownership sets in `hook-settings.ts`, so `withOurEntry` repairs a former
entry in place and drops duplicates. Install removes `axi-agent-session-axi.js` when its marker
matches. The `recall` verb gets a registered handler that throws VALIDATION_ERROR with the hint.
Schemas are trimmed at their render sites, and the dropped columns move behind `--full`/`--fields`.

## Validation

- [ ] Unit: `search` matches what `recall` returned; `recall` fails VALIDATION_ERROR with the hint.
- [ ] Unit: install over a former-name entry (Claude, Codex, OpenCode) leaves exactly one current
      entry per agent and no former plugin; status shows former entries as `stale`; uninstall
      removes them; the former disable env var is honoured.
- [ ] Unit: the trimmed default schemas print, and each dropped column comes back through its flag.
- [ ] check, check:types, check:skill, check:bundle and check:scrub pass, and CI is green.
- [ ] The repo is renamed on GitHub, the package is published as `agent-recall-axi`, and
      `agent-session-axi` is deprecated on npm with a pointer to the new name.
