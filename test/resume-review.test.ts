/**
 * The review round of plan resume-pack-library (PR #14): each test here failed before its fix.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escapeHeavySession, longHumansSession, longSummarySession, manyShortSession, resumeSession } from "./fixtures/build.js";
import { run } from "./helpers/run.js";
import { buildResumePack, openSession } from "../src/lib/index.js";
import { renderResumePack } from "../src/output/resume.js";
import { formatSize } from "../src/output/sizes.js";
import { LAYER_KEYS, packCost, SUMMARY_DROPPED } from "../src/output/resume-layout.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-resume-review-"));
const files = {
  resume: join(tmp, "ea00002a-0000-4000-8000-000000000000.jsonl"),
  many: join(tmp, "ec00002c-0000-4000-8000-000000000000.jsonl"),
  escapes: join(tmp, "ed00002d-0000-4000-8000-000000000000.jsonl"),
  long: join(tmp, "ee00002e-0000-4000-8000-000000000000.jsonl"),
  longSummary: join(tmp, "e5000025-0000-4000-8000-000000000000.jsonl"),
};
beforeAll(() => {
  writeFileSync(files.resume, resumeSession());
  writeFileSync(files.many, manyShortSession());
  writeFileSync(files.escapes, escapeHeavySession());
  writeFileSync(files.long, longHumansSession());
  writeFileSync(files.longSummary, longSummarySession());
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const body = (out: string) => decode(out.split(/\nhelp\[\d+\]:\n/)[0]!) as Record<string, unknown>;
const cache = () => ({ env: { XDG_CACHE_HOME: mkdtempSync(join(tmp, "cache-")) } });

/** Split a rendered pack into its header block, its layers and its footer. */
function parts(out: string): { header: string; layers: string; footer: string } {
  const lines = out.split("\n");
  const first = lines.findIndex((l) => /^(summary|human)(\[\d+\])?:/.test(l));
  const help = lines.findIndex((l) => /^help\[\d+\]:/.test(l));
  const end = help === -1 ? lines.length : help;
  return { header: lines.slice(0, first).join("\n"), layers: lines.slice(first, end).join("\n"), footer: lines.slice(end).join("\n") };
}

describe("1. the budget bounds the rendered pack", () => {
  it("over several sessions and budgets: layers ≤ used, used ≤ budget, output ≤ budget + header + footer + newest human", async () => {
    for (const path of [files.resume, files.many, files.escapes, files.long, files.longSummary]) {
      const s = await openSession(path);
      for (const budget of [1, 200, 1000, 2000, 6000, 16000, 50000]) {
        const pack = await buildResumePack(s, { budget, cache: cache() });
        const out = renderResumePack(pack, { tz: "UTC", ref: path });
        const p = parts(out);
        const tag = `${path} --budget ${budget}`;
        expect(bytes(p.layers), tag).toBeLessThanOrEqual(pack.budget.used);
        const newest = pack.human[pack.human.length - 1];
        const onlyNewest = pack.tools.length === 0 && pack.claims.length === 0 && pack.human.length <= 1 && !pack.summary;
        if (!onlyNewest) expect(pack.budget.used, tag).toBeLessThanOrEqual(budget);
        // Past the budget: the newest message as printed, the layer key lines, a dropped summary's note.
        const newestBytes = (newest ? packCost(newest) : 0) + LAYER_KEYS + SUMMARY_DROPPED + 20;
        expect(bytes(out), tag).toBeLessThanOrEqual(budget + bytes(p.header) + bytes(p.footer) + newestBytes);
        expect(out).toContain(`budget: ${formatSize(pack.budget.used)} of ${formatSize(budget)} used`);
      }
    }
  });

  it("600 short messages at --budget 6000 print about 6k of layers, not 44k", async () => {
    const r = await run(["resume-pack", files.many, "--budget", "6000"]);
    expect(bytes(parts(r.stdout).layers)).toBeLessThanOrEqual(6000);
    expect(String(body(r.stdout).omitted)).toMatch(/^\d+ earlier messages; continue with human /);
  });

  it("the summary drops last, before the newest human message, and says so", async () => {
    const r = await run(["resume-pack", files.longSummary, "--budget", "1"]);
    const doc = body(r.stdout);
    expect(String(doc.summary)).toMatch(/^dropped to meet the budget; show e5000025:\d+ --full$/);
    expect((doc.human as unknown[]).length).toBe(1);
    expect(r.stdout).toMatch(/show e5000025:\d+ --full --session /);
    const pack = await buildResumePack(await openSession(files.longSummary), { budget: 1, cache: cache() });
    expect(pack.summary).toBeUndefined();
    expect(pack.omitted.summary).toBeDefined();
  });
});

describe("2. the tools layer is C with D results", () => {
  it("labels tools C (results D)", async () => {
    const r = await run(["resume-pack", files.resume]);
    expect(r.stdout).toMatch(/^layers: summary C; human H \(verbatim\); tools C \(results D\); claims C$/m);
  });
});

describe("3. a window past the last names resume-pack's own grammar", () => {
  it("offers an index or last and the range, never k.. or all", async () => {
    const r = await run(["resume-pack", files.resume, "--window", "5"]);
    expect(r.exitCode).toBe(2);
    const help = r.stdout.split(/\nhelp\[\d+\]:\n/)[1]!;
    expect(help).not.toMatch(/k\.\.|\ball\b|\.\. runs/);
    expect(help).toContain("0..1");
    expect(help).toContain("last");
    await expect(buildResumePack(await openSession(files.resume), { window: 5, cache: cache() })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("4 + 8. budget 0 is no budget, and the continuation prints every omitted message", () => {
  it("--budget 0 keeps everything and says no limit", async () => {
    const r = await run(["resume-pack", files.many, "--budget", "0"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^budget: [\d.]+k used \(no limit\)$/m);
    expect((body(r.stdout).human as unknown[]).length).toBe(600);
    const pack = await buildResumePack(await openSession(files.many), { budget: 0, cache: cache() });
    expect(pack.budget.limit).toBe(0);
    expect(pack.omitted.human).toBe(0);
  });

  it("omitted messages beyond human's own 12,000 chars all print through the continuation", async () => {
    const r = await run(["resume-pack", files.long, "--budget", "4000"]);
    const doc = body(r.stdout);
    const m = /continue with (human .*)$/.exec(String(doc.omitted))!;
    expect(m[1]).toContain("--budget 0");
    const pack = await buildResumePack(await openSession(files.long), { budget: 4000, cache: cache() });
    const omittedChars = 3000 * pack.omitted.human;
    expect(omittedChars).toBeGreaterThan(12_000);
    const cont = await run(m[1]!.split(" "));
    expect(cont.exitCode).toBe(0);
    const msgs = (body(cont.stdout).messages as Array<{ text: string }>).map((x) => x.text);
    expect(msgs).toHaveLength(pack.omitted.human);
    msgs.forEach((t, i) => expect(t.startsWith(`long ${i + 1}: `)).toBe(true));
  });
});
