# plans

Plans are the work DAG (motion). Specs in `specs/` describe state; plans describe how we get there
next. Each plan declares scope, the specs it implements, dependencies, and concrete validation
criteria. Once merged, a plan freezes as historical record.

Protocol: `.agents/skills/specops/references/plans-protocol.md` (frontmatter, body template,
lifecycle, closeout commit, Follow-ups taxonomy).

No hand-drawn DAG or status table here; it would rot. Query the frontmatter:

```sh
.agents/skills/specops/scripts/specops next     # what is ready to start
.agents/skills/specops/scripts/specops dag      # Mermaid graph by status
```

## Initial plan set (bootstrap batch)

The first DAG, authored together with the initial specs on the draft planning PR and merged
`planned` so it can be drained in order:

| slug | scope | depends |
| --- | --- | --- |
| `reader-and-event-model` | fixtures, streaming reader, Claude Code adapter, scope, CLI harness, `sessions`/`events`/`tail` first light | — |
| `ids-and-show` | id grammar + resolution, `show`/`zoom`, truncation, pointer following, id-stability tests | reader-and-event-model |
| `find` | single-session `find` with why-labels and context, `--file`/`--tool`/`--kind`, `--deep` | ids-and-show |
| `pan` | `around`/`next`/`prev`, offset cache, edge hints | ids-and-show |
| `views` | `turns`, `human`, `tools`, `compactions`, windows and `--window` | pan |
| `sessions-and-recall` | session stats + titles, home view, cross-session `find`, term index, `recall` | find, views |
| `resume-pack-library` | `buildResumePack`, `resume-pack`, library exports and `render` subpath | views |
| `skill-and-hook` | esbuild bundle + shim, SKILL.md generation, drift gates, `hook`, hook mode | sessions-and-recall, resume-pack-library |
| `first-publish` | release workflows, manual first npm publish, trusted publishing, install docs | skill-and-hook |
