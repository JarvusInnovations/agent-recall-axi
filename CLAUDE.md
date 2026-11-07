# agent-session-axi

An AXI tool (agent-facing CLI + library) that reads AI agent session logs. Spec-driven: `specs/`
is the desired state, `plans/` the work DAG; load the `specops` skill (`.agents/skills/specops`)
before changing either, and the `axi` skill before touching output.

**This repo is PUBLIC.** No real session content, people, hosts, client or project names, home
paths with usernames, or ids copied from real logs may appear anywhere in it — specs, fixtures,
tests, plans, issues, PR bodies, commit messages. Fixtures are synthetic (`test/fixtures/build.ts`).

The tool reads local files only and never sends anything (`specs/behaviors/privacy.md`).
