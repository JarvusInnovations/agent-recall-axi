---
status: in-progress
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
5. `tail`'s footer gains `resume-pack <session>` (cli.md#tail-session), named the way its other
   hints name the session (deferred from [`pan`](pan.md), which shipped `prev <first-id>` only
   because the command did not exist yet).

## Validation

- [ ] `resume-pack <compaction-fixture>` prints `summary`, `human[n]`, `tools[10]`, `claims[3]` in
      that order with each layer's authority class labeled (the `layers:` header line, since TOON
      has no comments); human texts byte-equal the fixture source strings.
- [ ] `--window 0` on the same fixture omits `summary` and uses window 0's messages.
- [ ] `--budget 2000` shrinks claims first, then tools, then older human messages; the newest
      human message is always present; `omitted:` and `continueTo` are correct (running `human
      --window <k> --to <continueTo>` yields the omitted ones).
- [ ] `--tools 3 --claims 1` respected; a session with no assistant text prints `claims[0]`.
- [ ] Determinism: two runs byte-identical; the library result deep-equals across runs.
- [ ] Import test: `import { buildResumePack, … } from "agent-session-axi"` resolves every name in
      `api.md` (a name owned by a plan still open, such as `recall` from
      [`sessions-and-recall`](sessions-and-recall.md), is exempt only while that plan is not
      `done`, so the test fails if it closes without the export); `import { renderResumePack } from "agent-session-axi/render"` renders bytes equal
      to the CLI's output for the same fixture and options.
- [ ] The library never writes to stdout: a test runs every exported function with `stdout`
      captured and asserts it stayed empty.
- [ ] `AgentSessionError` codes map one-to-one to the CLI's `AxiError` codes (table test).
- [ ] `tail <session>` prints a `resume-pack <session>` footer that runs as printed, including for
      a shared `<s8>` and a path session (from [`pan`](pan.md)).

## Risks / unknowns

- **Budget measured in characters vs tokens** — characters are deterministic and cheap; the kit
  can pass a smaller budget if it needs headroom. Documented in `api.md`.
- **Consumer expectations** — the kit may want extra layers (files touched). Add as opt-in fields
  later; the four layers are the contract now.

## Notes

(at closeout)

## Follow-ups

(at closeout)
