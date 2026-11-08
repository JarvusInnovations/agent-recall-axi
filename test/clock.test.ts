/**
 * Relative times appear only in `sessions` and the home view (specs/behaviors/row-format.md#relative-times,
 * principles.md#deterministic-output-for-the-same-file): every other command prints the same bytes
 * whatever the clock says, `recall`'s measured scan time aside.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./helpers/run.js";

const A = new Date("2026-11-07T14:00:00.000Z");
const B = new Date("2026-11-07T16:30:00.000Z");

const COMMANDS: string[][] = [
  ["events", "e1000018", "--limit", "0"],
  ["tail", "e1000018"],
  ["turns", "e1000018"],
  ["human", "e1000018"],
  ["tools", "e1000018"],
  ["compactions", "a6000006"],
  ["show", "e1000018:4"],
  ["around", "e1000018:4"],
  ["next", "e1000018:4"],
  ["prev", "e1000018:14"],
  ["find", "e1000018", "redirect"],
  ["find", "redirect"],
  ["find", "redirect", "--all"],
  ["recall", "redirect"],
  ["cache", "status"],
];

/** `cache status` reports the cache's contents: give it one no parallel test writes into. */
const own = mkdtempSync(join(tmpdir(), "asa-clock-"));
afterAll(() => rmSync(own, { recursive: true, force: true }));
const envFor = (args: string[]) => (args[0] === "cache" ? { XDG_CACHE_HOME: own } : {});

/** recall reports how long its scan took: the one value allowed to differ. */
const normalize = (out: string) => out.replace(/^(scanned: "[^"]*), [\d.]+s"$/m, "$1, <t>\"").replace(/^index: \w+$/m, "index: <state>");

describe("output is clock-independent outside sessions and the home view", () => {
  it.each(COMMANDS.map((c) => [c.join(" "), c]))("%s", async (_name, args) => {
    const a = await run(args as string[], { now: A, env: envFor(args as string[]) });
    const b = await run(args as string[], { now: B, env: envFor(args as string[]) });
    expect(a.exitCode).toBe(0);
    expect(normalize(b.stdout)).toBe(normalize(a.stdout));
    expect(a.stdout).not.toMatch(/\d+[smhd] ago/);
  });

  it("sessions and the home view do print relative times", async () => {
    for (const args of [["sessions"], []]) {
      const a = await run(args, { now: A });
      const b = await run(args, { now: B });
      expect(a.stdout).toMatch(/ ago\)/);
      expect(b.stdout).not.toBe(a.stdout);
    }
  });
});
