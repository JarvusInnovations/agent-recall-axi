---
status: done
done: 2026-11-08
depends: [first-release]
specs:
  - specs/architecture.md
pr: 28
---

# Plan: `main` as the default branch

## Scope

`npx skills add` installs the default branch. With `develop` as default, skill users got every
merge as it landed, reporting `0.0.0-g<sha>`. `main` becomes the default and holds only released
trees; `main-guard.yml` (required check: head is `develop` or `hotfix/*`) and `main-retarget.yml`
(moves stray PRs onto `develop`, API calls only) keep the develop→main flow, the same pair the
sibling skill repo runs. Docs and the architecture spec say so.

## Not in scope

The settings themselves (default branch, the required check in the `Protect main` ruleset): a
maintainer's step, scripted in the PR body.

## Validation

- [x] Both workflows are present, copied from the sibling repo with this repo's name, and
      actionlint-clean.
- [x] `specs/architecture.md` has a Branches section; `RELEASING.md` lists both workflows and says
      skill users receive only released bundles; README names `main` as the install source.
- [x] Scrub gate passes.

## Notes

- 2026-11-08: Chris: "do it for agent-session-axi"; the kit repo follows once its first bot settles.
