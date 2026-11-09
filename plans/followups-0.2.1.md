---
status: done
depends: [agent-recall-axi]
specs:
  - specs/cli.md
pr: 34
---

# Plan: v0.2.0 review follow-ups

## Scope

Four follow-ups from the catalog admission review of v0.2.0. **In:**
- **Flaky test.** The hook-mode test compared a cold baseline listing against later, stats-backed listings
  from a shared cache. It failed CI on `main` and in the publish gate at the v0.2.0 tag.
- **The `recall` hint.** It showed a placeholder instead of the user's own phrase and flags.
- **`hook status` headline.** It didn't say `; see errors` when a target errored, unlike install and
  uninstall.
- **README.** No note told agent-session-axi users to remove the old hook before switching.

## Implements

- `specs/cli.md` § search: the `recall` hint carries the phrase and flags. § hook: `status` adds
  `; see errors`.

## Validation

- [x] The hook-mode test warms the cache before its baseline and asserts the baseline has no `?` turns;
      it passes 3/3 in isolation and in the full unit run.
- [x] Unit: `recall 'flange gasket' --since 1y` suggests ``search 'flange gasket' --since 1y``.
- [x] Unit: `hook status` with an unparseable target headlines `(project scope; see errors)` with exit 1.
- [x] Unit project: 388 tests pass. check:skill, check:bundle and check:scrub pass.
