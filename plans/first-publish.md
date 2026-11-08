---
status: in-progress
depends: [skill-and-hook]
specs:
  - specs/architecture.md
issues: [1]
pr: 22
---

# Plan: First publish

## Scope

Ship v0.1.0 through both channels: the house develop→main Release-PR workflows
(`release-prepare`, `release-validate`, `release-publish`) plus `publish-npm.yml` with trusted
publishing after the one manual first publish; README install and usage docs for both paths;
the public-repo scrub gate.

## Implements

- `specs/architecture.md#build-and-distribution` — npm channel, release flow, `files`, `engines`.

## Approach

1. Add the release workflows per the `repo-setup` skill's npm reference (same shape as the
   newest sibling tools); `publish-npm.yml` on `release: published` sets the version from the tag
   and runs `npm publish --provenance --access public` on Node 24 with `id-token: write`.
2. Manual first publish from a maintainer machine (`npm publish --access public` at 0.1.0) so the
   package exists, then configure trusted publishing for the repository and workflow.
3. README: what it is, the privacy sentence, install (`npm i -g` / `npx -y` / `npx skills add`),
   the zoom ladder with five example commands, the hook, links to specs.
4. Scrub gate: a CI step that greps the tree (excluding `node_modules`) for a denylist of
   real-world markers (`/home/<user>/`, `/Users/<user>/`, `@…\.(com|us)` emails, uuid literals
   outside fixtures) and fails on hits.
5. Release notes via the `release-flow` skill; version bump to 0.1.0.
6. Stamp the release into the skill bundle (deferred from `skill-and-hook`):
   `scripts/build-cli.ts` stamps `git describe --tags --match 'v[0-9]*'` without the `v` (else
   `<package.json version>-g<sha>`), so the bundle committed on `main` only reports `0.1.0` if
   it is rebuilt (`bun run build:bundle`) after the tag exists. `check:bundle` ignores the
   stamped literal, so this is a release step, not a CI failure. Settle the order (tag, rebuild,
   commit, move the tag, or stamp from `package.json` once the release sets it) and write it
   into `RELEASING.md`. Fill in the README's skill-channel section, which `skill-and-hook` left
   at install and build basics.

## Validation

- [ ] Pushing `develop` opens a `Release: v0.1.0` PR with a bot changelog; merging it publishes a
      GitHub release and triggers `publish-npm.yml`, which succeeds with provenance.
- [ ] `npx -y agent-session-axi@0.1.0 --version` prints `0.1.0` on a clean machine; `npm i -g`
      installs a working `agent-session-axi` binary.
- [ ] `npx skills add JarvusInnovations/agent-session-axi` installs the skill whose bundled CLI
      runs offline (network disabled in the test) and reports the same version.
- [x] README renders both install paths and states "reads local files only; sends nothing".
- [x] Scrub gate passes on the tree and fails on a planted marker in a scratch branch.
- [ ] Issue #1 is closed with a comment pointing at the specs and the release.

## Risks / unknowns

- **First-publish bootstrap** — trusted publishing cannot create the package; the manual publish
  is a one-time step documented in `RELEASING.md`.
- **Version in two places** — package.json stays 0.0.0 in git until the release sets it; the
  bundle's stamped version comes from `git describe`. Both are explained in `RELEASING.md`.

## Notes

- **Prepared in PR #22, not yet published.** The workflows, the `--stamp` flag, the scrub gate,
  README and `RELEASING.md` are in place; the manual first publish, the trusted-publisher setup and
  the Release PR merge are maintainer steps (runbook below). The plan stays `in-progress` until
  they are done and the remaining Validation boxes are checked.
- **Step 6 settled as an explicit stamp, not a rebuild after the tag.** `release-publish` tags
  `main`'s merge commit (`ncipollo/release-action` on `github.sha`), which `develop` never
  reaches, so `git describe` on `develop` cannot name a release. `scripts/build-cli.ts` takes
  `--stamp X.Y.Z`; the release order is: settle the Release PR title, `bun run build:bundle
  --stamp X.Y.Z` on `develop`, commit, push, merge. `release-validate.yml`'s `bundle-stamp` job
  fails a Release PR whose committed bundle does not print its title's version, and
  `publish-npm.yml`'s gate repeats the check at the tag. Between releases the bundle on `develop`
  reports `0.0.0-g<sha>`. Specs updated first (`specs/architecture.md`).
- **Bootstrap without a red run.** `publish-npm.yml` skips a version already on the registry with
  a warning, so 0.1.0 is published by hand from the stamped `develop` commit *before* the Release
  PR merges; the release run then passes its gate and skips. The tree at `v0.1.0` equals that
  commit (`main` is an ancestor of `develop`). OIDC is first exercised by the release after 0.1.0.
- **Scrub gate**: `scripts/scrub-check.sh` (`check:scrub`), first step of `ci.yml` and of the
  publish gate. Every uuid in the tree outside `test/fixtures/` already had the synthetic
  `-4000-8000-` shape, so that shape is the allowlist; Homebrew's `linuxbrew` home is allowed only in the
  committed bundle. The planted-marker check was done in a throwaway clone on a scratch branch
  (home path, `/Users` path, two emails, a random uuid, linuxbrew outside the bundle: each exit 1;
  synthetic values exit 0) and is repeated by `test/scrub.test.ts` in temporary repos.
- Actions pinned after reading each README / latest release: `actions/checkout@v7`,
  `actions/setup-node@v7`, `oven-sh/setup-bun@v2`; infra-components `release-*/latest` channels.
  `actionlint` 1.7.12 clean (without its shellcheck integration).
- **Runbook** (also in PR #22 and `RELEASING.md`):
  1. Merge PR #22 into `develop` (merge commit); `release-prepare` opens `Release: v0.1.0`
     (approve an `action_required` run once if needed).
  2. Write the release notes (`release-flow`); keep the title `Release: v0.1.0`.
  3. On `develop`: `bun run build:bundle --stamp 0.1.0`, commit `build: stamp the skill bundle
     0.1.0`, push; wait for `ci` and both `release-validate` jobs to be green.
  4. Manual first publish by a maintainer from a clean clone of that commit: `asdf install`,
     bundle prints `0.1.0`, `npm version --no-git-tag-version 0.1.0`, `bun install
     --frozen-lockfile`, the full gate, `npm pack --dry-run`, `npm publish --access public`,
     `npx -y agent-session-axi@0.1.0 --version`.
  5. npmjs.com → `agent-session-axi` → Settings → Trusted Publisher → GitHub Actions:
     `JarvusInnovations` / `agent-session-axi` / `publish-npm.yml`, no environment; optionally
     require 2FA and disallow tokens.
  6. Repo settings: none to change (already `develop` default, merge-only, auto-delete, both
     rulesets); confirm `BOT_GITHUB_TOKEN` reaches this repository.
  7. Merge the Release PR (merge commit). `publish-npm`: gate green, publish skipped with the
     "already on the registry" warning; `git diff <stamped sha> v0.1.0 --stat` is empty.
  8. Verify: `npx -y agent-session-axi@0.1.0 --version` prints `0.1.0` on a clean machine;
     `npm i -g agent-session-axi` gives a working binary; `npx skills add
     JarvusInnovations/agent-session-axi` then the skill's `scripts/agent-session-axi --version`
     and a `tail` with the network disabled.
  9. Close issue #1 pointing at `specs/` and the release; check the remaining boxes; mark `done`.

## Follow-ups

- Tracked as: manual first publish + trusted publishing by a maintainer (the runbook above, on
  PR #22).
- After the next CI release, confirm OIDC: `npm view agent-session-axi _npmUser
  dist.attestations` shows `GitHub Actions` and a provenance attestation.
