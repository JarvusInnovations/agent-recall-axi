# Behavior: Authority labeling

## Rule

Every event belongs to exactly one authority class, derived from its kind, and the tool makes the
class visible wherever a consumer might weigh one event against another. Human text is printed
verbatim; the tool never produces a summary of anything.

## Applies To

Every command that prints events; `resume-pack` in particular.

## Details

### Classes

| class | meaning | kinds |
| --- | --- | --- |
| `H` | what the human said: the record of intent | `human`, `human.queued`, `human.slash`, `human.answer` |
| `D` | data about what happened, produced by tools or the harness | `result`, `compaction`, `hook`, `skill`, `notice`, `notice.task` |
| `C` | the agent's own claims and derived text | `assistant`, `thinking`, `call`, `summary` |

A `call` is `C` because it records what the agent *asked* to happen; its linked `result` is the `D`
that says what did. A compaction `summary` is `C`: it was written by a model, so it is a claim about
the past, not the past.

### Where the class shows

- Rows carry `kind`, which implies the class; `--fields authority` adds the letter as a column.
- `human` prints only `H` events and says so in its header (`authority: H (verbatim)`).
- `resume-pack` labels each layer with its class and prints `H` first.
- `show` prints `authority:` on every event.
- `find` results across classes are not reordered by class; file order rules.

### Verbatim guarantee

For `H` events: the text printed by `human`, `resume-pack` and `show` is byte-identical to the
stored text after the adapter strips harness wrappers it can prove are not the human's
(`<system-reminder>` envelopes around queued messages, `<command-*>` tags around slash commands).
Listing rows cut a head and mark the cut; they never rewrite. `show` never cuts `H` text (its
4,000-char cap applies to `C`/`D` text only, `behaviors/truncation.md#caps`). No command
paraphrases, merges, deduplicates or reorders `H` events.

"Byte-identical" is about content, not the output encoding: a text printed as a TOON quoted
string (`"line one\nline two"`) decodes to exactly the stored bytes. Encoding is not rewriting.

### Misclassification bias

When an adapter cannot prove injected text is not the human's, it files it as `human`
(`data-model.md#kinds`). A false `H` is visible and correctable; a false `D` hides intent.

## Principles

**Inherited:**
- [Human messages are the highest-authority record](../principles.md#human-messages-are-the-highest-authority-record-and-the-tool-never-summarizes-them).
- [Session transcripts are the true full-resolution memory](../principles.md#session-transcripts-are-the-true-full-resolution-memory) — a summary (`C`) is a view onto them, not a replacement.
