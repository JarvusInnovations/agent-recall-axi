import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLarge } from "./fixtures/build.js";
import { readLinesBackward } from "../src/lib/reader.js";
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
    const kb = Number(/MAXRSS_KB (\d+)/.exec(r.stderr)![1]);
    expect(kb / 1024).toBeLessThan(150);
    expect(ms).toBeLessThan(2000 * SLACK);
  }, 120_000);
});

describe("find on a 200 MB session", () => {
  it("streams: peak RSS stays under 150 MB while every call's result text is searched", () => {
    // "turn 7777:" is one human prompt; every call still folds its result text into the search.
    const r = spawnSync(node, ["--import", rss, BIN_JS, "find", big, "turn 7777:", "--context", "0"], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", XDG_CACHE_HOME: CACHE_HOME },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^count: "?1 of 1 hit \(/m);
    const kb = Number(/MAXRSS_KB (\d+)/.exec(r.stderr)![1]);
    expect(kb / 1024).toBeLessThan(150);
    const tools = spawnSync(node, ["--import", rss, BIN_JS, "find", big, "--tool", "bash", "zzz-not-there"], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", XDG_CACHE_HOME: CACHE_HOME },
    });
    expect(tools.status).toBe(0);
    expect(tools.stdout).toMatch(/^hits: "0 events match/m);
    expect(Number(/MAXRSS_KB (\d+)/.exec(tools.stderr)![1]) / 1024).toBeLessThan(150);
  }, 180_000);
});

describe("find --deep on a 120 MB persisted output", () => {
  it("streams the file: peak RSS stays under 150 MB for a substring and for a regex", async () => {
    const id = "f0000098-0000-4000-8000-000000000000";
    const session = join(tmp, `${id}.jsonl`);
    const results = join(tmp, id, "tool-results");
    mkdirSync(results, { recursive: true });
    const out = join(results, "bfxlarge.txt");
    const fh = openSync(out, "w");
    const line = `${"widget gadget sprocket flange ".repeat(33)}\n`;
    const block = line.repeat(1024);
    for (let written = 0; written < 120 * 1024 * 1024; written += Buffer.byteLength(block)) writeSync(fh, block);
    writeSync(fh, "final line: deep-needle-7 checksum ok\n");
    closeSync(fh);
    const t = "2026-11-07T13:40:00.000Z";
    writeFileSync(
      session,
      [
        { type: "user", message: { role: "user", content: "dump it" }, origin: { kind: "human" }, uuid: "f0000098-0000-4000-8000-000000000001", timestamp: t },
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fxdeeplarge", name: "Bash", input: { command: "cat big.log" } }] }, uuid: "f0000098-0000-4000-8000-000000000002", timestamp: t },
        {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fxdeeplarge", is_error: false, content: `<persisted-output>\nOutput too large (125.8MB). Full output saved to: ${out}\n\nPreview (first 2KB):\n${line}...\n</persisted-output>` }] },
          uuid: "f0000098-0000-4000-8000-000000000003",
          timestamp: t,
        },
      ].map((o) => JSON.stringify(o)).join("\n") + "\n",
    );
    for (const args of [["deep-needle-7"], ["--regex", "deep-needle-\\d"]]) {
      const r = spawnSync(node, ["--import", rss, BIN_JS, "find", session, ...args, "--deep", "--context", "0"], {
        encoding: "utf8",
        env: { ...process.env, TZ: "UTC", XDG_CACHE_HOME: CACHE_HOME },
      });
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stdout).toMatch(/^hits\[1\]/m);
      expect(Number(/MAXRSS_KB (\d+)/.exec(r.stderr)![1]) / 1024, args.join(" ")).toBeLessThan(150);
    }
  }, 180_000);
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
