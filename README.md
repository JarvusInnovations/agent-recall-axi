# agent-session-axi

Read, search and pan/zoom through AI agent session logs from the terminal, with token-efficient
[TOON](https://toonformat.dev) output for the agents that read them. Claude Code's
`~/.claude/projects/**/*.jsonl` is the first supported format; the reader is an event model with
adapters, so another agent's logs are a new adapter file, not a rewrite. An
[AXI](https://github.com/kunchenguid/axi) tool by Jarvus Innovations. MIT.

**It reads local files only and sends nothing.** Session logs hold everything a human typed; this
tool never opens a network connection with their content, never modifies a log, and writes only
its own disposable cache under `~/.cache/agent-session-axi/`, plus, only when you run
`agent-session-axi hook install`, the agent settings files that command names (`hook uninstall`
reverts it).

## Why

Agents that run for days need to read their own and each other's sessions: after a context
compaction, to resume exactly where they were; from a supervising session, to audit what a bot did
and why; from a human's assistant, to answer "what did I ask for and when". Session transcripts are
the true full-resolution memory. This tool is how an agent remembers.

## Status

Early, and not yet published. The desired state is fully specified in [`specs/`](specs/README.md)
and the work to build it is the plan DAG in [`plans/`](plans/README.md). Every command below runs
today; `agent-session-axi --help` lists them.

## Shape

```
sessions                      which sessions exist                       (zoomed out)
turns <session>               one row per human prompt
events | tail | around | next | prev        rows with stable ids          (pan)
show <id>                     one entry, whole; --full follows persisted outputs   (zoom)
find [<session>] <phrase> --file <glob> --tool <name> --kind human …     (many ways in)
recall <phrase>               "have I dealt with this before?" across every project
human <session>               what the human said, verbatim
resume-pack <session>         the cold-start block: human text, last tool calls, last claims
```

Every row carries an id like `7a2f1c3e:418` that stays valid for the life of the file, and every
listing ends with the exact command to move backward, forward or inward.

## Install

Two ways to get the same tool; you need only one. (Neither is published yet: the first release
is [`plans/first-publish.md`](plans/first-publish.md).)

- **Skill**, works offline: `npx skills add JarvusInnovations/agent-session-axi`. The skill
  carries a committed, self-contained bundle (`skills/agent-session-axi/scripts/agent-session-axi.mjs`,
  every dependency inlined) and a bash shim beside it, so it runs with `node` 22+ and nothing
  else: no registry, no install step. The shim is not on `PATH`; agents run it by its path
  (`<skill dir>/scripts/agent-session-axi <command>`), and the tool's own hints name that path.
- **npm**: `npm i -g agent-session-axi` or `npx -y agent-session-axi …`

Optional ambient context: `agent-session-axi hook install` registers a SessionStart hook (Claude
Code, Codex, OpenCode; `--scope project` for one repository, `--agent` for one agent) that shows
the project's sessions at session start and a resume pack after a compaction or resume.
`hook status` shows where it is installed; `hook uninstall` removes only this tool's entries.
Nothing else ever installs a hook.

### Building the skill bundle

The bundle and the command reference in `SKILL.md` are generated and committed; CI fails when
either is stale.

```
bun run build:bundle   # esbuild bin/ and src/ into the skill bundle (check:bundle to verify)
bun run build:skill    # regenerate SKILL.md's command reference from src/reference.ts (check:skill)
```

## Contributing

Spec-driven (`specops`): change `specs/` first, then bring code into conformance through a plan in
`plans/`. This repository is public: fixtures are synthetic and no real session content may land
anywhere in it. Bootstrapping notes are in issue #1.
