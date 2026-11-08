---
status: planned
depends: [skill-and-hook]
specs:
  - specs/architecture.md
issues: [1]
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
- [ ] README renders both install paths and states "reads local files only; sends nothing".
- [ ] Scrub gate passes on the tree and fails on a planted marker in a scratch branch.
- [ ] Issue #1 is closed with a comment pointing at the specs and the release.

## Risks / unknowns

- **First-publish bootstrap** — trusted publishing cannot create the package; the manual publish
  is a one-time step documented in `RELEASING.md`.
- **Version in two places** — package.json stays 0.0.0 in git until the release sets it; the
  bundle's stamped version comes from `git describe`. Both are explained in `RELEASING.md`.

## Notes

(at closeout)

## Follow-ups

(at closeout)
