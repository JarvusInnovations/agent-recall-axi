import { encode } from "@toon-format/toon";
import { AxiError, runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { AgentSessionError } from "./lib/errors.js";
import { COMMAND_GROUPS, DESCRIPTION } from "./reference.js";
import { VERSION } from "./version.js";
import { renderCommandHelp, renderTopLevelHelp } from "./output/help.js";
import { renderHelp } from "./output/render.js";
import { BIN, type Io } from "./commands/common.js";
import { usageLine } from "./flags.js";
import { eventsCommand, tailCommand } from "./commands/events.js";
import { homeCommand } from "./commands/home.js";
import { sessionsCommand } from "./commands/sessions.js";
import { updateCommand } from "./commands/update.js";

const USAGE_CODES = new Set(["USAGE", "UNKNOWN_FLAG", "VALIDATION_ERROR"]);

let debug = false;

/** errors.md: TOON on stdout, exit 2 for usage, 1 otherwise; stacks only to stderr with --debug. */
export function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError || error instanceof AgentSessionError) {
    const exitCode = USAGE_CODES.has(error.code) ? 2 : 1;
    const parts = [encode({ error: error.message, code: error.code })];
    const details = error instanceof AgentSessionError ? error.details : undefined;
    if (details && Object.keys(details).length) parts.push(encode({ details }));
    const help = renderHelp(error.suggestions);
    if (help) parts.push(help);
    return { output: `${parts.join("\n")}\n`, exitCode };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (debug && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  return {
    output: `${encode({ error: `unexpected failure: ${message}`, code: "INTERNAL_ERROR" })}\n${renderHelp([
      "Re-run with --debug for details on stderr",
      "File an issue at https://github.com/JarvusInnovations/agent-session-axi/issues",
    ])}\n`,
    exitCode: 1,
  };
}

export interface MainIo {
  stdout?: { write: (chunk: string) => unknown };
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  /** The entrypoint path used to infer the install channel; default process.argv[1]. */
  entrypoint?: string;
}

function planned(name: string, plan: string): AxiCliCommand<undefined> {
  return () => {
    throw new AxiError(`\`${name}\` is not available yet in ${VERSION} (planned: ${plan})`, "USAGE", [
      usageLine(name),
      `Run \`${BIN} --help\` for the commands available now`,
    ]);
  };
}

export async function main(argv: string[] = process.argv.slice(2), io: MainIo = {}): Promise<void> {
  // --debug is a diagnostic switch for stderr, not a command flag; strip it before dispatch.
  debug = argv.includes("--debug");
  const args = argv.filter((a) => a !== "--debug");
  const ctx: Io = { cwd: io.cwd ?? process.cwd(), env: io.env ?? process.env, now: io.now ?? new Date() };

  const commands: Record<string, AxiCliCommand<undefined>> = {};
  for (const g of COMMAND_GROUPS) {
    for (const c of g.commands) if (c.status !== "available") commands[c.name] = planned(c.name, c.status.planned);
  }
  commands.sessions = (a) => sessionsCommand(a, ctx);
  commands.events = (a) => eventsCommand(a, ctx);
  commands.tail = (a) => tailCommand(a, ctx);
  // Shadows the SDK's registry-querying built-in: this tool never opens a socket.
  commands.update = (a) => updateCommand(a, io.entrypoint ?? process.argv[1]);

  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv: args,
    topLevelHelp: renderTopLevelHelp(),
    home: () => homeCommand(ctx),
    commands,
    getCommandHelp: (name) => renderCommandHelp(name),
    formatError,
    ...(io.stdout ? { stdout: io.stdout } : {}),
  });
}
