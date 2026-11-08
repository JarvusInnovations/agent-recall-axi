---
status: done
pr: 14
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

- [x] `resume-pack <compaction-fixture>` prints `summary`, `human[n]`, `tools[10]`, `claims[3]` in
      that order with each layer's authority class labeled (the `layers:` header line, since TOON
      has no comments); human texts byte-equal the fixture source strings.
- [x] `--window 0` on the same fixture omits `summary` and uses window 0's messages.
- [x] `--budget 2000` shrinks claims first, then tools, then older human messages; the newest
      human message is always present; `omitted:` and `continueTo` are correct (running `human
      --window <k> --to <continueTo>` yields the omitted ones).
- [x] `--tools 3 --claims 1` respected; a session with no assistant text prints `claims[0]`.
- [x] Determinism: two runs byte-identical; the library result deep-equals across runs.
- [x] Import test: `import { buildResumePack, … } from "agent-session-axi"` resolves every name in
      `api.md` (a name owned by a plan still open, such as `recall` from
      [`sessions-and-recall`](sessions-and-recall.md), is exempt only while that plan is not
      `done`, so the test fails if it closes without the export); `import { renderResumePack } from "agent-session-axi/render"` renders bytes equal
      to the CLI's output for the same fixture and options.
- [x] The library never writes to stdout: a test runs every exported function with `stdout`
      captured and asserts it stayed empty.
- [x] `AgentSessionError` codes map one-to-one to the CLI's `AxiError` codes (table test).
- [x] `tail <session>` prints a `resume-pack <session>` footer that runs as printed, including for
      a shared `<s8>` and a path session (from [`pan`](pan.md)).

## Risks / unknowns

- **Budget measured in characters vs tokens** — characters are deterministic and cheap; the kit
  can pass a smaller budget if it needs headroom. Documented in `api.md`.
- **Consumer expectations** — the kit may want extra layers (files touched). Add as opt-in fields
  later; the four layers are the contract now.

## Notes

Spec readings this plan settled, in the leading `docs(specs): resume-pack readings for the
budget, layer labels and render subpath` commit and the follow-up semicolon commit; the
Validation wording was amended to match in its own `chore(plans)` commit before the code:

- **The budget bounds the rendered pack** (the first pass counted only text, tool and target
  chars; the review round's ruling replaced that, see below). The library still emits no TOON:
  `src/output/resume-layout.ts`, a TOON-free leaf next to the renderer, charges each event its
  encoded bytes. That is the UTF-8 length of its printed text as a JSON string (the summary
  cut at 4,000 with the house marker; a target cut as its row prints it) plus its id and a
  per-event layout constant. The three layer key lines are a fixed charge (`LAYER_KEYS`). The
  printed layers take at most `budget.used` bytes.
- **Drops go one event at a time**: the oldest claim, then the oldest call once no claim is
  left, then the oldest human message but the newest, then the opening summary, which leaves a
  one-line `summary: "dropped to meet the budget; show <id> --full"` note. The newest human
  message is never dropped. The kept human messages are the
  longest suffix that fits, the same as `budgetCut`.
- **Layer order is summary, human, tools, claims** (`cli.md`). `data-model.md`'s table and
  `authority.md`'s "prints H first" were brought into line.
- **TOON has no comments**: a `# C — …` annotation as in the old example breaks decoding. The
  classes ride on one header line,
  `layers: summary C; human H (verbatim); tools C (results D); claims C`.
  It uses semicolons because the encoder quotes a comma-separated value.
- **Header**: `session`, `window: <k> (last; windows 0..<n>)` (or `only window 0`), `budget`,
  `layers`, `day`/`days`, `tz`, then `omitted:` last. All layers share one time column.
- **The omitted continuation carries `--window <k> --budget 0`**: the resolved index (never
  `last`), and no budget, so `human` prints every omitted message (without them, it would read
  the whole file, or cut the omitted set at its own 12,000). TOON quotes the `omitted:` value
  because it holds a `:`; the spec examples now show the quoted form.
- **Flags**: `--window` takes an index or `last` (`all` and `k..` are `VALIDATION_ERROR`, since
  a pack is one window), and a window past the last names that grammar and the range;
  `--budget` is a non-negative integer, with `0` meaning no budget, as in `human`
  (`budget: <used> used (no limit)`); `--tools`/`--claims` are non-negative integers. The
  library validates the same before opening any file.
- **Empty layers** print `tools[0]:`, `claims[0]:` and `human[0]:`. The encoder writes an empty
  array as `tools: []`, so the tools layer is hand-written when empty.
- **One read**: `buildResumePack` reads the window once through `heldEvents`, keeping `H`,
  `call` and `assistant`. A test checks that its `human`/`summary` equal `humanMessages` and its
  `tools` equal `toolCalls` for each window.
- **Render subpath**: `src/output/resume.ts` holds the renderer (output stays the only TOON
  module). `src/render/index.ts` re-exports it, and `exports["./render"]` points at the built
  file. Options: `tz`, `ref`, `showCarry`, `carry`, `notice`. The CLI passes its own hint
  naming, so `renderResumePack` with the same options prints the CLI's bytes, minus the trailing
  newline the SDK adds.
- **Package self-reference** works both in vitest and in plain Node, so `test/api.test.ts`
  imports `agent-session-axi` and `agent-session-axi/render` as a consumer would. They resolve
  to `dist/`, which the vitest global setup builds. The export audit parses `api.md`'s module
  block and its signature lines; type names are checked against `dist/src/lib/index.d.ts`. One
  catch: `dist`'s `AgentSessionError` is a different class from `src`'s, so the error-mapping
  test feeds the CLI's `formatError` errors built from `src`, and compares the two
  `ERROR_CODES` lists.
- **No-output check**: every function export must have an argument entry and must not throw.
  Async iterables are drained. `process.stdout/stderr.write` and
  `console.log/error/warn/info/debug` are all captured. Mutations (a `process.stdout.write`,
  then a `console.error`, in `buildResumePack`) made it fail.
- **Consumer type check**: `test/consumer/consumer.ts` imports only the package entry and the
  `render` subpath, and uses every exported name with `api.md`'s signature.
  `bun run check:types` compiles it with NodeNext resolution against `dist/`, and CI runs it
  after the build. Removing `dist/src/render/index.d.ts` made it fail. It found one existing
  mismatch: `events()` takes no `limit`/`newestLast` (#15). The name audit now requires the
  `type`/`export interface|type|class` qualifier.
- **`tail`'s footer** gains `resume-pack <session>`, deferred from `pan`. A test runs it as
  printed for an `<s8>`, a shared `<s8>` (full uuid), a path, and `--all --tz`.
- **Review round** (PR #14). The rulings went into `docs(specs): resume-pack review rulings`
  and two small follow-ups (the layout module's name; the fixed lines past the newest message),
  ahead of the fixes. `test/resume-review.test.ts` has one test per finding, and all 7 failed
  against the pre-fix source.
  1. **The budget bounds rendered bytes.** 600 short messages at `--budget 6000` used to print
     44.6k; they now print under 6k of layers. A property test runs five sessions (control
     characters, quotes, backslashes, long messages, a long summary) at budgets from 1 to 50k.
     It asserts layers ≤ `used`, `used` ≤ budget (unless only the newest message is left), and
     output ≤ budget + header + footer + newest message + the fixed lines. It also checks that
     `budget:` prints the counted cost.
  2. The tools layer is labeled `tools C (results D)`.
  3. A window past the last uses resume-pack's own grammar.
  4. + 8. `budget: 0` means no budget, and the continuation carries `--budget 0`. The test has
     more than 12,000 omitted chars.
  5. The specs show the quoted `omitted:` form.
  6. The no-output check now covers stderr too, and every listed export must run without
     throwing.
  7. The consumer type check, compiled against `dist/`.
  `oneLine`/`targetCut` moved from `render.ts` to `truncate.ts` (re-exported, so importers are
  unchanged) so the cost of a tools row matches its printed cut.
- **Evidence (after the review round)**: `bun run check`, `bun run build` and
  `bun run check:types` are clean. `bun run test` was run twice in full:
  - Both runs: 281/282. Each had the same one perf failure, the `pan` plan's cold table build
    on the 200 MB file (4.54 s, then 5.62 s, against 4 s), at load average 15–17 on 8 cores.
    That test does not exercise this plan's code.
  - The perf project alone, right after: 11/11.
- **Evidence (first pass)**: 273/274, then 274/274; the one miss was the same perf bound.
- The header still says `(title pending)`, as every command does today (deferred below).

## Follow-ups

- Deferred to [`sessions-and-recall`](sessions-and-recall.md): the `resume-pack` header's
  `(title pending)` gets the session title, and `recall`, `RecallResult`, `sessionStats` and
  `findAcross` get exported, and join `test/consumer/consumer.ts` with their spec'd signatures.
  `test/api.test.ts` exempts those names only while that plan is not `done`.
- Issue [#15](https://github.com/JarvusInnovations/agent-session-axi/issues/15): `events()`
  takes no `limit`/`newestLast`, unlike `api.md`'s `ListOpts`.
- Tracked as: [`skill-and-hook`](skill-and-hook.md) builds hook mode on `buildResumePack` +
  `renderResumePack`, or on `resumePackCommand([<session>, "--budget", "6000"], io)`.
