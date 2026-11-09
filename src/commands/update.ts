/**
 * Shadows the SDK's self-updater so this tool never contacts a registry (specs/cli.md#update,
 * specs/behaviors/privacy.md). Print-only; the channel is inferred from the entrypoint path.
 */
import { AxiError } from "axi-sdk-js";
import { VERSION } from "../version.js";
import { findCommand } from "../reference.js";
import { parseFlags } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { renderDocument } from "../output/render.js";
import { BIN } from "./common.js";
import { bundleShim, NAME } from "../invocation.js";

const SKILL_LINE = "Run `npx skills update agent-recall-axi` to update the skill bundle";
const NPM_LINE = "Run `npm i -g agent-recall-axi@latest` if installed from npm";

/** Run from the skill bundle → a skill install, decided as the hints decide it (cli.md#update). */
export function installChannel(entrypoint: string | undefined): "skill" | "npm" {
  return bundleShim(entrypoint) ? "skill" : "npm";
}

export async function updateCommand(args: string[], entrypoint: string | undefined): Promise<string> {
  const p = parseFlags("update", args, findCommand("update")?.flags ?? []);
  if (p.help) return renderCommandHelp("update") ?? "";
  if (p.positionals.length) throw new AxiError(`update takes no arguments (got ${p.positionals[0]})`, "USAGE", [`usage: ${BIN} update [--check]`]);
  const channel = installChannel(entrypoint);
  const help = channel === "skill" ? [SKILL_LINE, NPM_LINE] : [NPM_LINE, SKILL_LINE];
  return renderDocument({ update: `${NAME} ${VERSION} (${channel} install)` }, help);
}
