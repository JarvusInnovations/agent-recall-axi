---
status: done
done: 2026-11-09
depends: [axi-conformance]
specs:
  - specs/cli.md
pr: 30
---

# Plan: `sessions` defaults to four columns

## Scope

The AXI catalog maintainer's review of v0.1.1 (kunchenguid/axi#266) noted that `sessions` printed five
default columns, one over principle 2's 3–4 guideline. Rather than record a P2 exception, drop `started`
from the default: `last` already orders and dates the listing, so `started` is the least load-bearing
column. It remains available on request. **In:** the `sessions` default schema. **Out:** the home view
(already four columns) and the `--subagents` extras, which are opt-in.

## Implements

- `specs/cli.md` § sessions: default `sessions[N]{id,last,turns,title}`; `started` becomes the first
  extra field.

## Approach

`sessionRow` no longer emits `started` by default; `--fields started` adds it through the same
extra-field switch as the others. `SESSIONS_FIELDS` gains `started`, so `--help`, the generated skill
and field validation all pick it up from one place. The committed bundle is rebuilt.

## Validation

- [x] Unit: `sessions` prints `{id,last,turns,title}` and no `started`; `--fields started` appends it
      as `MM-DD HH:MM`; `--subagents` and other `--fields` schemas shift accordingly.
- [x] check, check:skill, check:bundle and check:scrub pass, and CI is green.
