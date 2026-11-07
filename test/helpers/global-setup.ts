import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The bin-level tests (fast path, network, smoke) run the compiled output; build it once. */
export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  execFileSync("npm", ["run", "--silent", "build"], { cwd: root, stdio: "inherit" });
}
