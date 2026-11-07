---
status: planned
depends: [views]
specs:
  - specs/api.md
  - specs/cli.md
  - specs/data-model.md
  - specs/behaviors/authority.md
  - specs/behaviors/context-windows.md
issues: [1]
---

# Plan: Resume pack and the library surface

## Scope

`buildResumePack` with the budget policy, the `resume-pack` command, the `agent-session-axi/render`
subpath (`renderResumePack`), and conformance of the package's public exports to `specs/api.md`
(every function listed exists, is typed, and is covered by a test that imports from the package
entry, not from `src/`).

## Implements

- `specs/data-model.md#resume-pack` — layers, order, budget policy.
- `specs/cli.md#resume-pack-session`.
- `specs/api.md` — `buildResumePack`, `ResumePack`, `renderResumePack`, module export list,
  `AgentSessionError`, `parseWhen`/`parseSpan` exposure, `exports` map in `package.json`.
- `specs/behaviors/authority.md` — layer labels; `H` first and verbatim.
- `specs/behaviors/context-windows.md` — default `--window last`, summary as a `C` layer.

## Approach

1. `src/lib/resume.ts`: collect window → `summary`, `human[]`, last `--tools` calls, last
   `--claims` assistant texts; budget: measure rendered size, shrink claims → tools → oldest human
   (never below the newest human), record `omitted`/`continueTo`.
2. `src/render/resume.ts` + `exports["./render"]`: the CLI's exact TOON for a pack, used by the
   command so CLI and library cannot diverge.
3. `src/lib/index.ts`: export audit test generated from the list in `api.md` (parse the spec's
   `import { … }` block in the test, assert each name is exported).
4. `commands/resume-pack.ts`: flags, header (`window:`, `budget:`), footers.

## Validation

- [ ] `resume-pack <compaction-fixture>` prints `summary`, `human[n]`, `tools[10]`, `claims[3]` in
      that order with authority comments; human texts byte-equal the fixture source strings.
- [ ] `--window 0` on the same fixture omits `summary` and uses window 0's messages.
- [ ] `--budget 2000` shrinks claims first, then tools, then older human messages; the newest
      human message is always present; `omitted:` and `continueTo` are correct (running `human
      --to <continueTo>` yields the omitted ones).
- [ ] `--tools 3 --claims 1` respected; a session with no assistant text prints `claims[0]`.
- [ ] Determinism: two runs byte-identical; the library result deep-equals across runs.
- [ ] Import test: `import { buildResumePack, … } from "agent-session-axi"` resolves every name in
      `api.md`; `import { renderResumePack } from "agent-session-axi/render"` renders bytes equal
      to the CLI's output for the same fixture and options.
- [ ] The library never writes to stdout: a test runs every exported function with `stdout`
      captured and asserts it stayed empty.
- [ ] `AgentSessionError` codes map one-to-one to the CLI's `AxiError` codes (table test).

## Risks / unknowns

- **Budget measured in characters vs tokens** — characters are deterministic and cheap; the kit
  can pass a smaller budget if it needs headroom. Documented in `api.md`.
- **Consumer expectations** — the kit may want extra layers (files touched). Add as opt-in fields
  later; the four layers are the contract now.

## Notes

(at closeout)

## Follow-ups

(at closeout)
