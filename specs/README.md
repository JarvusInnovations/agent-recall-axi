# agent-session-axi specs

These specs declare the **desired state** of `agent-session-axi`: what must be true of the tool, not
a description of what happens to be built. The spec leads; the code conforms. The workflow is the
`specops` skill (`.agents/skills/specops`); plans that bring code to these specs live in `plans/`.

The bootstrapping record (why the tool exists, what the owner asked for, what the logs look like)
is issue #1 in this repository. These specs supersede it where they differ, and `data-model.md`
records the facts about Claude Code logs that the issue got wrong or incomplete.

## Layout

```
specs/
  README.md            this file
  principles.md        the decisive rules: row format is the product, human text is verbatim,
                       stable ids, pan and zoom, reads only, adapters
  architecture.md      TypeScript + bun + axi-sdk-js; library + CLI; adapters; ids; streaming;
                       cache; build and distribution (npm bin + committed skill bundle); hook; CI
  data-model.md        the normalized model: Project, Session, Entry, Event (kinds, authority),
                       Turn, Window, Pointer, ResumePack; the id grammar
  cli.md               every command: usage, default schema, flags, caps, empty states, hints
  api.md               the library surface another program calls
  behaviors/
    row-format.md      the one row shape, columns, text by kind, headers and footers
    id-stability.md    why ids never move, how resolution fails, rewritten-file detection
    authority.md       H / C / D classes, verbatim guarantee, misclassification bias
    truncation.md      caps, marks, --full, pointer following
    context-windows.md compaction windows, --window, cold-start keying
    privacy.md         local files only, no network, cache rules
    time-and-scope.md  --from/--to/--since grammar, --before/--after counts, project scope
    errors.md          codes, exit codes, what is not an error
```

## Conventions

- A command spec states its invocation, default TOON schema, flags with defaults, caps, empty
  state, error cases and `help[]` hints. Cross-cutting rules live once in `behaviors/` and are
  linked, not restated.
- Every spec may carry a `## Principles` section: **Inherited** (linked `principles.md` entries
  that bite here) and **Local** (rules owned by that spec; promote when they spread).
- Output examples show *shape*. The session id `7a2f1c3e`, paths like `src/auth/callback.ts` and
  hosts like `example.test` are synthetic. This repository is public: no real session content,
  names, hosts or paths appear in specs, fixtures, plans, issues or PRs.
- Vocabulary: *entry* (a file line), *event* (a row), *kind*, *authority*, *turn*, *window*,
  *pointer*, *sidecar*, *silent entry*. Commands use plain verbs; these words appear in docs and
  `--help` only.

## Plans

`plans/` is the work DAG. See `plans/README.md`.
