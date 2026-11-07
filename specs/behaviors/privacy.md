# Behavior: Privacy — local files only

## Rule

The tool reads local files the current user can already read, writes nothing except its own cache
under the user's cache directory, and never sends session content anywhere.

## Applies To

Every command, the library, the skill and the session hook.

## Details

- **Inputs** are files under the agent's log directory (`~/.claude/projects` for the Claude Code
  adapter) or paths the caller names. The tool never widens permissions, never follows symlinks
  out of the log directory without being handed the path, and never reads another user's home.
- **No network.** No command opens a socket. The only exception is the SDK's built-in `update`,
  which asks the npm registry for the package's latest version and sends the package name only;
  it is documented as such in `--help` and the README.
- **No writes next to the logs.** The tool never creates, modifies, or deletes anything under the
  log directory, including the session sidecar directories. Session files are opened read-only.
- **Cache** (`architecture.md#cache`): derived indexes only (offsets, hashes, per-session stats,
  and, for `recall`, a term index). It lives under `$XDG_CACHE_HOME/agent-session-axi/` (default
  `~/.cache/agent-session-axi/`), is created with owner-only permissions, is keyed by file identity
  so it can never attribute one file's content to another, and is fully removable with
  `cache clear`. Deleting it loses nothing; everything is rebuilt from the logs.
- **Exports** (`--json-out[=path]`) write where the caller says, or to an owner-only temp file; the
  output names the path. They are the only way session content leaves stdout, and the caller
  invokes them explicitly.
- **The skill and the README** state this rule in one sentence near the top, because session logs
  hold everything a human typed.

## Principles

**Inherited:**
- [Reads only, never sends](../principles.md#reads-only-never-sends).
