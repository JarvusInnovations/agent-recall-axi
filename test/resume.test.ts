/**
 * The resume pack (plans/resume-pack-library.md, specs/cli.md#resume-pack-session,
 * specs/data-model.md#resume-pack): layers and their order, verbatim H text, the window, the
 * budget policy, determinism cold and warm, and tail's `resume-pack` footer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { longSummarySession, RESUME_HUMAN, resumeSession, sharedS8Sessions, silentAgentSession } from "./fixtures/build.js";
import { fx, run } from "./helpers/run.js";
import { LAYER_KEYS } from "../src/output/resume-layout.js";
import { buildResumePack, humanMessages, openSession, packCost, toolCalls, type Event, type ResumePack } from "../src/lib/index.js";
import { formatId } from "../src/lib/ids.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-resume-"));
const files = {
  resume: join(tmp, "ea00002a-0000-4000-8000-000000000000.jsonl"),
  silent: join(tmp, "eb00002b-0000-4000-8000-000000000000.jsonl"),
  longSummary: join(tmp, "e5000025-0000-4000-8000-000000000000.jsonl"),
};
const sharedRoot = join(tmp, "shared-root");

beforeAll(() => {
  writeFileSync(files.resume, resumeSession());
  writeFileSync(files.silent, silentAgentSession());
  writeFileSync(files.longSummary, longSummarySession());
  const dir = join(sharedRoot, "projects", "-src-gadget");
  mkdirSync(dir, { recursive: true });
  for (const s of sharedS8Sessions()) writeFileSync(join(dir, s.name), s.text);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const split = (out: string) => out.split(/\nhelp\[\d+\]:\n/);
const body = (out: string) => decode(split(out)[0]!) as Record<string, unknown>;
const helpLines = (out: string) => (split(out)[1] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
const hints = (out: string) => [...out.matchAll(/Run `agent-session-axi ([^`]*)`/g)].map((m) => m[1]!.split(" "));
const texts = (v: unknown) => (v as Array<{ text: string }>).map((m) => m.text);
const cache = () => ({ env: { XDG_CACHE_HOME: mkdtempSync(join(tmp, "cache-")) } });

describe("layers", () => {
  it("prints summary, human, tools, claims in that order, labeled, with H text verbatim", async () => {
    const r = await run(["resume-pack", files.resume]);
    expect(r.exitCode).toBe(0);
    const keys = [...r.stdout.matchAll(/^([a-z_]+)(\[\d+\])?(\{[^}]*\})?:/gm)].map((m) => m[1]);
    expect(keys).toEqual(["session", "window", "budget", "layers", "day", "tz", "summary", "human", "tools", "claims", "help"]);
    expect(r.stdout).toMatch(/^window: 1 \(last; windows 0\.\.1\)$/m);
    expect(r.stdout).toMatch(/^layers: summary C; human H \(verbatim\); tools C \(results D\); claims C$/m);
    expect(r.stdout).toMatch(/^budget: [\d.]+k of 16\.0k used$/m);
    expect(r.stdout).toContain("human[6]:");
    expect(r.stdout).toContain("tools[10]{id,t,tool,target,result}:");
    expect(r.stdout).toContain("claims[3]:");
    const doc = body(r.stdout);
    // Byte-equal to the strings the fixture wrote (a decoded TOON string is the stored text).
    expect(texts(doc.human)).toEqual(RESUME_HUMAN);
    expect((doc.human as Array<{ kind: string }>).map((m) => m.kind)).toEqual(["human", "human.slash", "human.queued", "human.answer", "human", "human"]);
    expect((doc.summary as { text: string }).text).toMatch(/^This session is being continued/);
    const tools = doc.tools as Array<{ tool: string; target: string; result: string }>;
    expect(tools.map((t) => t.result)).toContain("persisted 9.9k");
    expect(tools[tools.length - 1]!.result).toBe("pending");
    expect(texts(doc.claims).map((t) => t.slice(0, 11))).toEqual(["Claim three", "Claim four:", "Claim five:"]);
    expect(helpLines(r.stdout).some((l) => /show ea00002a:\d+ --full --session /.test(l))).toBe(true);
  });

  it("the library pack carries the same layers, uncut", async () => {
    const pack = await buildResumePack(await openSession(files.resume), { cache: cache() });
    expect(pack.window).toEqual({ index: 1, count: 2 });
    expect(pack.summary?.kind).toBe("summary");
    expect(pack.human.map((e) => e.text)).toEqual(RESUME_HUMAN);
    expect(pack.tools).toHaveLength(10);
    expect(pack.tools.every((e) => e.kind === "call")).toBe(true);
    expect(pack.claims.map((e) => e.kind)).toEqual(["assistant", "assistant", "assistant"]);
    expect(pack.omitted).toEqual({ human: 0 });
    const all = [pack.summary!, ...pack.human, ...pack.tools, ...pack.claims];
    expect(pack.budget).toEqual({ used: LAYER_KEYS + all.reduce((n, e) => n + packCost(e), 0), limit: 16_000 });
  });

  it("agrees with human and tools over the same window", async () => {
    const s = await openSession(files.resume);
    for (const window of [0, 1] as const) {
      const pack = await buildResumePack(s, { window, budget: 1_000_000, tools: 1000, claims: 0, cache: cache() });
      const h = await humanMessages(s, { window, budget: 0, cache: cache() });
      expect(pack.human).toEqual(h.messages);
      expect(pack.summary).toEqual(h.summary);
      const calls: Event[] = [];
      for await (const c of toolCalls(s, { window, cache: cache() })) calls.push(c);
      expect(pack.tools).toEqual(calls);
    }
  });

  it("--window 0 omits the summary and reads window 0", async () => {
    const r = await run(["resume-pack", files.resume, "--window", "0"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/^summary:/m);
    expect(r.stdout).toMatch(/^layers: human H \(verbatim\); tools C \(results D\); claims C$/m);
    expect(r.stdout).toMatch(/^window: 0 \(windows 0\.\.1\)$/m);
    const doc = body(r.stdout);
    expect(texts(doc.human)).toEqual(["start the flange split"]);
    expect((doc.tools as Array<{ target: string }>).map((t) => t.target)).toEqual(["src/flange/index.ts"]);
    expect(texts(doc.claims)).toEqual(["Window zero work done."]);
  });

  it("a one-window session says so; --tools 3 --claims 1 are respected; no assistant text is claims[0]", async () => {
    const one = await run(["resume-pack", fx("find"), "--tools", "3", "--claims", "1"]);
    expect(one.stdout).toMatch(/^window: 0 \(last; only window 0\)$/m);
    expect(one.stdout).toContain("tools[3]{id,t,tool,target,result}:");
    expect(one.stdout).toContain("claims[1]:");
    expect(texts(body(one.stdout).claims)).toEqual(["Deployed to staging."]);
    const none = await run(["resume-pack", files.silent]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toMatch(/^claims\[0\]:$/m);
    expect(body(none.stdout).claims).toEqual([]);
    const empty = await run(["resume-pack", files.silent, "--tools", "0"]);
    expect(empty.stdout).toMatch(/^tools\[0\]:$/m);
    expect(body(empty.stdout).tools).toEqual([]);
  });

  it("the opening summary is C text cut at 4,000 chars with a show --full hint", async () => {
    const r = await run(["resume-pack", files.longSummary]);
    const summary = body(r.stdout).summary as { id: string; text: string };
    expect(summary.text).toMatch(/ … \(truncated, \d+ chars total\)$/);
    expect(r.stdout).toContain(`show ${summary.id} --full --session `);
  });
});

describe("budget", () => {
  const sizes = (p: ResumePack) => ({ human: p.human.length, tools: p.tools.length, claims: p.claims.length });

  it("--budget 2000 drops claims, then calls, then the oldest human messages, and the continuation yields them", async () => {
    const full = await buildResumePack(await openSession(files.resume), { cache: cache() });
    const pack = await buildResumePack(await openSession(files.resume), { budget: 2000, cache: cache() });
    expect(pack.claims).toEqual([]);
    expect(pack.tools).toEqual([]);
    expect(pack.omitted.human).toBeGreaterThan(0);
    expect(pack.human.map((e) => e.text)).toEqual(RESUME_HUMAN.slice(pack.omitted.human));
    expect(pack.omitted.continueTo).toEqual(pack.human[0]!.id);
    expect(pack.budget.used).toBeLessThanOrEqual(2000);
    // The kept messages are the longest suffix that fits: one more would not.
    const next = full.human[pack.omitted.human - 1]!;
    expect(pack.budget.used + packCost(next)).toBeGreaterThan(2000);

    const r = await run(["resume-pack", files.resume, "--budget", "2000"]);
    const doc = body(r.stdout);
    const n = pack.omitted.human;
    const cont = `human ${files.resume} --window 1 --to ${formatId(pack.omitted.continueTo!)} --budget 0`;
    expect(doc.omitted).toBe(`${n} earlier message${n === 1 ? "" : "s"}; continue with ${cont}`);
    // omitted: is the header's last line, before the layers.
    const lines = r.stdout.split("\n");
    expect(lines.findIndex((l) => l.startsWith("omitted:"))).toBe(lines.findIndex((l) => l.startsWith("summary:")) - 1);
    expect(helpLines(r.stdout)[0]).toContain(cont);
    const omitted = await run(cont.split(" "));
    expect(omitted.exitCode).toBe(0);
    expect(texts(body(omitted.stdout).messages)).toEqual(RESUME_HUMAN.slice(0, n));
  });

  it("over every budget the drops follow the policy and the newest human message stays", async () => {
    const session = await openSession(files.resume);
    const c = cache();
    const full = await buildResumePack(session, { cache: c });
    const total = full.budget.used;
    let prev = sizes(full);
    for (let budget = total + 50; budget >= 1; budget -= 37) {
      const p = await buildResumePack(session, { budget, cache: c });
      const s = sizes(p);
      if (s.tools < full.tools.length) expect(s.claims).toBe(0);
      if (s.human < full.human.length) expect(s.tools + s.claims).toBe(0);
      expect(p.human[p.human.length - 1]!.text).toBe(RESUME_HUMAN[RESUME_HUMAN.length - 1]);
      // What survives is always the newest of each layer.
      expect(p.claims.map((e) => e.id)).toEqual(full.claims.slice(full.claims.length - s.claims).map((e) => e.id));
      expect(p.tools.map((e) => e.id)).toEqual(full.tools.slice(full.tools.length - s.tools).map((e) => e.id));
      if (p.budget.used > budget) expect(s).toEqual({ human: 1, tools: 0, claims: 0 });
      expect(s.human <= prev.human && s.tools <= prev.tools && s.claims <= prev.claims).toBe(true);
      prev = s;
    }
  });
});

describe("validation", () => {
  it("rejects a window that is not one window, and values out of range, before reading", async () => {
    for (const args of [
      ["--window", "all"],
      ["--window", "1.."],
      ["--budget", "-5"],
      ["--tools", "x"],
    ]) {
      const r = await run(["resume-pack", files.resume, ...args]);
      expect(r.exitCode, args.join(" ")).toBe(2);
      expect(r.stdout).toContain("code: VALIDATION_ERROR");
    }
    const past = await run(["resume-pack", files.resume, "--window", "5"]);
    expect(past.exitCode).toBe(2);
    expect(past.stdout).toContain("windows 0..1");
    const s = await openSession(files.resume);
    for (const opts of [{ window: "all" }, { budget: -1 }, { budget: 1.5 }, { tools: -1 }, { claims: Number.NaN }]) {
      await expect(buildResumePack(s, opts as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    const missing = await run(["resume-pack"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toContain("code: USAGE");
  });

  it("--json-out is registered as planned, not unknown", async () => {
    const r = await run(["resume-pack", files.resume, "--json-out"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("planned: sessions-and-recall");
  });
});

describe("determinism", () => {
  it("two runs, cold and warm, print the same bytes; the library result deep-equals", async () => {
    const dir = mkdtempSync(join(tmp, "warm-"));
    const env = { XDG_CACHE_HOME: dir };
    const cold = await run(["resume-pack", files.resume, "--budget", "3000"], { env });
    const warm = await run(["resume-pack", files.resume, "--budget", "3000"], { env });
    // No usable cache location at all: built in memory every time.
    const none = await run(["resume-pack", files.resume, "--budget", "3000"], { env: { XDG_CACHE_HOME: "/dev/null/no-cache" } });
    expect(warm.stdout).toBe(cold.stdout);
    expect(none.stdout).toBe(cold.stdout);
    const s = await openSession(files.resume);
    const a = await buildResumePack(s, { budget: 3000, cache: { env } });
    const b = await buildResumePack(s, { budget: 3000, cache: cache() });
    expect(b).toEqual(a);
  });
});

describe("tail's resume-pack footer", () => {
  const runHint = async (out: string, opts: Parameters<typeof run>[1] = {}) => {
    const h = hints(out).find((a) => a[0] === "resume-pack");
    expect(h, out).toBeDefined();
    const r = await run(h!, opts);
    expect(r.exitCode, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^layers: /m);
    return { hint: h!, out: r.stdout };
  };

  it("names the session by <s8>, by full id when the <s8> is shared, by path, and carries scope and --tz", async () => {
    const s8 = await runHint((await run(["tail", "a6000006"])).stdout);
    expect(s8.hint).toEqual(["resume-pack", "a6000006"]);
    const scoped = await runHint((await run(["tail", "a6000006", "--all", "--tz", "America/New_York"], { cwd: "/elsewhere" })).stdout, { cwd: "/elsewhere" });
    expect(scoped.hint).toEqual(["resume-pack", "a6000006", "--all", "--tz", "America/New_York"]);
    expect(scoped.out).toMatch(/^tz: America\/New_York$/m);
    const env = { CLAUDE_CONFIG_DIR: sharedRoot };
    const shared = await runHint((await run(["tail", "c4d6e8fa-0000-4000-8000-000000000000"], { env, cwd: "/src/gadget" })).stdout, { env, cwd: "/src/gadget" });
    expect(shared.hint[1]).toBe("c4d6e8fa-0000-4000-8000-000000000000");
    const path = await runHint((await run(["tail", files.resume])).stdout);
    expect(path.hint[1]).toBe(files.resume);
  });

  it("the pack's own footers resolve as printed", async () => {
    const env = { CLAUDE_CONFIG_DIR: sharedRoot };
    const r = await run(["resume-pack", "c4d6e8fa-ffff-4000-8000-000000000000", "--budget", "100"], { env, cwd: "/src/gadget" });
    expect(r.exitCode).toBe(0);
    const all = hints(r.stdout);
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const h of all) {
      expect(h[1]).toBe("c4d6e8fa-ffff-4000-8000-000000000000");
      const out = await run(h, { env, cwd: "/src/gadget" });
      expect(out.exitCode, h.join(" ")).toBe(0);
    }
    const human = (body(r.stdout).human as Event[]).map((m) => m.text);
    expect(human).toHaveLength(1);
  });
});
