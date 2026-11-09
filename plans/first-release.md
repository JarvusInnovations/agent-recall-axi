---
status: planned
depends: [first-publish]
specs:
  - specs/architecture.md
issues: [1]
---

# Plan: First release (v0.1.0)

## Scope

The maintainer-only steps of `RELEASING.md` § The first publish: the Release PR and its notes,
the bundle stamp on `develop`, the manual `npm publish`, trusted-publisher setup on npmjs.com,
merging the Release PR, and verifying the three install channels.

## Validation

- [ ] Pushing `develop` opens a `Release: v0.1.0` PR with a bot changelog; merging it publishes a
      GitHub release and triggers `publish-npm.yml`, whose gate passes and whose publish job
      skips with the already-published warning.
- [ ] `npx -y agent-session-axi@0.1.0 --version` prints `0.1.0` on a clean machine; `npm i -g`
      installs a working `agent-session-axi` binary.
- [ ] `npx skills add JarvusInnovations/agent-session-axi` installs the skill whose bundled CLI
      runs offline (network disabled) and reports `0.1.0`.
- [ ] Trusted publisher configured for `publish-npm.yml`; the next release shows
      `_npmUser` GitHub Actions and a provenance attestation.
- [ ] Issue #1 is closed with a comment pointing at the specs and the release.

## Notes

- 2026-11-08: split out of `first-publish` so that plan could merge done; these boxes can only be
  checked after the publish.
