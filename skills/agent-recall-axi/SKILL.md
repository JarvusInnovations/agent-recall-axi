---
name: agent-recall-axi
description: Read your own and other agents' session logs (Claude Code first) to remember. Use when asked "what was I doing", "where did we leave off", "have I dealt with this before", "what did the human ask for and when", after a context compaction or resume, when auditing what a bot or subagent did and why, or when looking for a past command, file edit, error or decision. Pans and zooms through transcripts by stable ids; TOON output; reads local files only.
---

# agent-recall-axi

Session logs are the full-resolution memory of what an agent was asked, did and said. This CLI
reads them in small, cited pieces: every row carries an id like `7a2f1c3e:418` that stays valid
for the life of the file, and every listing ends with the exact next command.

**It reads local files only and sends nothing**: session logs hold everything a human typed, so
the tool never opens a network connection, never modifies a log, and writes only its own
disposable cache under `~/.cache/agent-recall-axi/`, plus, only when you run
`scripts/agent-recall-axi hook install`, the agent settings files that command names (which
`scripts/agent-recall-axi hook uninstall` reverts).

## Running it

The CLI ships inside this skill as a self-contained bundle; it needs `node` 22 or newer and
nothing else. It is **not on `PATH`**: run every command as `scripts/agent-recall-axi …`,
resolved against this skill's own directory (for example
`~/.claude/skills/agent-recall-axi/scripts/agent-recall-axi tail latest`). The output names the
same resolved path in its hints; if you ever see a follow-up starting with a bare
`agent-recall-axi`, run it through this skill's `scripts/agent-recall-axi` instead.

- `scripts/agent-recall-axi` with no command: the current project's sessions and where the
  latest left off.
- `scripts/agent-recall-axi <command> --help`: flags, defaults and examples for one command.

## The zoom ladder

```
sessions                 which sessions exist                    (zoomed out)
turns <session>          one row per human prompt
events / tail / around / next / prev   rows                       (pan)
show <id>                one entry, whole                         (zoom in)
show <id> --full         ...with persisted output followed
```

Search (find, recall) enters the ladder at any rung; human, tools and compactions are views of
the rows rung; resume-pack is a fixed composite for a cold start. A `<session>` is a path, a
uuid, an 8+ character prefix, or `latest`.

## The exploration loop

1. **Orient**: `scripts/agent-recall-axi` (this project) or `scripts/agent-recall-axi sessions --all`.
2. **Get back the thread** after a compaction or a fresh start:
   `scripts/agent-recall-axi resume-pack latest`: the window's summary, every human message
   verbatim, the last tool calls and the agent's last claims.
3. **Find the moment**: `scripts/agent-recall-axi find "<phrase>"` in this project,
   `scripts/agent-recall-axi recall "<phrase>"` across every project ("have I dealt with this
   before?"), or `scripts/agent-recall-axi find <session> --file '<glob>'` (or `--tool <name>`). Each hit says why it matched.
4. **Pan** around a hit: `scripts/agent-recall-axi around <id>`, then
   `scripts/agent-recall-axi next <id>` / `scripts/agent-recall-axi prev <id>`.
5. **Zoom** into one entry: `scripts/agent-recall-axi show <id>`, `--full` for persisted output.

Weigh what you read by its authority column: `H` is what the human typed (the record of intent,
always verbatim), `C` is an agent's own claim, `D` is data a tool returned.

## Install

Two ways to get the same tool; one is enough.

- **Skill** (works offline, no registry at run time): `npx skills add JarvusInnovations/agent-recall-axi`
- **npm**: `npm i -g agent-recall-axi`, or `npx -y agent-recall-axi <command>`

Optional ambient context: `scripts/agent-recall-axi hook install` registers a SessionStart hook
for Claude Code, Codex and OpenCode (`--scope project` for one repo). At session start it shows
the project's sessions; after a compaction or a resume it prints that session's resume pack.
Nothing else ever installs a hook; `scripts/agent-recall-axi hook uninstall` removes only this
tool's entries.

## Commands

<!-- BEGIN GENERATED: command-reference -->

### zoomed out

- `scripts/agent-recall-axi sessions [--project <p> | --all] [--since <span>] [--from <when>] [--to <when>] [--limit <n>] [--subagents] [--fields <a,b>] [--json-out[=path]]`: sessions in scope, most recently active first
- `scripts/agent-recall-axi turns <session> [--from <when|id>] [--to <when|id>] [--since <span>] [--window <k|last>] [--limit <n>] [--full] [--project <p> | --all] [--json-out[=path]]`: one row per human prompt and how the turn ended

### pan

- `scripts/agent-recall-axi events <session> [--from <when|id>] [--to <when|id>] [--since <span>] [--window <k|last>] [--kind <a,b|all>] [--limit <n>] [--head <n>] [--full] [--fields <a,b>] [--project <p> | --all] [--json-out[=path]]`: rows of a session in file order; newest last unless --from is given
- `scripts/agent-recall-axi tail <session> [<n>] [--limit <n>] [--kind <a,b|all>] [--head <n>] [--full] [--fields <a,b>] [--window <k|last>] [--project <p> | --all]`: the last n visible rows (default 20): what was I doing
- `scripts/agent-recall-axi around <id> [--before <n>] [--after <n>] [--context <n>] [--kind <a,b|all>] [--head <n>] [--full] [--fields <a,b>] [--window <k|last>] [--session <ref>] [--project <p> | --all]`: rows on both sides of an id, the anchor included
- `scripts/agent-recall-axi next <id> [<n>] [--limit <n>] [--kind <a,b|all>] [--head <n>] [--full] [--fields <a,b>] [--window <k|last>] [--session <ref>] [--project <p> | --all]`: the n visible rows after an id (default 20)
- `scripts/agent-recall-axi prev <id> [<n>] [--limit <n>] [--kind <a,b|all>] [--head <n>] [--full] [--fields <a,b>] [--window <k|last>] [--session <ref>] [--project <p> | --all]`: the n visible rows before an id (default 20), in file order

### zoom

- `scripts/agent-recall-axi show <id> [--full] [--raw] [--fields <a,b>] [--session <ref>] [--project <p> | --all]`: one entry or event, whole (alias: zoom)
- `scripts/agent-recall-axi zoom <id> [--full] [--raw] [--fields <a,b>] [--session <ref>] [--project <p> | --all]`: alias of show: the same arguments, the same output

### views

- `scripts/agent-recall-axi human <session> [--from <when|id>] [--to <when|id>] [--since <span>] [--window <k|last>] [--budget <chars>] [--full] [--rows] [--project <p> | --all] [--json-out[=path]]`: every human message (typed, queued, slash commands, answers), verbatim
- `scripts/agent-recall-axi tools <session> [--name <tool>] [--file <pattern>] [--errors] [--from <when|id>] [--to <when|id>] [--since <span>] [--window <k|last>] [--limit <n>] [--full] [--fields <a,b>] [--project <p> | --all] [--json-out[=path]]`: tool calls with their result status folded in
- `scripts/agent-recall-axi compactions <session> [--full] [--project <p> | --all]`: where the context window closed, and the summary that stood in for it
- `scripts/agent-recall-axi resume-pack <session> [--window <k|last>] [--budget <chars>] [--tools <n>] [--claims <n>] [--project <p> | --all]`: the cold-start block: the window's summary, every human message, the last tool calls and claims

### search

- `scripts/agent-recall-axi find [<session>] [<phrase>] [--regex] [--file <pattern>] [--tool <name>] [--kind <a,b|all>] [--from <when|id>] [--to <when|id>] [--since <span>] [--window <k|last>] [--context <n>] [--before <n>] [--after <n>] [--limit <n>] [--head <n>] [--full] [--fields <a,b>] [--project <p> | --all] [--deep] [--json-out[=path]]`: search a session, the project or every project by phrase, file, tool or kind; each hit says why it matched
- `scripts/agent-recall-axi search <phrase> [--regex] [--file <pattern>] [--tool <name>] [--kind <a,b>] [--since <span>] [--from <when>] [--to <when>] [--project <p> | --all] [--limit <n>] [--json-out[=path]]`: have I dealt with this before? what the human and the agent said, and the calls made, across every project, by session

### setup

- `scripts/agent-recall-axi hook install [--scope user|project] [--agent claude|codex|opencode] | hook status [--scope user|project] | hook uninstall [--scope user|project]`: opt-in SessionStart hook (Claude Code, Codex, OpenCode): the sessions at session start, a resume pack after a compaction
- `scripts/agent-recall-axi cache status [--full] | cache clear [--project <p> | --all]`: the disposable derived cache: where it is, what is indexed, how to clear it
- `scripts/agent-recall-axi update [--check]`: how to update this tool (print-only; never contacts a registry)

<!-- END GENERATED: command-reference -->
