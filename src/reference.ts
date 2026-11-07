/**
 * The one description of the command surface. The home view's help, every `--help` block and
 * (later) the generated SKILL.md region derive from this (specs/architecture.md). Every command
 * the specs define is listed; one a plan has not landed yet is marked `planned` so `--help` is
 * honest about what runs today. Leaf module: types and data only.
 */
export const DESCRIPTION =
  "Read, search and pan/zoom through agent session logs (Claude Code first); TOON out, local files only";

export type FlagValue = "string" | "number" | "boolean";

export interface FlagSpec {
  /** Without leading dashes. */
  name: string;
  value: FlagValue;
  /** Shown in --help, e.g. `<n>`. */
  arg?: string;
  describe: string;
  default?: string;
  /** Declared by the spec but not built yet: the plan that brings it. */
  planned?: string;
}

export interface CommandDoc {
  name: string;
  usage: string;
  summary: string;
  /** `available` runs today; `planned` names the plan that brings it. */
  status: "available" | { planned: string };
  args?: string[];
  flags?: FlagSpec[];
  examples?: string[];
  alias?: string;
}

export interface CommandGroup {
  group: string;
  commands: CommandDoc[];
}

/** Accepted on every command. */
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "tz", value: "string", arg: "<iana>", describe: "time zone for parsing and rendering", default: "TZ, else the system zone" },
];

const SESSION_ARG = "<session>: path to a session .jsonl (ids, prefixes and `latest` arrive with plan ids-and-show)";

const LIMIT = (d: string): FlagSpec => ({ name: "limit", value: "number", arg: "<n>", describe: "rows to show; 0 = no cap", default: d });
const KIND: FlagSpec = {
  name: "kind",
  value: "string",
  arg: "<a,b|all>",
  describe: "kinds to show (replaces the default set)",
  default: "all but thinking,result",
};
const HEAD: FlagSpec = { name: "head", value: "number", arg: "<n>", describe: "row text head length", default: "200" };
const FULL: FlagSpec = { name: "full", value: "boolean", describe: "lift the head cap and the row cap" };
const FROM: FlagSpec = { name: "from", value: "string", arg: "<when|id>", describe: "inclusive start: a time or an event id" };
const TO: FlagSpec = { name: "to", value: "string", arg: "<when|id>", describe: "exclusive end: a time or an event id" };
const SINCE: FlagSpec = { name: "since", value: "string", arg: "<span>", describe: "shorthand for --from now-<span> (90m, 24h, 7d, 2w)" };
const WINDOW: FlagSpec = { name: "window", value: "string", arg: "<k|last|all>", describe: "one compaction window", planned: "views" };
const FIELDS_PLANNED: FlagSpec = { name: "fields", value: "string", arg: "<a,b>", describe: "extra columns", planned: "ids-and-show" };
const JSON_OUT: FlagSpec = { name: "json-out", value: "string", arg: "[=path]", describe: "write the uncapped result as JSON", planned: "sessions-and-recall" };
const PROJECT: FlagSpec = { name: "project", value: "string", arg: "<p>", describe: "a project path, encoded dir name, or unique cwd substring" };
const ALL: FlagSpec = { name: "all", value: "boolean", describe: "every project under the log root" };

export const SESSIONS_FIELDS = ["uuid", "path", "project", "bytes", "kind", "parent"] as const;

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    group: "zoomed out",
    commands: [
      {
        name: "sessions",
        usage: "sessions [--project <p> | --all] [--since <span>] [--from <when>] [--to <when>] [--limit <n>] [--subagents] [--fields <a,b>]",
        summary: "sessions in scope, most recently active first",
        status: "available",
        flags: [
          PROJECT,
          ALL,
          SINCE,
          { name: "from", value: "string", arg: "<when>", describe: "sessions last active at or after this time" },
          { name: "to", value: "string", arg: "<when>", describe: "sessions last active before this time" },
          LIMIT("20"),
          { name: "subagents", value: "boolean", describe: "include subagent sessions (adds kind, parent)" },
          { name: "fields", value: "string", arg: "<a,b>", describe: `extra columns: ${SESSIONS_FIELDS.join(", ")}` },
          JSON_OUT,
        ],
        examples: ["sessions", "sessions --since 7d", "sessions --all --limit 50 --fields path"],
      },
      {
        name: "turns",
        usage: "turns <session> [--from <when|id>] [--to <when|id>] [--window <k|last>] [--limit <n>]",
        summary: "one row per human prompt",
        status: { planned: "views" },
      },
    ],
  },
  {
    group: "pan",
    commands: [
      {
        name: "events",
        usage: "events <session> [--from <when|id>] [--to <when|id>] [--since <span>] [--kind <a,b|all>] [--limit <n>] [--head <n>] [--full]",
        summary: "rows of a session in file order; newest last unless --from is given",
        status: "available",
        args: [SESSION_ARG],
        flags: [FROM, TO, SINCE, KIND, LIMIT("40"), HEAD, FULL, WINDOW, FIELDS_PLANNED, JSON_OUT],
        examples: [
          "events ./7a2f1c3e-0000-4000-8000-000000000001.jsonl",
          "events ./7a2f1c3e-0000-4000-8000-000000000001.jsonl --kind all --limit 0",
          "events ./7a2f1c3e-0000-4000-8000-000000000001.jsonl --from 7a2f1c3e:418 --limit 20",
        ],
      },
      {
        name: "tail",
        usage: "tail <session> [<n>] [--limit <n>] [--kind <a,b|all>] [--head <n>] [--full]",
        summary: "the last n visible rows (default 20): what was I doing",
        status: "available",
        args: [SESSION_ARG, "<n>: same as --limit"],
        flags: [LIMIT("20"), KIND, HEAD, FULL],
        examples: ["tail ./7a2f1c3e-0000-4000-8000-000000000001.jsonl", "tail ./7a2f1c3e-0000-4000-8000-000000000001.jsonl 5 --kind all"],
      },
      { name: "around", usage: "around <id> [--before <n>] [--after <n>]", summary: "rows on both sides of an id", status: { planned: "pan" } },
      { name: "next", usage: "next <id> [<n>]", summary: "the n visible rows after an id", status: { planned: "pan" } },
      { name: "prev", usage: "prev <id> [<n>]", summary: "the n visible rows before an id", status: { planned: "pan" } },
    ],
  },
  {
    group: "zoom",
    commands: [
      { name: "show", usage: "show <id> [--full] [--raw]", summary: "one entry or event, whole (alias: zoom)", status: { planned: "ids-and-show" } },
      { name: "zoom", usage: "zoom <id> [--full] [--raw]", summary: "alias of show", status: { planned: "ids-and-show" }, alias: "show" },
    ],
  },
  {
    group: "views",
    commands: [
      { name: "human", usage: "human <session> [--window <k|last>] [--budget <chars>]", summary: "every human message, verbatim", status: { planned: "views" } },
      { name: "tools", usage: "tools <session> [--name <tool>] [--file <pattern>] [--errors]", summary: "tool calls with results folded in", status: { planned: "views" } },
      { name: "compactions", usage: "compactions <session> [--full]", summary: "where the context window closed", status: { planned: "views" } },
      { name: "resume-pack", usage: "resume-pack <session> [--window <k|last>] [--budget <chars>]", summary: "the cold-start block", status: { planned: "resume-pack-library" } },
    ],
  },
  {
    group: "search",
    commands: [
      { name: "find", usage: "find [<session>] [<phrase>] [--file <pattern>] [--tool <name>] [--kind <a,b>]", summary: "search one session, the project, or everything", status: { planned: "find" } },
      { name: "recall", usage: "recall <phrase> [--since <span>]", summary: "have I dealt with this before? across every project", status: { planned: "sessions-and-recall" } },
    ],
  },
  {
    group: "setup",
    commands: [
      { name: "hook", usage: "hook install|status|uninstall [--scope user|project]", summary: "opt-in SessionStart hook", status: { planned: "skill-and-hook" } },
      { name: "cache", usage: "cache status | cache clear", summary: "the disposable derived cache", status: { planned: "pan" } },
      {
        name: "update",
        usage: "update [--check]",
        summary: "how to update this tool (print-only; never contacts a registry)",
        status: "available",
        flags: [{ name: "check", value: "boolean", describe: "accepted; prints the same text" }],
        examples: ["update"],
      },
    ],
  },
];

export function findCommand(name: string): CommandDoc | undefined {
  for (const g of COMMAND_GROUPS) for (const c of g.commands) if (c.name === name) return c;
  return undefined;
}
