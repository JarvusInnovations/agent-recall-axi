import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli.js";
import { FIXTURE_ROOT, fixtureIndex } from "../fixtures/build.js";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN_JS = join(REPO, "dist", "bin", "agent-session-axi.js");
export const NOW = new Date("2026-11-07T14:00:00.000Z");

const index = fixtureIndex();

/** Tests never touch the real cache: every run gets this process's own cache root. */
export const CACHE_HOME = mkdtempSync(join(tmpdir(), "asa-cache-"));
/** Absolute path of a named fixture's log file. */
export function fx(name: string): string {
  const rel = index[name];
  if (!rel) throw new Error(`no fixture ${name}`);
  return join(FIXTURE_ROOT, rel);
}

export interface RunResult {
  stdout: string;
  exitCode: number;
}

/** Run the CLI in-process against the fixture root. */
export async function run(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; now?: Date; entrypoint?: string } = {},
): Promise<RunResult> {
  let stdout = "";
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(args, {
      stdout: { write: (c: string) => (stdout += c) },
      cwd: opts.cwd ?? "/src/widget",
      env: { CLAUDE_CONFIG_DIR: FIXTURE_ROOT, TZ: "UTC", XDG_CACHE_HOME: CACHE_HOME, ...opts.env },
      now: opts.now ?? NOW,
      ...(opts.entrypoint ? { entrypoint: opts.entrypoint } : {}),
    });
    const code = typeof process.exitCode === "number" ? process.exitCode : 0;
    return { stdout, exitCode: code };
  } finally {
    process.exitCode = saved;
  }
}
