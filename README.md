# agent-session-axi

Read, search and pan/zoom through AI agent session logs from the terminal, with token-efficient
[TOON](https://toonformat.dev) output for the agents that read them. Claude Code's
`~/.claude/projects/**/*.jsonl` is the first supported format; the reader is an event model with
adapters, so another agent's logs are a new adapter file, not a rewrite. An
[AXI](https://github.com/kunchenguid/axi) tool by Jarvus Innovations. MIT.

**Privacy: reads local files only; sends nothing.** Session logs hold everything a human typed;
this tool never opens a network connection, never modifies a log, and writes only its own
disposable cache under `~/.cache/agent-session-axi/`, plus, only when you run
`agent-session-axi hook install`, the agent settings files that command names (`hook uninstall`
reverts it). The rule is [`specs/behaviors/privacy.md`](specs/behaviors/privacy.md).

Agents that run for days need to read their own and each other's sessions: after a context
compaction, to resume where they were; from a supervising session, to audit what a bot did and
why; from a human's assistant, to answer "what did I ask for and when". The transcript is the
full-resolution memory, and this tool reads it in small, cited pieces.

## Install

Two channels ship the same tool from the same tag; you need only one.

**npm**, for interactive use (Node 22 or newer):

```sh
npm i -g agent-session-axi          # puts agent-session-axi on PATH
npx -y agent-session-axi --version  # or run it without installing
```

**Skill**, for agents and bots, and it works offline:

```sh
npx skills add JarvusInnovations/agent-session-axi        # this project (-g for every project)
```

The skill directory holds `SKILL.md` and `scripts/`: a committed, self-contained bundle
(`agent-session-axi.mjs`, every dependency inlined) and a bash shim beside it. It needs `node` 22
or newer and nothing else: no registry, no `npm install`, no `node_modules`, so a bot on a host
that cannot reach npm at cold start still has its memory. The shim is not on `PATH`; run it by
its path, for example `~/.claude/skills/agent-session-axi/scripts/agent-session-axi tail latest`,
and the tool's own hints name that same path. `SKILL.md` tells the agent when to reach for it.
The bundle reports the release it was cut from (`--version`); between releases, a bundle on the
default branch reports a development version such as `0.0.0-g1a2b3c4`.

## The zoom ladder

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

Every row carries an id like `7a2f1c3e:418` (session prefix, line) that stays valid for the life
of the file, and every listing ends with the exact command to move backward, forward or inward.
Going down the ladder for one session:

```sh
agent-session-axi sessions                   # this project's sessions, newest first
agent-session-axi turns 7a2f1c3e             # one row per human prompt in that session
agent-session-axi tail 7a2f1c3e              # its last rows
agent-session-axi around 7a2f1c3e:418        # the rows on either side of one entry
agent-session-axi show 7a2f1c3e:418 --full   # that entry whole, persisted output included
```

A `<session>` is a path, a uuid, an 8+ character prefix, or `latest`. After a compaction,
`agent-session-axi resume-pack latest` is the one command to run. `agent-session-axi --help`
lists every command, and `<command> --help` its flags.

## The session hook

`agent-session-axi hook install` registers a SessionStart hook for Claude Code, Codex and
OpenCode (`--scope project` for one repository, `--agent` for one agent). At session start it
shows the project's sessions; after a compaction or a resume it prints a resume pack.
`hook status` shows where it is installed and `hook uninstall` removes only this tool's entries.
Nothing else ever installs a hook. Details: [`specs/cli.md#hook`](specs/cli.md#hook).

## Specs and development

The desired state is specified in [`specs/`](specs/README.md): start with
[`principles.md`](specs/principles.md), then [`cli.md`](specs/cli.md) (every command),
[`api.md`](specs/api.md) (the library), [`data-model.md`](specs/data-model.md) and
[`architecture.md`](specs/architecture.md). Work to reach it is the plan DAG in
[`plans/`](plans/README.md). The project is spec-driven (`specops`): change `specs/` first, then
bring the code into conformance through a plan.

```sh
bun install
bun run check && bun run build && bun run test
bun run build:bundle   # regenerate the committed skill bundle (check:bundle verifies it)
bun run build:skill    # regenerate SKILL.md's command reference (check:skill verifies it)
bun run check:scrub    # the public-repo scrub gate
```

CI fails when the bundle or `SKILL.md` is stale. Releases: [`RELEASING.md`](RELEASING.md).

This repository is public: fixtures are synthetic, and no real session content, names, hosts or
home paths may land anywhere in it; the scrub gate enforces the mechanical part.
