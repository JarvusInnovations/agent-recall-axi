---
status: in-progress
depends: [skill-and-hook, followups-0.2.1]
specs:
  - specs/cli.md
  - specs/architecture.md
  - specs/behaviors/privacy.md
---

# Plan: `hook` becomes `setup hooks`

## Scope

The hook is managed by a top-level `hook install|status|uninstall`. The house style for AXI tools
(the `jarvus-axi` skill, vendored here) and the upstream reference tools use `setup hooks`, with
the bare form meaning install-or-repair. **In:**
- **The command.** `setup hooks [--scope] [--agent]` installs or repairs; `setup hooks status` and
  `setup hooks uninstall` are actions under it. Every behavior of the three operations stays: scope
  handling, the per-target table, fail-closed headlines and exit codes, no-op wording, read-back
  verification, `AGENT_RECALL_AXI_DISABLE_HOOKS=1`.
- **The retired name.** `hook` stays registered and fails `VALIDATION_ERROR` with the corrected
  call, the caller's arguments folded in. No alias.
- **Everything that names the command**: the reference (help, usage lines), emitted hints, the
  Codex feature-flag line, README, specs, the skill's prose and generated region, the bundle.

**Out:**
- The command string written into agent settings, the marker, and which entries are ours. Hooks
  installed by earlier versions keep working and keep showing as installed.
- Hook mode (the home view reading a SessionStart payload on stdin).
- The output's `hook:` first-line key.
- Source file names (`src/commands/hook.ts`, `hook-settings.ts`), to keep the diff reviewable.
- The house style's project-target rule (`--dir`, else the git root). Project scope still writes
  under the working directory; changing that is a behavior change of its own.

## Implements

- `specs/cli.md` § setup hooks: the shape, the `setup` and `setup hooks` action errors, the retired
  `hook` redirect, hints and the Codex line under the new name.
- `specs/architecture.md` § Session hook and `specs/behaviors/privacy.md`: the new name.

## Approach

- `src/reference.ts`: the `hook` entry becomes `setup`, with the three usage forms.
- `src/commands/hook.ts`: `setupCommand` dispatches `setup` → `hooks` → (none | `status` |
  `uninstall`) and parses flags per action through `parseFlags`; `retiredHookCommand` builds the
  redirect, as `recall` does in `src/cli.ts`.
- `usageLine` falls back to the first word's reference entry, so `setup hooks status` errors print
  the real usage line.
- Regenerate the skill region (`bun run build:skill`) and rebuild the bundle
  (`bun run build:bundle`, no `--stamp`).

## Validation

- [ ] Unit: the existing hook suite passes against `setup hooks`, `setup hooks status` and
      `setup hooks uninstall`, including the test that only the install writes a settings file.
- [ ] Unit: an entry written under the old command name (same command string) reads as `installed`
      and is removed by `setup hooks uninstall`.
- [ ] Unit: `hook install --scope project`, `hook status` and `hook uninstall` each exit 2 with the
      corrected call, arguments carried, and write nothing.
- [ ] Unit: `setup`, `setup bogus`, `setup hooks bogus`, `setup hooks install` and
      `setup hooks status --agent claude` exit 2 naming what is valid.
- [ ] Unit: every `Run` hint the three operations and the redirects print runs with exit 0.
- [ ] Unit project passes. check, build, check:types, check:skill, check:bundle and check:scrub pass.

## Risks / unknowns

- **A breaking rename.** Agents and docs that remember `hook install` get one corrected call from
  the redirect; the release carrying this is a minor bump while the tool is pre-1.0.
