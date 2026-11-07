/** `--help` text, top level and per command, rendered from src/reference.ts. */
import { COMMAND_GROUPS, DESCRIPTION, GLOBAL_FLAGS, findCommand, type CommandDoc, type FlagSpec } from "../reference.js";

const BIN = "agent-session-axi";

function statusNote(c: CommandDoc): string {
  return c.status === "available" ? "" : ` (planned: ${c.status.planned})`;
}

export function renderTopLevelHelp(): string {
  const groups = COMMAND_GROUPS.map(
    (g) => `${g.group}:\n${g.commands.map((c) => `  ${c.usage}${statusNote(c)}\n      ${c.summary}`).join("\n")}`,
  ).join("\n\n");
  return [
    `${BIN} — ${DESCRIPTION}`,
    "",
    `usage: ${BIN} <command> [args] [flags]   (no command: the current project's sessions)`,
    "",
    groups,
    "",
    "global flags: --tz <iana>, --help, -v/--version",
    `Run \`${BIN} <command> --help\` for a command's flags and examples`,
    "",
  ].join("\n");
}

function flagLine(f: FlagSpec): string {
  const name = `--${f.name}${f.arg ? (f.arg.startsWith("[") ? f.arg : ` ${f.arg}`) : ""}`;
  const extra = [f.default ? `default ${f.default}` : "", f.planned ? `planned: ${f.planned}` : ""].filter(Boolean).join("; ");
  return `  ${name}  ${f.describe}${extra ? ` (${extra})` : ""}`;
}

export function renderCommandHelp(name: string): string | undefined {
  const c = findCommand(name);
  if (!c) return undefined;
  const lines = [`command: ${c.name}`, `usage: ${BIN} ${c.usage}`, `summary: ${c.summary}`];
  if (c.alias) lines.push(`alias of: ${c.alias}`);
  if (c.status !== "available") {
    lines.push(`status: planned (plan ${c.status.planned}); not available in this version`);
    return `${lines.join("\n")}\n`;
  }
  if (c.args?.length) lines.push("args:", ...c.args.map((a) => `  ${a}`));
  const flags = [...(c.flags ?? []), ...GLOBAL_FLAGS];
  lines.push("flags:", ...flags.map(flagLine), "  --help  this text");
  if (c.examples?.length) lines.push("examples:", ...c.examples.map((e) => `  ${BIN} ${e}`));
  return `${lines.join("\n")}\n`;
}
