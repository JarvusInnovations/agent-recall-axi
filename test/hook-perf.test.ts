/**
 * Wall-clock bounds for the home view's stdin read (specs/cli.md#home-view-no-arguments): the
 * bin, given a pipe nobody writes to or a partial payload whose writer stays open, returns within
 * the read's bounds (200 ms to the first byte, 1 s after it) plus its own start-up.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FIXTURE_ROOT } from "./fixtures/build.js";
import { BIN_JS, CACHE_HOME } from "./helpers/run.js";

const node = process.execPath.includes("bun") ? "node" : process.execPath;
const SLACK = process.env.CI ? 2 : 1;
const cwd = mkdtempSync(join(tmpdir(), "asa-hook-perf-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function timed(write?: string, end = false): Promise<{ ms: number; code: number | null }> {
  return new Promise((resolveRun, reject) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(node, [BIN_JS], { cwd, env: { PATH: process.env.PATH, HOME: cwd, CLAUDE_CONFIG_DIR: FIXTURE_ROOT, TZ: "UTC", XDG_CACHE_HOME: CACHE_HOME }, stdio: ["pipe", "ignore", "ignore"] });
    if (write !== undefined) child.stdin.write(write);
    if (end) child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => {
      child.stdin.destroy();
      resolveRun({ ms: Number(process.hrtime.bigint() - t0) / 1e6, code });
    });
  });
}

describe("home view stdin bounds", () => {
  it("a held-open silent pipe costs at most the first-byte bound", async () => {
    const closed = await timed(undefined, true);
    const silent = await timed();
    expect(silent.code).toBe(0);
    expect(silent.ms).toBeLessThan(closed.ms + (200 + 300) * SLACK);
  });

  it("a partial payload with an open writer costs at most the total bound", async () => {
    const closed = await timed(undefined, true);
    const partial = await timed('{"session_id":"a6000006-0000-4000-8000-000000000000","sour');
    expect(partial.code).toBe(0);
    expect(partial.ms).toBeLessThan(closed.ms + (1000 + 300) * SLACK);
  });
});
