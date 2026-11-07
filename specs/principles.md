# Principles

The project's philosophy, written down as principles. Each is decisive: it picks a side of a
trade-off and rules something out. Feature specs reference the ones that bite on them from their
own `## Principles` sections (`principles.md#<anchor>`).

## The row format is the product

Every listing in this tool prints the same compact row: an id, a time, a kind, and a head of text.
Agents learn one shape and read it everywhere: `turns`, `events`, `find`, `around`, `tail`,
`tools`. A command that needs a different shape is suspect; prefer adding a column over inventing a
layout. Token cost per row is a design input: a column that most rows leave empty, or that rarely
changes an agent's next decision, does not earn a place in the default schema. The full shape is
`specs/data-model.md`; its exact rendering rules are `specs/behaviors/row-format.md`.

## Session transcripts are the true full-resolution memory

Session logs are the only complete record of what an agent was asked, did, and said. Summaries,
titles, outlines and resume packs are derived views; the log is the source. The tool therefore
never hides data it cannot show again: anything dropped from a default view is reachable by id
(`show`), by flag (`--full`, `--kind`), or by pointer (persisted outputs). "Not in the row" is a
rendering choice, never a loss.

## Human messages are the highest-authority record, and the tool never summarizes them

What the human typed is the record of intent. The tool prints human text verbatim: it may cut a
head for a listing row (and says so, with the size), but it never paraphrases, merges, cleans up,
or reorders human messages, and `human` and `resume-pack` print them whole. Assistant text is the
agent's own claims about what it did; tool results are data about what happened. Every row says
which of the three it is, so a consumer can weigh it. See `specs/behaviors/authority.md`.

## Stable ids: an id printed once is valid for the life of the file

An entry id names a position in an append-only file, so it never moves. An agent can paste an id
from a listing hours earlier, after the session has grown by thousands of lines, and `show` returns
the same entry. Ids are never renumbered, never shortened dynamically (git-style shortest-unique
prefixes change as the set grows), and never depend on filters: the id of a row is the same whether
it was reached through `find`, `tail`, or `around`. See `specs/behaviors/id-stability.md`.

## Pan and zoom, not dump

The tool is built for fluid, incremental exploration. Every result is a vantage point, not a
terminus: rows carry ids, listings end with the exact next command to move backward, forward, or
inward, and a hit arrives with its surroundings. The zoom ladder is `sessions` → `turns` →
`events`/`around`/`next`/`prev`/`tail` → `show` → `show --full`. Dumping a whole session is possible
(`events --full --limit 0`) but is never a default, and no command silently loads a whole file into
the agent's context.

## Many ways in

Agents arrive with different handles on a memory: a phrase, a file they touched, a tool they ran,
a time, a role, a session. `find` accepts all of them, in combination, and every hit row says *why*
it matched. There is no single "right" search; the tool meets the agent where its recollection is.

## Common verbs on commands, concept words in docs

Command names are the plain verbs and nouns an agent would guess (`find`, `show`, `around`, `next`,
`prev`, `tail`, `sessions`, `turns`, `tools`, `human`). Concept words (entry, event, block,
sidechain, compaction, authority) live in the specs and `--help`, not in the command grammar. One
alias is permitted when the owner's vocabulary differs from the common verb (`zoom` → `show`); it
is documented as an alias and never grows its own behavior.

## Reads only, never sends

The tool reads local files and writes nothing but its own cache. It never sends log content
anywhere, never opens a network connection, never modifies a session file, and never writes next to
the logs it reads. Any future "share" or "sync" feature is a different tool. See
`specs/behaviors/privacy.md`.

## An event model with adapters, Claude Code first

The library normalizes every log format into one event model (`specs/data-model.md`); commands,
ids and the row format are written against that model, never against Claude Code's JSON. Claude
Code's `~/.claude/projects/**/*.jsonl` is the first and only adapter in the initial plan set, but a
second agent's logs must be a new adapter file, not a rewrite. Adapter-specific fields are kept in
`raw` for `show --raw`, not promoted into the model.

## File order is the truth; timestamps are evidence

Entries are ordered by their position in the file, which is the order the writer appended them.
Timestamps are carried on every row and used for `--since`/`--until` filtering and display, but
they are not monotonic in Claude Code logs (attachments and assistant entries are regularly written
out of time order), so they never determine sequence or ids.

## Deterministic output for the same file

Given the same file bytes and the same arguments, every command prints the same bytes (relative
times excepted, and only in the `sessions` listing and the home view). No model calls, no
heuristics that depend on the clock, no randomness. This is what lets another program (the ops kit's
cold-start pack) call the library and trust the result.

## Library first, CLI on top

Every command is a thin rendering of a library function another program can call with the same
arguments and get the same data as structured objects (`specs/api.md`). Logic that exists only in a
command handler is a bug.
