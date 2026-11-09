/**
 * Splice the command reference generated from COMMAND_GROUPS (src/reference.ts) into
 * skills/agent-session-axi/SKILL.md between its markers (specs/architecture.md#the-skill-bundle).
 * The prose outside the markers is hand-written and never touched.
 *
 *   bun scripts/build-skill.ts            # rewrite the generated region (bun run build:skill)
 *   bun scripts/build-skill.ts --check    # fail if SKILL.md is stale (bun run check:skill)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_GROUPS, type CommandGroup } from "../src/reference.js";

export const SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "agent-session-axi", "SKILL.md");
/** How SKILL.md invokes the tool: the shim, relative to the skill's own directory. */
export const SKILL_INVOCATION = "scripts/agent-session-axi";
export const REGION = "command-reference";

export function commandReference(groups: CommandGroup[] = COMMAND_GROUPS): string {
  return groups
    .map((g) => {
      const items = g.commands.map((c) => {
        const planned = c.status === "available" ? "" : ` (planned: ${c.status.planned})`;
        return `- \`${SKILL_INVOCATION} ${c.usage}\`: ${c.summary}${planned}`;
      });
      return `### ${g.group}\n\n${items.join("\n")}`;
    })
    .join("\n\n");
}

/** The document with its generated region replaced; throws when the markers are missing. */
export function spliceSkill(doc: string, reference: string = commandReference()): string {
  const begin = `<!-- BEGIN GENERATED: ${REGION} -->`;
  const end = `<!-- END GENERATED: ${REGION} -->`;
  const a = doc.indexOf(begin);
  const b = doc.indexOf(end);
  if (a === -1 || b === -1 || b < a || doc.indexOf(begin, a + 1) !== -1 || doc.indexOf(end, b + 1) !== -1) {
    throw new Error(`SKILL.md must hold exactly one ${begin} … ${end} region`);
  }
  return `${doc.slice(0, a)}${begin}\n\n${reference.trim()}\n\n${doc.slice(b)}`;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const rel = relative(process.cwd(), SKILL_MD);
  const src = readFileSync(SKILL_MD, "utf8");
  const out = spliceSkill(src);
  if (check) {
    if (src !== out) {
      console.error(`${rel} is out of date; run \`bun run build:skill\` and commit the result`);
      process.exit(1);
    }
    console.log(`${rel} is up to date`);
  } else if (src !== out) {
    writeFileSync(SKILL_MD, out);
    console.log(`Updated the generated region of ${rel}`);
  } else {
    console.log(`${rel} already up to date`);
  }
}
