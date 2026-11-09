// Leaf module: node builtins only, so bin/ can answer --version before loading the CLI graph.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "0.0.0";
}

/** Stamped by scripts/build-cli.ts into the skill bundle, which has no package.json beside it. */
declare const __AGENT_RECALL_AXI_VERSION__: string | undefined;

export const VERSION = typeof __AGENT_RECALL_AXI_VERSION__ === "string" ? __AGENT_RECALL_AXI_VERSION__ : readVersion();
