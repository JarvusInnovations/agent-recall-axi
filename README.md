# agent-session-axi

Read, search and pan/zoom through AI agent session logs from the terminal, with token-efficient
[TOON](https://toonformat.dev) output for the agents that read them. Claude Code's
`~/.claude/projects/**/*.jsonl` is the first supported format; the reader is an event model with
adapters, so another agent's logs are a new adapter file, not a rewrite. An
[AXI](https://github.com/kunchenguid/axi) tool by Jarvus Innovations. MIT.

**It reads local files only and sends nothing.** Session logs hold everything a human typed; this
tool never opens a network connection with their content, never modifies a log, and writes only
its own disposable cache under `~/.cache/agent-session-axi/`.

## Why

Agents that run for days need to read their own and each other's sessions: after a context
compaction, to resume exactly where they were; from a supervising session, to audit what a bot did
and why; from a human's assistant, to answer "what did I ask for and when". Session transcripts are
the true full-resolution memory. This tool is how an agent remembers.

## Status

Early. The desired state is fully specified in [`specs/`](specs/README.md) and the work to build
it is the plan DAG in [`plans/`](plans/README.md). Today `sessions`, `events`, `tail`, `show`,
`find` (within one session), the home
view and the Claude Code reader work; the rest of the shape below is planned, and
`agent-session-axi --help` marks each command with the plan that brings it.

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

## Install (planned)

Two paths, pick one:

- npm: `npm i -g agent-session-axi` or `npx -y agent-session-axi …`
- skill, works offline: `npx skills add JarvusInnovations/agent-session-axi`

Optional ambient context: `agent-session-axi hook install` registers a SessionStart hook (Claude
Code, Codex, OpenCode) that shows the project's sessions at session start and a resume pack after
a compaction.

## Contributing

Spec-driven (`specops`): change `specs/` first, then bring code into conformance through a plan in
`plans/`. This repository is public: fixtures are synthetic and no real session content may land
anywhere in it. Bootstrapping notes are in issue #1.
