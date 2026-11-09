import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_ROOT } from "./fixtures/build.js";
import { BIN_JS, CACHE_HOME, REPO } from "./helpers/run.js";

const node = process.execPath.includes("bun") ? "node" : process.execPath;
// Wall-clock bounds get headroom on shared CI runners.
const SLACK = process.env.CI ? 2 : 1;
const helper = (name: string) => join(REPO, "test", "helpers", name);

function runBin(args: string[], nodeArgs: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(node, [...nodeArgs, BIN_JS, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: FIXTURE_ROOT, TZ: "UTC", XDG_CACHE_HOME: CACHE_HOME, ...env },
    cwd: REPO,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function timeIt(cmd: string[], n = 7): number {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(node, cmd, { encoding: "utf8" });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(times);
}

describe("built bin", () => {
  it("--version prints the bare version without loading the command graph", () => {
    const { version } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string };
    for (const flag of ["--version", "-v", "-V"]) {
      const r = runBin([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${version}\n`);
    }
    const traced = runBin(["--version"], ["--import", helper("trace-loads.mjs")]);
    const loaded = JSON.parse(/LOADED (.*)/.exec(traced.stderr)![1]!) as string[];
    expect(loaded.some((u) => u.endsWith("/src/version.js"))).toBe(true);
    expect(loaded.some((u) => u.endsWith("/src/cli.js"))).toBe(false);
    expect(loaded.some((u) => u.includes("axi-sdk-js/dist/index.js"))).toBe(false);
    // and the full CLI does load it, so the check can fail
    const full = runBin(["--help"], ["--import", helper("trace-loads.mjs")]);
    expect(JSON.parse(/LOADED (.*)/.exec(full.stderr)![1]!).some((u: string) => u.endsWith("/src/cli.js"))).toBe(true);
  });

  it("--version runs within 3× the node -e floor (×2 on CI)", () => {
    timeIt(["-e", "console.log(1)"], 2); // warm the file cache
    timeIt([BIN_JS, "--version"], 2);
    const floor = timeIt(["-e", "console.log(1)"]);
    const version = timeIt([BIN_JS, "--version"]);
    expect(version).toBeLessThan(floor * 3 * SLACK);
  });

  it("update and update --check work with the network blocked", () => {
    for (const args of [["update"], ["update", "--check"]]) {
      const r = runBin(args, ["--import", helper("block-network.mjs")]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^update: agent-session-axi /m);
      expect(r.stdout).toContain("npx skills update agent-session-axi");
      expect(r.stdout).toContain("npm i -g agent-session-axi@latest");
      expect(/NETWORK_ATTEMPTS (.*)/.exec(r.stderr)![1]).toBe("[]");
    }
    const help = runBin(["--help"]);
    expect(help.stdout).not.toContain("built-in");
  });

  it("smoke: sessions --project /nonexistent → exit 1, NO_SESSIONS, no stack trace", () => {
    const r = runBin(["sessions", "--project", "/nonexistent"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^code: NO_SESSIONS$/m);
    expect(r.stdout + r.stderr).not.toMatch(/\n\s+at /);
  });
});
