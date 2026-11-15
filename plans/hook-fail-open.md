---
status: done
pr: 39
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

- [x] Unit: `setup hooks --agent opencode` over an unmanaged plugin file exits 1, never headlines
      installed, leaves the file's bytes alone, and names the path and the marker line; `status`
      gives the target the same state, exits 1 and does not suggest a bare install as the fix.
- [x] Unit: with `[features] hooks = true` in a `config.toml` made unreadable (chmod 000, skipped
      as root, mode restored), `setup hooks status` prints `cannot read:` for `codex_features`,
      headlines `installed (user scope; see errors)` and exits 1; nothing says `not set`.
- [x] Unit: in that state bare `setup hooks` headlines `already installed (user scope; no changes;
      see errors)`, exits 1, and writes nothing.
- [x] Unit: `not set` is printed for a missing config and for a config without the key;
      `hooks = false` is printed as such; a `features` declaration the tool does not read is
      `cannot read:` in `status`, exit 1.
- [x] Unit: an install where one target errors and the others are already in place headlines
      `partly installed`, not `not installed`.
- [x] Unit: a managed OpenCode plugin whose command line cannot be read is `stale` in `status`, and
      the install repairs it.
- [x] Unit project: 398 tests pass. check, build, check:types, check:skill, check:bundle and check:scrub pass.

## Risks / unknowns

- **`status` exits 1 in two states where it exited 0.** Both are states the install already
  refuses (an unmanaged plugin file is new; an unreadable or unsupported `config.toml` already
  failed the Codex target). A healthy install sees no change.

## Notes

- The unmanaged plugin's row is an `error:` in the install and in `status`, so the existing
  `; see errors` wording and exit 1 cover it without a fourth kind of row. `uninstall` keeps
  `unmanaged (left in place)` and exit 0.
- After an error the install's first line counts the targets that hold the hook with the command
  this install writes. A target whose row errored is read once more for that count; a stale entry
  that could not be repaired does not count.
- Found in the sweep and fixed here: `hooks = false` was printed as `not set`; a `features`
  declaration the tool does not read (a dotted key, two tables, a non-boolean value) was printed as
  `not set`; an install with an error beside targets already in place said `not installed`; a
  managed OpenCode plugin with no readable command line was `absent` in `status`; `status` after
  any `error:` row suggested the install that had just failed.
- Looked at and left: `realFile` (PATH lookup that only chooses between the bare name and the
  path), the `status` fallback when the running binary is a source checkout (no command to compare
  against), and `atomicWrite`'s stat of a file that does not exist yet. None of them decides a
  reported state.
- The rebuilt bundle reports a development version (`0.0.0-g<sha>`) until the release stamp
  (`RELEASING.md`).

## Follow-ups

- **Issue**: `status` exits 0 and headlines `installed` when the Codex hook is in place and the
  flag was read as `not set` or `hooks = false`, a state where Codex does not run the hook. It is a
  true report, not a failed read, so it is out of this plan. Not filed yet.
- **Issue**: `uninstall` leaves `[features] hooks = true` in the user's Codex config and does not
  say so. Not filed yet.
- **Issue**: the tool's AXI catalog entry is pinned at v0.3.0; re-pin it after the release that
  carries this.
