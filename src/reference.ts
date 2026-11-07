/**
 * The one description of the command surface. The home view's help, every `--help`
 * block and the generated SKILL.md region derive from this (specs/architecture.md).
 * Commands are listed here as the specs define them; until a plan lands one, its
 * handler reports NOT_IMPLEMENTED so `--help` stays honest without lying about state.
 */
export const DESCRIPTION =
  "Read, search and pan/zoom through agent session logs (Claude Code first); TOON out, local files only";

export interface CommandDoc {
  usage: string;
  summary: string;
  flags?: string[];
  examples?: string[];
}

export interface CommandGroup {
  group: string;
  commands: CommandDoc[];
}

// Skeleton: populated per plan (specs/cli.md is the source of each entry).
export const COMMAND_GROUPS: CommandGroup[] = [];
