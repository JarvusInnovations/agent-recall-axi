# Behavior: Time, position and scope

## Rule

One grammar for "when", one for "where in the session", and one for "which sessions", shared by
every command that takes them.

## Applies To

Every command with `--from`, `--to`, `--since`, `--before`, `--after`, `--project`, `--all`,
`--tz`, or a `<session>` argument.

## Details

### When: `--from <when>`, `--to <when>`, `--since <span>`

- Ranges are half-open: `[--from, --to)`. A date-only value means the start of that local day; as
  `--to` it means the start of the day *after*, so `--from 2026-04-20 --to 2026-04-20` is all of
  April 20.
- `<when>` is an ISO-8601 instant (`2026-04-20T14:00`, optional zone), a date (`2026-04-20`), or a
  token: `now`, `today`, `yesterday`, `+Nd`/`-Nd`, `+Nw`/`-Nw` (day precision), `+Nh`/`-Nh`,
  `+Nm`/`-Nm` (instant precision).
- `--since <span>` is shorthand for `--from now-<span>`: spans are `90m`, `24h`, `7d`, `2w`.
- `--tz <iana>` is the one global flag, accepted on every command, and sets the zone for parsing
  and rendering; default `TZ`, else the system zone. The header echoes the resolved zone.
- An event id is also accepted where a `<when>` is: it means that event's timestamp. The resolver
  tries the id grammar first (`<s8>:<seq>`), then the time grammar.

### Where in the session: `--before <n>`, `--after <n>`, `--context <n>`

- These are **counts of events**, never times. `--before 5 --after 10` around an anchor;
  `--context 3` sets both. Default context for `find` is 1; for `around` 5 and 5.
- Counting is over *visible* events (the kinds the listing shows), so `--after 10` yields 10 rows,
  not 10 lines.
- `events --from <id> --to <id>` selects by position when given ids (inclusive start, exclusive
  end), by time when given `<when>` values.

### Which sessions: `<session>`, `--project`, `--all`

- The default scope is the current project: the log directory whose `cwd` equals the working
  directory (or an ancestor, nearest first). With no such directory, session-resolving commands
  fail with `code: NO_SESSIONS` and a hint to pass `--project` or `--all`.
- `--project <value>` widens the scope to one project: a filesystem path (resolved to its log
  directory), an encoded directory name, or a substring that matches exactly one project's `cwd`
  (ambiguity lists the candidates).
- `--all` scopes to every project under the log root. `recall` defaults to `--all`.
- `<session>` resolves per `data-model.md#session-reference`; a literal path ignores scope.
- Subagent sessions are in scope for id resolution always, and in listings only with
  `--subagents`.

## Principles

**Inherited:**
- [Many ways in](../principles.md#many-ways-in) — time, position and scope are three of the ways.
- [File order is the truth; timestamps are evidence](../principles.md#file-order-is-the-truth-timestamps-are-evidence) — time filters select, position orders.
