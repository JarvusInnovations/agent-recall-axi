/**
 * Shadows the SDK's self-updater so this tool never contacts a registry (specs/cli.md#update,
 * specs/behaviors/privacy.md). Print-only; the channel is inferred from the entrypoint path.
 */
import { realpathSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { VERSION } from "../version.js";
import { findCommand } from "../reference.js";
import { parseFlags } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { renderDocument } from "../output/render.js";
import { BIN } from "./common.js";

const SKILL_LINE = "Run `npx skills update agent-session-axi` to update the skill bundle";
const NPM_LINE = "Run `npm i -g agent-session-axi@latest` if installed from npm";

export function installChannel(entrypoint: string | undefined): "skill" | "npm" {
  if (!entrypoint) return "npm";
  let path = entrypoint;
  try {
    path = realpathSync(entrypoint);
  } catch {
    // keep the path as given
  }
  return /(^|[\\/])skills[\\/]/.test(path) ? "skill" : "npm";
}

export async function updateCommand(args: string[], entrypoint: string | undefined): Promise<string> {
  const p = parseFlags("update", args, findCommand("update")?.flags ?? []);
  if (p.help) return renderCommandHelp("update") ?? "";
  if (p.positionals.length) throw new AxiError(`update takes no arguments (got ${p.positionals[0]})`, "USAGE", [`usage: ${BIN} update [--check]`]);
  const channel = installChannel(entrypoint);
  const help = channel === "skill" ? [SKILL_LINE, NPM_LINE] : [NPM_LINE, SKILL_LINE];
  return renderDocument({ update: `${BIN} ${VERSION} (${channel} install)` }, help);
}
