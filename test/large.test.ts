import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLarge } from "./fixtures/build.js";
import { countNewlines, readLinesBackward } from "../src/lib/reader.js";
import { openSession } from "../src/lib/index.js";
import { show, showFromStart } from "../src/lib/events.js";
import { BIN_JS, CACHE_HOME } from "./helpers/run.js";

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
    const r = spawnSync(node, ["--import", rss, BIN_JS, "tail", big], { encoding: "utf8", env: { ...process.env, TZ: "UTC", XDG_CACHE_HOME: CACHE_HOME } });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tail[20]{id,t,kind,text}:");
    // No offset table for this file yet: the honest fallback (plan pan keeps it).
    expect(r.stdout).toMatch(/^count: 20 \(newest; earlier rows exist\)$/m);
    const kb = Number(/MAXRSS_KB (\d+)/.exec(r.stderr)![1]);
    expect(kb / 1024).toBeLessThan(150);
    expect(ms).toBeLessThan(2000 * SLACK);
  }, 120_000);
});

describe("backward reader on a very long line", () => {
  it("joins an 8 MB line read in 2 KB blocks once, not per block", async () => {
    const path = join(tmp, "long-line.jsonl");
    const longLine = "x".repeat(8 << 20);
    writeFileSync(path, `a\n${longLine}\nb\n`);
    const t0 = process.hrtime.bigint();
    const lines: string[] = [];
    for await (const l of readLinesBackward(path, 2048)) lines.push(l.text.length > 16 ? `len ${l.text.length}` : l.text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(lines).toEqual(["b", `len ${longLine.length}`, "a"]);
    // Re-concatenating the carry per block made this ~8 s; one join is a few hundred ms.
    expect(ms).toBeLessThan(2000 * SLACK);
  });
});

describe("the offset table on a 200 MB session (plan pan)", () => {
  const cacheHome = join(tmp, "pan-cache");
  const env = { ...process.env, TZ: "UTC", XDG_CACHE_HOME: cacheHome };
  const cli = (args: string[], extra: string[] = []) => {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(node, [...extra, BIN_JS, ...args], { encoding: "utf8", env });
    return { ...r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  };
  /** Best of five: a slow run on a shared machine is scheduling, not the tool. */
  const best = (args: string[]) => {
    const runs = [cli(args), cli(args), cli(args), cli(args), cli(args)];
    for (const r of runs) expect(r.status, r.stdout).toBe(0);
    return { ms: Math.min(...runs.map((r) => r.ms)), stdout: runs[0]!.stdout };
  };
  let lines = 0;
  /**
   * 300 ms (×2 on CI), unless this host's floor for the same command graph (`show` of line 1,
   * which seeks nothing) is itself so slow that 300 ms leaves no room: then within 100 ms of it.
   */
  const budget = () => Math.max(300 * SLACK, best(["show", "f0000099:1", "--session", big]).ms + 100);

  it("the first around builds the table in under 4 s (×2 on CI) and 150 MB; the second takes under 300 ms", async () => {
    lines = await countNewlines(big);
    const anchor = `f0000099:${lines - 4000}`;
    const first = cli(["around", anchor, "--session", big], ["--import", rss]);
    expect(first.status, first.stdout).toBe(0);
    expect(first.ms).toBeLessThan(4000 * SLACK);
    expect(Number(/MAXRSS_KB (\d+)/.exec(first.stderr)![1]) / 1024).toBeLessThan(150);
    expect(first.stdout).toContain("rows[11]{id,t,kind,text}:");
    const second = best(["around", anchor, "--session", big]);
    expect(second.ms).toBeLessThan(budget());
    expect(second.stdout).toBe(first.stdout);
    const status = cli(["cache", "status"]);
    expect(status.stdout).toContain(`f0000099,${lines},${Math.ceil(lines / 256)},`);
  }, 120_000);

  it("tail with the table warm prints the exact count", () => {
    // buildLarge: four lines a turn, three of them visible by default (the result is hidden).
    const r = cli(["tail", big]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^count: 20 of ${(lines / 4) * 3}$`, "m"));
  }, 60_000);

  it("show near the end takes under 300 ms warm and matches the cold forward scan, links included", async () => {
    // lines - 2 is a call whose result is the next line.
    const id = `f0000099:${lines - 2}`;
    const warm = best(["show", id, "--session", big]);
    expect(warm.stdout).toMatch(/^kind: call$/m);
    expect(warm.stdout).toMatch(/^result: "f0000099:\d+"$/m);
    expect(warm.ms).toBeLessThan(budget());
    const session = await openSession(big);
    const eid = { session: session.short, seq: lines - 2 };
    const seeked = await show(session, eid, { cache: { dir: join(cacheHome, "agent-session-axi") } });
    const cold = await showFromStart(session, eid);
    expect(JSON.stringify({ ...seeked, session: undefined })).toBe(JSON.stringify({ ...cold, session: undefined }));
  }, 120_000);
});
