# Releasing

`agent-recall-axi` ships through two channels from one tag
([`specs/architecture.md#build-and-distribution`](specs/architecture.md#build-and-distribution)):
the npm package, and the skill that `npx skills add JarvusInnovations/agent-recall-axi` copies
from the repository with its committed bundle. Releases use the house develop→main Release-PR
flow: pushing `develop` opens a `Release: vX.Y.Z` PR into `main`, and **merging that PR
publishes**.

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push / PR to `main` or `develop` | Scrub gate, type check, build, consumer type check, tests, `check:skill`, `check:bundle`, bin smoke test, and the skill bundle run with `node` alone |
| `main-guard.yml` | PR to `main` | Required check: the head must be `develop` (the Release PR) or `hotfix/*` |
| `main-retarget.yml` | PR to `main` opened | Moves any other PR onto `develop` and comments; never runs the PR's code |
| `release-prepare.yml` | push to `develop` | Opens or refreshes the `Release: vX.Y.Z` PR and its bot `## Changelog` comment |
| `release-validate.yml` | PR to `main` | Title format and tag collision (infra-components), plus `bundle-stamp`: the committed bundle must print the title's version |
| `release-publish.yml` | Release PR merged | Tags `main`'s merge commit `vX.Y.Z` and creates the GitHub release with the PR body as its notes (uses `BOT_GITHUB_TOKEN`) |
| `publish-npm.yml` | GitHub release published | `gate`: version from the tag, scrub, bundle stamp, the full CI gate at the tag. `publish-npm`: `npm publish --provenance --access public` on Node 24 through trusted publishing (OIDC, no token); `-rc.N` goes under the `next` dist-tag; a version already on the registry is skipped with a warning |

## How the version flows

1. **Git**: `package.json` says `0.0.0` and is never bumped in a commit. The tag is the version.
2. **Tag**: `release-publish` cuts `vX.Y.Z` from the Release PR's title on `main`'s merge commit.
3. **npm**: `publish-npm.yml` runs `npm version --no-git-tag-version X.Y.Z` before building, so
   `dist/` and the published `package.json` say `X.Y.Z`, and `--version` reads it from there.
4. **Skill bundle**: `scripts/agent-recall-axi.mjs` carries its version as a literal stamped at
   build time: `--stamp <version>` when given, else `git describe --tags --match 'v[0-9]*'`,
   else `<package.json version>-g<sha>`. `check:bundle` ignores that one literal, so a restamp
   never fails CI.

The tag sits on `main`'s merge commit, which `develop` never reaches (there are no backmerges),
so `git describe` on `develop` can never name a release. The release version therefore goes into
the bundle explicitly, on `develop`, **before** the Release PR merges:

```sh
bun run build:bundle --stamp X.Y.Z      # no leading v
git add skills/agent-recall-axi/scripts/agent-recall-axi.mjs
git commit -m "build: stamp the skill bundle X.Y.Z"
git push origin develop
```

That commit is in the merge, so the tree at `vX.Y.Z` reports `X.Y.Z` through both channels, and
so does `main` (the default branch, which `npx skills add` installs) until the next release.
`develop` carries the same stamp until its next bundle rebuild, which reports `0.0.0-g<sha>`: a
development build that skill users never receive. `release-validate`'s `bundle-stamp`
check blocks a Release PR whose bundle is not stamped with its title's version, and
`publish-npm`'s gate repeats the check at the tag. Settle the title **before** stamping; a retitle
needs a restamp.

## The normal release cycle

Follow the `release-flow` skill. In short:

1. Merge feature PRs into `develop` (merge commits only). Each push refreshes the Release PR.
2. When ready, pull the bot changelog, write the notes into the PR body (Improvements /
   Technical), and set the title to the right semver bump (the bot always proposes last tag +
   patch).
3. Stamp the bundle with that version (above) and push `develop`. Wait for `ci` and both
   `release-validate` jobs to be green.
4. Merge the Release PR with a merge commit. `release-publish` tags and creates the release;
   `publish-npm` publishes it.
5. Verify:

   ```sh
   npm view agent-recall-axi version _npmUser dist.attestations
   # _npmUser.name 'GitHub Actions', trustedPublisher set, provenance predicate slsa.dev/provenance/v1
   npx -y agent-recall-axi@X.Y.Z --version
   gh release view vX.Y.Z --json body --jq .body
   ```

## The first publish (one time, by a maintainer)

Trusted publishing is configured per package on npmjs.com, and the package page exists only after
the first publish, so `0.1.0` goes out by hand. It is published from the exact commit that will be
tagged, before the Release PR merges; `publish-npm.yml` then finds `0.1.0` on the registry and
skips it. Publishing claims the name for good (unpublish is limited to 72 hours), so run it once,
deliberately.

1. Merge the PR that adds these workflows into `develop`. `release-prepare` opens
   `Release: v0.1.0` (a new `v*` track starts at `v0.1.0`). If its checks sit at
   `action_required`, approve the run once in the Actions tab.
2. Write the release notes into the PR body. Keep the title `Release: v0.1.0`.
3. Stamp and push (`bun run build:bundle --stamp 0.1.0`, commit, `git push origin develop`).
   Wait for `ci` and `release-validate` (both jobs) to be green on the Release PR.
4. Publish from a clean clone of that commit, logged in to npm as a maintainer of the
   `JarvusInnovations` packages:

   ```sh
   sha=$(git rev-parse origin/develop)          # the stamped commit the Release PR will merge
   git clone https://github.com/JarvusInnovations/agent-recall-axi.git /tmp/asa-release
   cd /tmp/asa-release && git checkout --detach "$sha"
   asdf install                                  # node and bun from .tool-versions
   test "$(node skills/agent-recall-axi/scripts/agent-recall-axi.mjs --version)" = 0.1.0
   npm version --no-git-tag-version 0.1.0
   bun install --frozen-lockfile
   bun run check && bun run build && bun run check:types && bun run test \
     && bun run check:skill && bun run check:bundle && bun run check:scrub
   npm pack --dry-run                            # dist/, skills/agent-recall-axi/, LICENSE, README.md, package.json
   npm login                                     # if not already
   npm publish --access public                   # prepublishOnly rebuilds dist/
   npx -y agent-recall-axi@0.1.0 --version      # 0.1.0
   ```

5. Configure trusted publishing: on npmjs.com, open the `agent-recall-axi` package →
   **Settings** → **Trusted Publisher** → **GitHub Actions**, and enter organization or user
   `JarvusInnovations`, repository `agent-recall-axi`, workflow filename `publish-npm.yml`,
   environment left blank. Save. Optionally, under **Publishing access**, require two-factor
   authentication and disallow tokens, so only the workflow (and a 2FA'd maintainer) can publish.
6. Confirm the org secret `BOT_GITHUB_TOKEN` is available to this repository (`release-publish`
   needs it to create the tag and release), then merge the Release PR with a merge commit.
   `release-publish` tags `v0.1.0`; `publish-npm` runs its gate and skips the publish with a
   warning that `0.1.0` is already on the registry.
7. Check that the tag is the commit you published: `git fetch --tags && git diff "$sha" v0.1.0 --stat`
   prints nothing.

The trusted-publisher configuration is first exercised by the next release (`0.1.1` or `0.2.0`):
check `npm view agent-recall-axi _npmUser dist.attestations` afterwards. A human in `_npmUser`
means that publish did not go through the workflow.
