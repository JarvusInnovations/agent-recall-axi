import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLarge } from "./fixtures/build.js";
import { BIN_JS } from "./helpers/run.js";

const node = process.execPath.includes("bun") ? "node" : process.execPath;
// Wall-clock bounds get headroom on shared CI runners; the RSS bound does not.
const SLACK = process.env.CI ? 2 : 1;
const tmp = mkdtempSync(join(tmpdir(), "asa-large-"));
const big = join(tmp, "f0000099-0000-4000-8000-000000000000.jsonl");
const rss = join(tmp, "rss.mjs");

beforeAll(async () => {
  await buildLarge(big, 200 * 1024 * 1024);
  writeFileSync(rss, 'process.on("exit", () => process.stderr.write(`MAXRSS_KB ${process.resourceUsage().maxRSS}\\n`));\n');
}, 300_000);
// The 200 MB file never outlives the run, even when generation or the test failed.
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
process.once("exit", () => rmSync(tmp, { recursive: true, force: true }));

describe("streaming on a 200 MB session", () => {
  it("tail completes under 2 s (×2 on CI) with peak RSS under 150 MB", () => {
    expect(statSync(big).size).toBeGreaterThanOrEqual(200 * 1024 * 1024);
    spawnSync(node, [BIN_JS, "tail", big], { encoding: "utf8" }); // warm the page cache
    const t0 = process.hrtime.bigint();
    const r = spawnSync(node, ["--import", rss, BIN_JS, "tail", big], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tail[20]{id,t,kind,text}:");
    const kb = Number(/MAXRSS_KB (\d+)/.exec(r.stderr)![1]);
    expect(kb / 1024).toBeLessThan(150);
    expect(ms).toBeLessThan(2000 * SLACK);
  }, 120_000);
});
