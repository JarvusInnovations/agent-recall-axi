---
status: done
done: 2026-11-08
pr: 26
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

- [x] Pushing `develop` opens a `Release: v0.1.0` PR with a bot changelog; merging it publishes a
      GitHub release and triggers `publish-npm.yml`, whose gate passes and whose publish job
      skips with the already-published warning.
- [x] `npx -y agent-session-axi@0.1.0 --version` prints `0.1.0` on a clean machine; `npm i -g`
      installs a working `agent-session-axi` binary.
- [x] `npx skills add JarvusInnovations/agent-session-axi` installs the skill whose bundled CLI
      reports `0.1.0` (offline behaviour is covered by the network-blocked tests; the host used
      for this check could not drop its network namespace).
- [x] Trusted publisher configured for `publish-npm.yml` by the maintainer; the first CI
      publish (the next release) is where `_npmUser` GitHub Actions and the provenance
      attestation get checked (RELEASING.md, normal cycle step 5).
- [x] Issue #1 is closed with a comment pointing at the specs and the release.

## Notes

- 2026-11-08: split out of `first-publish` so that plan could merge done; these boxes can only be
  checked after the publish.
- 2026-11-08: 0.1.0 published by hand from the stamped commit 369d6dc; Release PR #25 merged
  (c9933eb); `release-publish` tagged v0.1.0 with an empty diff against 369d6dc; `publish-npm`
  gate passed and the publish job skipped the already-published version. npx, a global
  install and the skill channel all print 0.1.0.
