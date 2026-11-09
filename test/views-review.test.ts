/**
 * The review round of plan views (PR #12): each test here failed before its fix.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { farSummarySession, longSummarySession, sharedS8Sessions, sidechainBoundarySession, spacedSlashSession, subagentContinuedSession } from "./fixtures/build.js";
import { fx, run } from "./helpers/run.js";
import { boundaries, events, humanMessages, openSession, resolveWindow, turns, windows, type Event } from "../src/lib/index.js";
import { formatId } from "../src/lib/ids.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-views-review-"));
const path = (name: string) => join(tmp, name);
const files = {
  longSummary: path("e5000025-0000-4000-8000-000000000000.jsonl"),
  sidechain: path("e6000026-0000-4000-8000-000000000000.jsonl"),
  farSummary: path("e8000028-0000-4000-8000-000000000000.jsonl"),
  slash: path("e9000029-0000-4000-8000-000000000000.jsonl"),
  subagent: join(tmp, "e6000026-0000-4000-8000-000000000000", "subagents", "agent-e7a0b1c2d3e4f5a6b.jsonl"),
};
const sharedRoot = join(tmp, "shared-root");
const sharedCwd = "/src/gadget";

beforeAll(() => {
  writeFileSync(files.longSummary, longSummarySession());
  writeFileSync(files.sidechain, sidechainBoundarySession());
  writeFileSync(files.farSummary, farSummarySession());
  writeFileSync(files.slash, spacedSlashSession());
  mkdirSync(join(tmp, "e6000026-0000-4000-8000-000000000000", "subagents"), { recursive: true });
  writeFileSync(files.subagent, subagentContinuedSession());
  const dir = join(sharedRoot, "projects", "-src-gadget");
  mkdirSync(dir, { recursive: true });
  for (const s of sharedS8Sessions()) writeFileSync(join(dir, s.name), s.text);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const body = (out: string) => decode(out.split(/\nhelp\[\d+\]:\n/)[0]!) as Record<string, unknown>;
const hints = (out: string) => [...out.matchAll(/Run `agent-recall-axi ([^`]*)`/g)].map((m) => m[1]!.split(" "));
const helpLines = (out: string) => (out.split(/\nhelp\[\d+\]:\n/)[1] ?? "").split("\n").map((l) => l.trim());
const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("1. human: the opening summary is capped C text inside the budget", () => {
  it("caps the summary at 4,000 chars with the house marker and a show --full hint, and counts it", async () => {
    const r = await run(["human", files.longSummary, "--window", "last"]);
    const doc = body(r.stdout);
    const summary = doc.summary as { id: string; text: string; authority: string };
    expect(summary.authority).toBe("C");
    expect(summary.text).toMatch(/ … \(truncated, \d+ chars total\)$/);
    expect(summary.text.length).toBeLessThan(4100);
    expect(r.stdout).toContain(`show ${summary.id} --full`);
    const msgs = doc.messages as Array<{ text: string }>;
    const used = msgs.reduce((n, m) => n + m.text.length, 0);
    // 12,000 in total: the summary's 4,000 leaves room for 3 of the 2,000-char messages, not 5.
    expect(used + 4000).toBeLessThanOrEqual(12_000);
    expect(msgs.length).toBeLessThan(5);
    expect(String(doc.omitted)).toMatch(/^\d+ earlier messages?; continue with human /);
    // --full lifts both: every message and the summary whole.
    const full = body((await run(["human", files.longSummary, "--window", "last", "--full"])).stdout);
    expect((full.messages as unknown[]).length).toBe(5);
    expect((full.summary as { text: string }).text).not.toContain("truncated");
  });
});

describe("2. sidechain boundaries never cut the main session", () => {
  it("a sidechain compact_boundary, isCompactSummary or summary sentence is a parent notice", async () => {
    const s = await openSession(files.sidechain);
    expect(await windows(s, { cache: { env: { XDG_CACHE_HOME: path("c2") } } })).toHaveLength(1);
    const evs = await collect(events(s, { kinds: "all" }));
    const side = evs.filter((e) => e.id.seq >= 3 && e.id.seq <= 5);
    expect(side.map((e) => [e.kind, e.meta?.source])).toEqual([
      ["notice", "parent"],
      ["notice", "parent"],
      ["notice", "parent"],
    ]);
  });

  it("in a subagent session a parent prompt with the summary sentence is not a summary", async () => {
    const s = await openSession(files.subagent);
    expect(s.kind).toBe("subagent");
    const evs = await collect(events(s, { kinds: "all" }));
    expect(evs[0]).toMatchObject({ kind: "notice", meta: { source: "parent" } });
  });
});

describe("3. a compaction's summary is the next event", () => {
  it("a prompt ends the wait; a later summary is a boundary of its own and opens its window", async () => {
    const s = await openSession(files.farSummary);
    const cache = { env: { XDG_CACHE_HOME: path("c3") } };
    const bs = await boundaries(s, { cache });
    expect(bs).toHaveLength(2);
    expect(bs[0]!.summary).toBeUndefined();
    expect(bs[0]!.compaction.meta?.summary).toBeUndefined();
    expect(bs[1]!.compaction.meta).toMatchObject({ trigger: "unknown" });
    expect((await humanMessages(s, { window: 1, cache })).summary).toBeUndefined();
    expect(formatId((await humanMessages(s, { window: 2, cache })).summary!.id)).toBe(formatId(bs[1]!.compaction.id));
  });
});

describe("4. turns empty state counts the session's lines", () => {
  it("prints the file's line count even when the read stopped early", async () => {
    const r = await run(["turns", fx("hooks"), "--to", "aa00000a:1"]);
    const lines = (await import("node:fs")).readFileSync(fx("hooks"), "utf8").trimEnd().split("\n").length;
    expect(body(r.stdout).turns).toBe(`0 turns in aa00000a (${lines} lines)`);
  });
});

describe("5. window values", () => {
  it("the library rejects bad window values with VALIDATION_ERROR", async () => {
    const s = await openSession(fx("compaction"));
    for (const bad of [-1, 1.5, "x..", "1.5..", NaN]) {
      await expect(resolveWindow(s, bad as never), String(bad)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("the range error's example index lies inside the valid range", async () => {
    const r = await run(["events", fx("compaction"), "--window", "5"]);
    const help = helpLines(r.stdout).join(" ");
    expect(help).toContain("windows 0..1");
    for (const m of help.matchAll(/\b(\d+)\.\.(?!\d)/g)) expect(Number(m[1])).toBeLessThanOrEqual(1);
    expect(help).not.toContain("(2)");
  });
});

describe("8. turns footer", () => {
  it("says how many are shown and gives the --to continuation", async () => {
    const r = await run(["turns", files.longSummary, "--limit", "2"]);
    expect(helpLines(r.stdout)).toContain("Showing the last 2 of 8 turns; raise --limit or narrow with --from");
    expect(hints(r.stdout).some((h) => h[0] === "turns" && h.includes("--to"))).toBe(true);
  });
});

describe("10. a summary that opens the file is window 0's opening summary, not a boundary", () => {
  it("one window, turn 0 ends stop, human --window 0 prints the summary", async () => {
    const s = await openSession(fx("compaction-legacy"));
    expect(await windows(s, { cache: { env: { XDG_CACHE_HOME: path("c10") } } })).toHaveLength(1);
    const ts = await collect(turns(s));
    expect(ts[0]).toMatchObject({ zero: true, ended: "stop" });
    const r = body((await run(["human", fx("compaction-legacy"), "--window", "0"])).stdout);
    expect(r.summary).toMatchObject({ id: "a7000007:1", authority: "C" });
    expect(body((await run(["compactions", fx("compaction-legacy")])).stdout).compactions).toMatch(/^0 in a7000007 \(one window/);
  });
});

describe("11. tools --fields files", () => {
  it("joins paths with a comma and a space", async () => {
    const t = body((await run(["tools", files.farSummary, "--fields", "files"])).stdout).tools as Array<{ files: string }>;
    expect(t[0]!.files).toBe("src/flange/a.ts, src/flange/b.ts");
  });
});

describe("12. hints and determinism", () => {
  it("a shared <s8>: human's omitted continuation names the full id and yields exactly the omitted", async () => {
    const env = { CLAUDE_CONFIG_DIR: sharedRoot };
    const uuid = "c4d6e8fa-ffff-4000-8000-000000000000";
    const r = await run(["human", uuid, "--budget", "150"], { cwd: sharedCwd, env });
    expect(r.exitCode).toBe(0);
    const omitted = String(body(r.stdout).omitted);
    expect(omitted).toMatch(new RegExp(`continue with human ${uuid} --to c4d6e8fa:\\d+ --budget 150$`));
    const cont = hints(r.stdout).find((h) => h[0] === "human")!;
    const rest = await run([...cont, "--full"], { cwd: sharedCwd, env });
    const n = Number(/^(\d+)/.exec(omitted)![1]);
    expect((body(rest.stdout).messages as unknown[]).length).toBe(n);
    for (const h of hints(r.stdout)) expect((await run(h, { cwd: sharedCwd, env })).exitCode, h.join(" ")).toBe(0);
  });

  it("cold (no usable cache) and warm (table present) outputs are byte-identical", async () => {
    const noCache = path("not-a-dir");
    writeFileSync(noCache, "");
    const cold = { XDG_CACHE_HOME: join(noCache, "cache") };
    const warm = { XDG_CACHE_HOME: path("warm") };
    const cases = [
      ["human", files.longSummary, "--window", "last"],
      ["turns", files.farSummary, "--window", "1"],
      ["tools", files.farSummary, "--window", "1.."],
      ["compactions", files.farSummary, "--full"],
      ["events", fx("compaction"), "--window", "1"],
      ["tail", fx("compaction"), "--window", "0"],
    ];
    for (const args of cases) {
      await run(args, { env: warm }); // builds the table
      const w = await run(args, { env: warm });
      const c = await run(args, { env: cold });
      expect(w.exitCode, args.join(" ")).toBe(0);
      expect(c.stdout, args.join(" ")).toBe(w.stdout);
    }
  });
});

describe("13. human.slash keeps its args as stored", () => {
  it("does not trim the args", async () => {
    const s = await openSession(files.slash);
    const ev = (await collect(events(s, { kinds: ["human.slash"] })))[0] as Event;
    expect(ev.text).toBe("/review  src/a.ts  --strict ");
  });
});
