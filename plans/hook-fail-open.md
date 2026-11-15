---
status: in-progress
depends: [setup-hooks]
specs:
  - specs/cli.md
---

# Plan: `setup hooks` stops reporting failed states as success

## Scope

An independent catalog re-review of v0.3.0 found three places where `setup hooks` reports a failed
or partial state as success. **In:**
- **An unmanaged OpenCode plugin file.** The install leaves a plugin file without the managed
  marker in place, which is right, but then headlines `already installed` and exits 0. `status`
  calls the same target `absent` and suggests the install, which repeats the claim.
- **A Codex `config.toml` that cannot be read.** `status` swallows the read error and prints
  `(not set)` under `hook: installed`, exit 0.
- **The install's headline in that state.** The Codex row errors and the exit is 1, but the first
  line says `not installed` when all three targets hold the hook, and the flag line repeats
  `(not set)`.
- **The same class elsewhere** in `src/commands/hook.ts` and `hook-settings.ts`: a read whose
  failure becomes "absent", "not set", empty, a no-op or success, and a headline that can disagree
  with a target row.

**Out:**
- The command string written into settings, the marker, which entries are ours, hook mode and the
  command surface.
- `uninstall` on an unmanaged plugin file: it has nothing of ours to remove, so `unmanaged (left in
  place)` with exit 0 stays.
- Exit codes of a healthy install. Nothing here changes one.

## Implements

- `specs/cli.md` § setup hooks: the unmanaged plugin rule, the `codex_features` values and its
  `cannot read:` error, the install's first line counted from the targets that hold the hook, and
  the footer after an error.

## Approach

- `src/commands/hook.ts`: `codexFeatures` reads the config itself and returns the line plus whether
  it is an error; `readOrUndefined` goes away. The install records, per target, whether the hook is
  in place after the run, and builds the first line from that count. One shared row state and one
  shared hint serve the unmanaged plugin file in the install and in `status`.
- Tests fail first, in their own commit, then the fix.
- Rebuild the bundle (`bun run build:bundle`, no `--stamp`).

## Validation

- [ ] Unit: `setup hooks --agent opencode` over an unmanaged plugin file exits 1, never headlines
      installed, leaves the file's bytes alone, and names the path and the marker line; `status`
      gives the target the same state, exits 1 and does not suggest a bare install as the fix.
- [ ] Unit: with `[features] hooks = true` in a `config.toml` made unreadable (chmod 000, skipped
      as root, mode restored), `setup hooks status` prints `cannot read:` for `codex_features`,
      headlines `installed (user scope; see errors)` and exits 1; nothing says `not set`.
- [ ] Unit: in that state bare `setup hooks` headlines `already installed (user scope; no changes;
      see errors)`, exits 1, and writes nothing.
- [ ] Unit: `not set` is printed for a missing config and for a config without the key;
      `hooks = false` is printed as such; a `features` declaration the tool does not read is
      `cannot read:` in `status`, exit 1.
- [ ] Unit: an install where one target errors and the others are already in place headlines
      `partly installed`, not `not installed`.
- [ ] Unit: a managed OpenCode plugin whose command line cannot be read is `stale` in `status`, and
      the install repairs it.
- [ ] Unit project passes. check, build, check:types, check:skill, check:bundle and check:scrub pass.

## Risks / unknowns

- **`status` exits 1 in two states where it exited 0.** Both are states the install already
  refuses (an unmanaged plugin file is new; an unreadable or unsupported `config.toml` already
  failed the Codex target). A healthy install sees no change.
