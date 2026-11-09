import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The bin-level tests (fast path, network, smoke) run the compiled output; build it once. Every
 * test process inherits a throwaway XDG_CACHE_HOME, so no test can write the real cache.
 */
export default function setup(): () => void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  execFileSync("npm", ["run", "--silent", "build"], { cwd: root, stdio: "inherit" });
  const cache = mkdtempSync(join(tmpdir(), "asa-cache-global-"));
  process.env.XDG_CACHE_HOME = cache;
  return () => rmSync(cache, { recursive: true, force: true });
}
