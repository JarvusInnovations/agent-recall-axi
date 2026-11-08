---
status: in-progress
depends: [sessions-and-recall, resume-pack-library]
specs:
  - specs/architecture.md
  - specs/cli.md
  - specs/behaviors/privacy.md
issues: [1]
---

# Plan: Skill bundle and session hook

## Scope

The second distribution channel and the ambient integration: the esbuild single-file bundle
committed under `skills/agent-session-axi/scripts/` with its shim, `SKILL.md` with a generated
command reference, `--check` drift gates in CI for both, `hook install|status|uninstall` for
Claude Code, Codex and OpenCode at user or project scope, and hook mode for the home view
(resume pack after `compact`/`resume`).

## Implements

- `specs/architecture.md#build-and-distribution` (channel 2), `#session-hook`.
- `specs/cli.md#hook`, `#home-view-no-arguments` (hook mode).
- `specs/behaviors/privacy.md` — the skill states the rule; hook installs only on explicit command.

## Approach

0. **Prove the hook payload path first.** Install the SDK's SessionStart hook into a scratch
   settings file, run the installed command string the way Claude Code does (JSON payload with
   `session_id`, `transcript_path`, `source: compact` on stdin), and record whether the home view
   process receives it. If it does, hook mode rides the SDK install. If the SDK's command wrapping
   drops stdin, register our own `ManagedHookSpec` via `computeSessionStartHookUpdate` with a
   command that reads stdin, and keep the SDK helpers for status/uninstall. Write the finding into
   this plan's Notes before step 1 begins.
1. `scripts/build-cli.ts` (from the axi-skills templates): esbuild `src/cli-bundle-entry.ts` →
   `skills/agent-session-axi/scripts/agent-session-axi.mjs`, `platform: node`, `target: node22`,
   `format: esm`, shebang banner, version stamped from `git describe`; `--check` normalizes the
   version literal out of both sides before comparing. Executable bit committed; `.gitattributes`
   marks the bundle `linguist-generated`.
2. Shim `skills/agent-session-axi/scripts/agent-session-axi`: three-line bash `exec node
   "$(dirname "$0")/agent-session-axi.mjs" "$@"`.
3. `cliInvocation()`: resolved path for emitted examples; bare `agent-session-axi` only when it is
   on `PATH` and resolves to the running executable.
4. `scripts/build-skill.ts`: splice `COMMAND_GROUPS` into `SKILL.md` between
   `<!-- BEGIN/END GENERATED: command-reference -->`; prose hand-written: trigger-shaped
   frontmatter (`description` written for "what was I doing / have I dealt with this / what did
   the human ask"), the privacy sentence, the zoom ladder, the exploration loop, and both install
   paths.
5. `commands/hook.ts`: wrap SDK `installSessionStartHooks`/`sessionStartHookStatus`/
   `uninstallSessionStartHooks` with `marker: "agent-session-axi"`, `--scope`, `--agent`;
   idempotent; path repair; `AGENT_SESSION_AXI_DISABLE_HOOKS=1` honored (tests set it).
6. `src/hook.ts`: detect a SessionStart payload on non-TTY stdin (`session_id`, `source`,
   `transcript_path`); home prints `resume-pack <session> --budget 6000` for `compact`/`resume`,
   the listing otherwise; falls back to the listing when the payload is unparsable.
7. CI: `check:bundle`, `check:skill`; a job that runs the committed bundle on a fresh checkout
   with `node` only (no `bun install`) against the fixtures.

## Validation

- [ ] Step 0 recorded in Notes: a reproducible test shows whether the SDK-installed command
      receives the SessionStart stdin payload; hook mode is wired through whichever path the
      test proved, and a fixture test pipes `source: compact` through that exact command string.
- [ ] `bun run build:bundle` produces a single `.mjs` with no `import` of a bare package name
      (grep); `node skills/agent-session-axi/scripts/agent-session-axi.mjs --version` works in a
      checkout with `node_modules` removed; the shim runs the same.
- [ ] `check:bundle` passes right after a build, fails after a one-line source change, and
      passes again across a commit that changed only the git sha (version normalization).
- [ ] `SKILL.md` has frontmatter `name`, `description`; the generated region matches
      `COMMAND_GROUPS`; `check:skill` fails when a command summary changes without regeneration;
      every example in the skill uses the resolved path form, not a bare binary name.
- [ ] `hook install --scope project` adds the Claude Code `SessionStart` entry, the Codex hook and
      the OpenCode plugin under the project; `hook status` reports all three; running twice is a
      no-op (file bytes unchanged); `hook uninstall` removes only marker-matched entries and leaves
      a pre-existing unrelated hook intact (fixture settings file).
- [ ] Hook mode: piping `{"session_id":"<fixture>","source":"compact"}` into the home view prints
      a resume pack for that session with `budget: … of 6k`; `source: startup` prints the listing;
      garbage on stdin prints the listing.
- [ ] No command other than `hook install` writes to any settings file (test wraps the fixture
      home dir and asserts no writes).
- [ ] The fresh-checkout CI job runs `tail`, `find`, `resume-pack` via the bundle against fixtures
      and matches the `dist/` outputs byte-for-byte.
- [ ] `npx skills add` dry run: the skill directory contains only `SKILL.md`, `scripts/`, and
      nothing that depends on the repo root at runtime.

## Risks / unknowns

- **Hook payload path** — settled by Approach step 0 before any other work in this plan; the
  custom `ManagedHookSpec` is the fallback, not an open design question.
- **Bundle reproducibility** — esbuild output must be deterministic across machines for the drift
  gate; pin esbuild exactly and build in CI with the same Node major.
- **`.mjs` and SDK auto-install** — the SDK's filename heuristic never auto-installs hooks for a
  `.mjs` entry, which is the behavior we want; do not pass `hooks:` options.

## Notes

- **Step 0 (hook payload path), recorded before step 1.** `installSessionStartHooks` (axi-sdk-js
  0.1.14) writes the resolved binary itself as the hook `command` (an absolute path, or the bare
  name when it is on `PATH` and resolves to the same file), with no wrapper, for Claude Code and
  Codex. Installed into a scratch home and project and run the way Claude Code runs a hook
  (`sh -c "<command>"` with a JSON payload carrying `session_id`, `transcript_path` and
  `source: compact` on stdin), the process received the payload byte for byte. Hook mode
  therefore rides the SDK install; no custom `ManagedHookSpec` is needed. The OpenCode plugin the
  SDK writes spawns the command with stdin ignored, so under OpenCode the home view always sees
  an empty stdin and prints the listing. `test/hook.test.ts` repeats this through the exact
  command string the install wrote.

## Follow-ups

(at closeout)
