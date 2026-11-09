/**
 * Session stats and titles, the full `sessions` schema, the stats cache and AMBIGUOUS_SESSION
 * titles (plan sessions-and-recall; specs/cli.md#sessions, specs/data-model.md#session).
 */
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { sessionStats } from "../src/lib/stats.js";
import { openSession } from "../src/lib/session.js";
import { FIXTURE_ROOT, lateTailSession, titleSessions, writeGenerated } from "./fixtures/build.js";
import { run } from "./helpers/run.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-sessions-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A fresh log root and cache for one test. */
function sandbox(name: string): { root: string; cache: string; env: Record<string, string> } {
  const root = join(tmp, name, "claude");
  const cache = join(tmp, name, "cache");
  mkdirSync(join(root, "projects"), { recursive: true });
  return { root, cache, env: { CLAUDE_CONFIG_DIR: root, XDG_CACHE_HOME: cache } };
}

function table(out: string, label: string): Array<Record<string, unknown>> {
  return (decode(out.split(/^help\[/m)[0]!) as Record<string, Array<Record<string, unknown>>>)[label]!;
}

describe("titles follow the precedence", () => {
  const box = sandbox("titles");
  writeGenerated(box.root, titleSessions());

  it("custom-title.json, then the last custom-title entry, then the last ai-title, then the first human prompt", async () => {
    const r = await run(["sessions", "--fields", "uuid"], { cwd: "/src/gadget", env: box.env });
    expect(r.exitCode).toBe(0);
    const rows = Object.fromEntries(table(r.stdout, "sessions").map((x) => [x.id, x.title]));
    expect(rows).toEqual({
      d4000034: "gadget audit",
      d5000035: "my flange notes",
      d6000036: "rename the cog helpers",
      d7000037: "file title",
    });
  });

  it("the library reports where each title came from", async () => {
    const dir = join(box.root, "projects", "-src-gadget");
    const sources: Record<string, string | undefined> = {};
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      const st = await sessionStats(await openSession(join(dir, f)), { cache: { env: box.env } });
      sources[f.slice(0, 8)] = st.titleSource;
    }
    expect(sources).toEqual({ d4000034: "ai-title", d5000035: "custom-title", d6000036: "human", d7000037: "custom-title.json" });
  });

  it("the resume-pack header carries the same title (from resume-pack-library)", async () => {
    for (const [id, title] of [["d4000034", "gadget audit"], ["d7000037", "file title"], ["d6000036", "rename the cog helpers"]]) {
      const r = await run(["resume-pack", id!], { cwd: "/src/gadget", env: box.env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`^session: ${id} ${title}$`, "m"));
    }
  });

  it("an ambiguous prefix's candidates carry each session's real title", async () => {
    const r = await run(["tail", "c3b5d7e9"], { cwd: "/src/sprocket" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^code: AMBIGUOUS_SESSION$/m);
    expect(r.stdout).not.toContain("(pending)");
    expect(r.stdout).toContain("candidates[2]{id,kind,project,title}:");
    expect(r.stdout).toContain("c3b5d7e9-0000-4000-8000-000000000000,main,/src/sprocket,sprocket task for c3b5d7e9\n");
    expect(r.stdout).toContain("c3b5d7e9-ffff-4000-8000-000000000000,main,/src/sprocket,sprocket task for c3b5d7e9-ffff-4000-8000-000000000000\n");
  });
});

describe("sessions: the full schema", () => {
  it("defaults to four columns; --fields started adds the start time back (AXI §2)", async () => {
    const plain = await run(["sessions", "--limit", "3"]);
    expect(plain.stdout).toContain("{id,last,turns,title}:");
    expect(plain.stdout).not.toContain("started");
    const r = await run(["sessions", "--limit", "3", "--fields", "started"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("{id,last,turns,title,started}:");
    for (const row of table(r.stdout, "sessions")) expect(String(row.started)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("--fields calls,compactions,humans,live,bytes,lines all populate", async () => {
    const r = await run(["sessions", "--limit", "0", "--fields", "calls,compactions,humans,live,bytes,lines,model"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("{id,last,turns,title,calls,compactions,humans,live,bytes,lines,model}");
    const rows = Object.fromEntries(table(r.stdout, "sessions").map((x) => [x.id, x]));
    // compaction fixture: one boundary; the hooks fixture's queued/slash/answer count as humans.
    expect(rows.a6000006).toMatchObject({ compactions: 1, turns: 2 });
    const e1 = rows.e1000018!;
    expect(e1).toMatchObject({ turns: 2, humans: 2, calls: 6, live: false, model: "model-x" });
    expect(e1.bytes).toBe(statSync(join(FIXTURE_ROOT, "projects", "-src-widget", "e1000018-0000-4000-8000-000000000000.jsonl")).size);
    expect(e1.lines).toBe(18);
    // live: last within 5 minutes of now
    const live = await run(["sessions", "--limit", "1", "--fields", "live"], { now: new Date("2026-11-08T00:07:00.000Z") });
    expect(table(live.stdout, "sessions")[0]).toMatchObject({ id: "b1000011", live: true });
  });

  it("a stale sessions-index.json never changes turns or omits a session; a listed-but-deleted one is not shown", async () => {
    const r = await run(["sessions", "--limit", "0"]);
    const rows = table(r.stdout, "sessions");
    expect(rows).toHaveLength(22);
    expect(rows.map((x) => x.id)).not.toContain("deadbeef");
    // The index says a1000001 has 5 messages; it has two prompts.
    expect(rows.find((x) => x.id === "a1000001")).toMatchObject({ turns: 2 });
    const home = await run([]);
    expect(home.stdout).not.toContain("deadbeef");
  });

  it("--subagents adds subagent rows with kind and parent; without it they are absent but still resolvable", async () => {
    const without = await run(["sessions", "--limit", "0"]);
    expect(without.stdout).not.toContain("ae0f1e2d");
    const withSubs = await run(["sessions", "--limit", "0", "--subagents"]);
    expect(withSubs.stdout).toContain("{id,last,turns,title,kind,parent}");
    expect(table(withSubs.stdout, "sessions").find((x) => x.id === "ae0f1e2d")).toMatchObject({ kind: "subagent", parent: "ae00000e" });
    expect((await run(["tail", "ae0f1e2d"])).exitCode).toBe(0);
  });

  it("the footer hints turns, find and the paging continuation, and each runs", async () => {
    const r = await run(["sessions", "--limit", "2", "--since", "2d"]);
    const hints = [...r.stdout.matchAll(/Run `agent-session-axi ([^`]*)`/g)].map((m) => m[1]!);
    expect(hints[0]).toMatch(/^turns [0-9a-f]{8}$/);
    expect(hints).toContain('find "<phrase>"');
    expect(hints).toContain("sessions --since 2d --limit 0");
    for (const h of hints.filter((x) => !x.includes("<phrase>"))) expect((await run(h.split(" "))).exitCode, h).toBe(0);
  });
});

describe("session last is the exact newest timestamp", () => {
  it("a newest timestamp more than 256 KB before the end of the file is the session's last", async () => {
    const box = sandbox("late");
    const f = lateTailSession();
    writeGenerated(box.root, [f]);
    expect(Buffer.byteLength(f.text)).toBeGreaterThan(300 << 10);
    const r = await run(["sessions"], { env: box.env });
    const row = table(r.stdout, "sessions")[0]!;
    expect(row.id).toBe("d8000038");
    expect(row.last).toMatch(/^11-07 13:00 /);
  });
});

describe("the stats cache", () => {
  it("an append updates the stats; a rewrite discards them; neither ever serves stale numbers", async () => {
    const box = sandbox("stats-cache");
    const dir = join(box.root, "projects", "-src-widget");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "a1000001-0000-4000-8000-000000000000.jsonl");
    cpSync(join(FIXTURE_ROOT, "projects", "-src-widget", "a1000001-0000-4000-8000-000000000000.jsonl"), path);
    const turns = async () => table((await run(["sessions", "--fields", "lines"], { env: box.env })).stdout, "sessions")[0]!;
    expect(await turns()).toMatchObject({ turns: 2, lines: 5 });
    expect(readdirSync(join(box.cache, "agent-session-axi", "stats"))).toHaveLength(1);
    const prompt = (text: string, ts: string) => JSON.stringify({ type: "user", message: { role: "user", content: text }, origin: { kind: "human" }, uuid: `u-${ts}`, timestamp: ts, sessionId: "a1000001-0000-4000-8000-000000000000" }) + "\n";
    appendFileSync(path, prompt("one more widget question", "2026-11-07T13:50:00.000Z"));
    expect(await turns()).toMatchObject({ turns: 3, lines: 6, last: "11-07 13:50 (10m ago)" });
    // Rewritten in place, shorter: the old numbers must not survive.
    writeFileSync(path, prompt("a different first line", "2026-11-07T13:00:00.000Z"));
    expect(await turns()).toMatchObject({ turns: 1, lines: 1, title: "a different first line" });
  });

  it("is owner-only, holds no message text, and cache clear --project removes only that project's records", async () => {
    const box = sandbox("cache-hygiene");
    cpSync(join(FIXTURE_ROOT, "projects"), join(box.root, "projects"), { recursive: true });
    await run(["sessions", "--all"], { env: box.env });
    await run(["recall", "widget"], { env: box.env });
    const base = join(box.cache, "agent-session-axi");
    expect(statSync(base).mode & 0o777).toBe(0o700);
    for (const sub of ["index", "stats", "terms"]) {
      expect(statSync(join(base, sub)).mode & 0o777, sub).toBe(0o700);
      for (const f of readdirSync(join(base, sub))) expect(statSync(join(base, sub, f)).mode & 0o777, `${sub}/${f}`).toBe(0o600);
    }
    // Titles are kept as positions, never text; the stats mirror holds none of a prompt's words.
    for (const f of readdirSync(join(base, "stats"))) {
      const text = readFileSync(join(base, "stats", f), "utf8");
      expect(text).not.toContain("start the overnight widget migration");
      expect(text).not.toContain("gadget survey");
    }
    // The term index holds tokens only: never a phrase with its spaces.
    for (const f of readdirSync(join(base, "terms"))) {
      const rec = JSON.parse(readFileSync(join(base, "terms", f), "utf8")) as { terms: Array<[string, number[]]> };
      for (const [tok, seqs] of rec.terms) {
        expect(tok).toMatch(/^[\p{L}\p{N}_]+$/u);
        expect(seqs.every((s) => Number.isInteger(s))).toBe(true);
      }
    }
    const status = await run(["cache", "status"], { env: box.env });
    expect(status.stdout).toMatch(/^size: \S+$/m);
    const count = (sub: string) => readdirSync(join(base, sub)).length;
    const before = { stats: count("stats"), terms: count("terms") };
    const cleared = await run(["cache", "clear", "--project", "/src/gadget"], { env: box.env });
    expect(cleared.exitCode).toBe(0);
    // gadget has one session: its table, stats and terms records go; nothing else.
    expect(count("stats")).toBe(before.stats - 1);
    expect(count("terms")).toBe(before.terms - 1);
    expect(cleared.stdout).toMatch(/^cleared: 3 records for \/src\/gadget$/m);
  });
});
