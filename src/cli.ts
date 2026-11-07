import { AxiError, runAxiCli } from "axi-sdk-js";
import { COMMAND_GROUPS, DESCRIPTION } from "./reference.js";
import { VERSION } from "./version.js";

// Skeleton wiring only: commands arrive with their plans (plans/*.md). The shape of
// this file (runAxiCli options, formatError, exported main) is the contract in
// specs/architecture.md.

const USAGE_CODES = new Set(["USAGE", "UNKNOWN_FLAG", "VALIDATION_ERROR"]);

export function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    const exitCode = USAGE_CODES.has(error.code) ? 2 : 1;
    const help = error.suggestions.length
      ? `\nhelp[${error.suggestions.length}]:\n${error.suggestions.map((s) => `  ${s}`).join("\n")}`
      : "";
    return { output: `error: ${error.message}\ncode: ${error.code}${help}\n`, exitCode };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `error: unexpected failure: ${message}\ncode: INTERNAL_ERROR\nhelp[1]:\n  Re-run with --debug for details on stderr\n`,
    exitCode: 1,
  };
}

function renderTopLevelHelp(): string {
  const groups = COMMAND_GROUPS.map(
    (g) => `${g.group}:\n${g.commands.map((c) => `  ${c.usage}\n      ${c.summary}`).join("\n")}`,
  ).join("\n\n");
  return `agent-session-axi — ${DESCRIPTION}\n\nusage: agent-session-axi <command> [args] [flags]\n\n${groups}\n`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: renderTopLevelHelp(),
    home: async () => ({
      status: "not implemented yet — see specs/ and plans/ in the repository",
      help: ["Run `agent-session-axi --help` for the planned command list"],
    }),
    commands: {
      // Shadows the SDK's registry-querying built-in: this tool never opens a socket.
      update: async () => ({
        update: `agent-session-axi ${VERSION}`,
        help: [
          "Run `npx skills update agent-session-axi` to update the skill bundle",
          "Run `npm i -g agent-session-axi@latest` if installed from npm",
        ],
      }),
    },
    formatError,
  });
}
