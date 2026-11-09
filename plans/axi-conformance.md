---
status: in-progress
depends: [main-default]
specs:
  - specs/cli.md
  - specs/behaviors/errors.md
---

# Plan: Close the AXI conformance gaps found in catalog admission review

## Scope

An independent pinned-source review of v0.1.0, done ahead of the AXI catalog submission, found one
behavior the AXI principles rule out and a handful of smaller truthfulness and discoverability gaps.
Fix them so the catalog entry pins a release whose only exception is the lack of session-end capture,
which the agent harness already does by writing the transcripts this tool reads.
**In:** the home view's cross-project fallback; `turns` as an empty cell; the hook install and uninstall
headlines when a target errors; `hook uninstall`'s empty footer; the unknown-command hint; the
renamed-flag message. **Out:** session-end hooks, and `sessions`' fifth default column.

## Implements

- `specs/cli.md` § Home view: with no project for the cwd, print `project: none for <cwd>` and
  `sessions: none in this directory`, with widening hints, and read nothing from other projects. The
  SessionStart hook injects this view, and AXI §7 wants that context scoped to the directory. `turns` is
  `?` without stats.
- `specs/cli.md` § hook: an errored target makes the headline `partly installed`/`not installed`
  (or `partly removed`/`not removed`) with `; see errors`. The uninstall footer suggests `hook status` and
  `hook install`.
- `specs/behaviors/errors.md`: renamed flags are named as typed (`-n`, not `--n`), and the unknown-command
  hint names the tool.

## Approach

- `homeCommand` returns the scoped empty state on NO_SESSIONS instead of re-listing with
  `project: "all"`. The `--all` carry in its hints goes away with it.
- `install` and `uninstall` compute the headline from `failed` as well as `changed`/`removed`.
- `parseFlags` echoes `arg.split("=")[0]` in the renamed-flag error.
- `runAxiCli` gets a `renderUnknownCommand` that goes through `formatError`, so the output keeps the
  tool's error shape.
- The committed skill bundle is rebuilt (`bun run build:bundle`).

## Validation

- [ ] Unit: home in a cwd with no sessions prints `none in this directory`, no other project's ids,
      4 hints, and each runnable hint exits 0 from there; cold rows carry `turns: ?`.
- [ ] Unit: a hook install with an unparseable settings file headlines `partly installed (...; see
      errors)` and exits 1; uninstall's footer names `hook status` and `hook install` with the scope.
- [ ] Unit: `-n 3` fails as `unknown flag -n` with `use --limit` and no `--n`; an unknown command is a
      VALIDATION_ERROR whose hint names `agent-session-axi --help`.
- [ ] Unit: the bin in hook mode with a silent or partial stdin, from a cwd with no sessions, prints
      the scoped home view.
- [ ] check, check:types, check:skill, check:bundle and check:scrub pass, and CI is green, including the
      perf project.
