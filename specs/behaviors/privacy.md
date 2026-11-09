# Behavior: Privacy — local files only

## Rule

The tool reads local files the current user can already read, writes nothing except its own cache
under the user's cache directory, and never sends session content anywhere. The one exception is
`hook install`: only when asked, it writes the agent settings files it names (`cli.md#hook`), and
`hook uninstall` reverts that; nothing else installs a hook or writes outside the cache.

## Applies To

Every command, the library, the skill and the session hook.

## Details

- **Persisted outputs** are read only from the session's own `<sidecar>/tool-results/`, as regular
  files (`data-model.md#pointer`). A path named inside a log is data, not an instruction to read
  that file.
- **Inputs** are files under the agent's log directory (`~/.claude/projects` for the Claude Code
  adapter) or paths the caller names. The tool never widens permissions, never follows symlinks
  out of the log directory without being handed the path, and never reads another user's home.
- **No network, ever.** No command opens a socket. The SDK's built-in `update` (which would query
  the npm registry) is shadowed by the tool's own `update`, a print-only command that tells the
  caller how to update by hand (`cli.md#update`). There is no exception.
- **No writes next to the logs.** The tool never creates, modifies, or deletes anything under the
  log directory, including the session sidecar directories. Session files are opened read-only.
- **Cache** (`architecture.md#cache`): derived indexes only. The cache may hold ids, seqs,
  offsets, hashes, kinds, counts, tool names, the file paths a call targeted, entry timestamps and
  model names; it never holds message text, tool input text or result text (a session title is
  kept as the position of its line, not its text). The one exception is `search`'s term index:
  the lower-cased word tokens of every `H` and `C` text, `thinking` and call inputs included,
  each with the seqs that hold it, sorted by token so no order survives. A secret pasted into a
  prompt or a command is therefore present in the cache as tokens until `cache clear` removes
  it. It lives under `$XDG_CACHE_HOME/agent-recall-axi/` (default
  `~/.cache/agent-recall-axi/`), is created with owner-only permissions, is keyed by file identity
  so it can never attribute one file's content to another, and is fully removable with
  `cache clear`. Deleting it loses nothing; everything is rebuilt from the logs.
- **Exports** (`--json-out[=path]`) write where the caller says, or to an owner-only temp file; the
  output names the path. A named path is opened owner-only, never through a symlink, and only
  as a regular file the current user owns (`cli.md#conventions`). They are the only way session content leaves stdout, and the caller
  invokes them explicitly.
- **Hooks**: `hook install` is the only command that writes outside the cache, the only one
  that writes agent settings, and it writes only the files its output names. Exports below are
  the caller's own files, not settings.
- **The skill and the README** state this rule in one sentence near the top, because session logs
  hold everything a human typed.

## Principles

**Inherited:**
- [Reads only, never sends](../principles.md#reads-only-never-sends).
