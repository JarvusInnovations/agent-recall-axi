/**
 * The home view's budget (specs/cli.md#home-view-no-arguments): under 300 ms on a project with 100
 * sessions, never a whole-file pass, even when the latest session is large.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCwd } from "../src/lib/adapters/claude-code/sessions.js";
import { buildLarge, manySessions } from "./fixtures/build.js";
import { BIN_JS } from "./helpers/run.js";

const node = process.execPath.includes("bun") ? "node" : process.execPath;
const SLACK = process.env.CI ? 2 : 1;
const tmp = mkdtempSync(join(tmpdir(), "asa-home-perf-"));
const root = join(tmp, "claude");
const env = { ...process.env, TZ: "UTC", CLAUDE_CONFIG_DIR: root, XDG_CACHE_HOME: join(tmp, "cache") };
/** Two projects: 100 small sessions; and 99 small ones whose latest is a 64 MB session. */
const small = join(tmp, "work", "small");
const big = join(tmp, "work", "big");

async function project(cwd: string, withBig: boolean): Promise<void> {
  const dir = join(root, "projects", encodeCwd(cwd));
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });
  for (const f of manySessions(withBig ? 99 : 100)) {
    const path = join(dir, f.rel.split("/").pop()!);
    writeFileSync(path, f.text.replaceAll('"cwd":"/src/widget"', `"cwd":${JSON.stringify(cwd)}`));
    utimesSync(path, new Date(f.mtime!), new Date(f.mtime!));
  }
  if (withBig) await buildLarge(join(dir, "f0000099-0000-4000-8000-000000000000.jsonl"), 64 * 1024 * 1024);
}

beforeAll(async () => {
  await project(small, false);
  await project(big, true);
}, 300_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
process.once("exit", () => rmSync(tmp, { recursive: true, force: true }));

const cli = (args: string[], cwd: string) => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(node, [BIN_JS, ...args], { encoding: "utf8", env, cwd });
  return { ...r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
};
/** Best of five: a slow run on a shared machine is scheduling, not the tool. */
const best = (args: string[], cwd: string, status = 0) => {
  const runs = [0, 1, 2, 3, 4].map(() => cli(args, cwd));
  for (const r of runs) expect(r.status, r.stdout).toBe(status);
  return { ms: Math.min(...runs.map((r) => r.ms)), stdout: runs[0]!.stdout };
};

describe("home view on 100 sessions", () => {
  /**
   * 300 ms (×2 on CI), or within 100 ms of this host's floor when that is slower. The floor loads the
   * same command graph and resolves the time zone (the first Intl call, which every command pays),
   * then stops at a scope that has no logs: `sessions --project <missing>` (NO_SESSIONS, exit 1).
   */
  const budget = (cwd: string) => Math.max(300 * SLACK, best(["sessions", "--project", join(tmp, "missing")], cwd, 1).ms + 100);

  it("completes in budget on 100 small sessions with nothing cached", () => {
    const home = best([], small);
    expect(home.stdout).toMatch(/^project: .* \(100 sessions\)$/m);
    expect(home.stdout).toMatch(/^latest: dd000063$/m);
    expect(home.ms).toBeLessThan(budget(small));
  }, 120_000);

  it("completes in under 300 ms (×2 on CI) when the latest session is 64 MB and nothing is cached: no whole-file read or count", () => {
    const home = best([], big);
    expect(home.stdout).toMatch(/^latest: f0000099$/m);
    // Cold, the cache cannot number the line: no id, and no count of 64 MB of newlines.
    expect(home.stdout).toMatch(/^last_human: "?(\d\d-\d\d )?\d\d:\d\d:\d\d /m);
    expect(home.ms).toBeLessThan(budget(big));
  }, 120_000);

  it("completes in budget when the latest session is 64 MB and the cache knows it (no whole-file read)", () => {
    expect(cli(["sessions"], big).status).toBe(0); // the stats pass, once
    const home = best([], big);
    expect(home.stdout).toMatch(/^latest: f0000099$/m);
    expect(home.stdout).toMatch(/^last_human: "f0000099:\d+ /m);
    expect(home.ms).toBeLessThan(budget(big));
  }, 300_000);
});
