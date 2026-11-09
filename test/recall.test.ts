/**
 * Cross-session find, recall and the term index (plan sessions-and-recall; specs/cli.md#find,
 * #recall, specs/architecture.md#cache).
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { recall } from "../src/lib/recall.js";
import { OUTPUT_ONLY_PHRASE, RECALL_PHRASE, recallSessions, writeGenerated } from "./fixtures/build.js";
import { run } from "./helpers/run.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-recall-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function sandbox(name: string): { root: string; cache: string; env: Record<string, string> } {
  const root = join(tmp, name, "claude");
  const cache = join(tmp, name, "cache");
  mkdirSync(join(root, "projects"), { recursive: true });
  writeGenerated(root, recallSessions());
  return { root, cache, env: { CLAUDE_CONFIG_DIR: root, XDG_CACHE_HOME: cache } };
}

const NOW = new Date("2026-11-07T14:00:00.000Z");
const body = (out: string) => decode(out.split(/^(help\[|json_out:)/m)[0]!) as Record<string, unknown>;
const hints = (out: string) => [...out.matchAll(/Run `agent-session-axi ([^`]*)`/g)].map((m) => m[1]!);
/** A hint as argv: quoted words kept together (the phrase). */
const argv = (hint: string) => [...hint.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);

describe("find across sessions", () => {
  const box = sandbox("find");
  const opts = { env: box.env, now: NOW, cwd: "/src/gadget" };

  it("find <phrase> --project returns hits from two sessions with distinct <s8>s and scanned: 2 sessions", async () => {
    const r = await run(["find", RECALL_PHRASE, "--project", "/src/gadget", "--context", "0"], opts);
    expect(r.exitCode).toBe(0);
    const b = body(r.stdout);
    expect(b.scope).toBe("/src/gadget (project)");
    expect(b.scanned).toMatch(/^2 sessions, [\d.]+ KB$/);
    const ids = (b.hits as Array<{ id: string }>).map((h) => h.id);
    expect(new Set(ids.map((i) => i.split(":")[0]))).toEqual(new Set(["d1000031", "d2000032"]));
    // Newest file first, file order within.
    expect(ids).toEqual(["d1000031:1", "d1000031:2", "d2000032:1"]);
    for (const h of hints(r.stdout)) expect((await run(argv(h), opts)).exitCode, h).toBe(0);
  });

  it("with no session and no flag it searches the current project", async () => {
    const r = await run(["find", RECALL_PHRASE, "--context", "0"], opts);
    expect(body(r.stdout).scope).toBe("/src/gadget (project)");
    expect(hints(r.stdout)).toContain(`find '${RECALL_PHRASE}' --all`);
  });

  it("--all spans both projects (and folds a call's output in, as find does); --since excludes the old session", async () => {
    const all = await run(["find", RECALL_PHRASE, "--all", "--since", "1y", "--context", "0"], opts);
    const ids = (body(all.stdout).hits as Array<{ id: string }>).map((h) => h.id.split(":")[0]);
    expect(new Set(ids)).toEqual(new Set(["d1000031", "d2000032", "d3000033"]));
    expect(body(all.stdout).scanned).toMatch(/^3 sessions/);
    const recent = await run(["find", RECALL_PHRASE, "--all", "--since", "30d", "--context", "0"], opts);
    const rids = (body(recent.stdout).hits as Array<{ id: string }>).map((h) => h.id.split(":")[0]);
    expect(new Set(rids)).toEqual(new Set(["d1000031", "d3000033"]));
    expect(body(recent.stdout).scanned).toMatch(/^2 sessions/);
    // --all without a window: the 90-day default, said so.
    const dflt = await run(["find", RECALL_PHRASE, "--all", "--context", "0"], opts);
    expect(body(dflt.stdout).since).toBe("90d (the --all default)");
    const output = await run(["find", OUTPUT_ONLY_PHRASE, "--all", "--context", "0"], opts);
    expect((body(output.stdout).hits as Array<{ id: string; kind: string }>)[0]).toMatchObject({ id: "d1000031:3", kind: "call" });
  });

  it("find <s8> <phrase> prints a find <phrase> --all hint that runs", async () => {
    const r = await run(["find", "d1000031", RECALL_PHRASE, "--tool", "bash"], opts);
    const all = hints(r.stdout).find((h) => h.endsWith("--all"));
    expect(all).toBe(`find '${RECALL_PHRASE}' --tool bash --all`);
    const ran = await run(argv(all!), opts);
    expect(ran.exitCode).toBe(0);
    expect(body(ran.stdout).scope).toBe("all projects");
  });

  it("paging past --limit continues the last hit's session and offers --limit 0; each runs", async () => {
    const r = await run(["find", "sprocket", "--all", "--since", "1y", "--context", "0", "--limit", "2"], opts);
    expect(body(r.stdout).count).toBe("2 of 4 hits");
    const hs = hints(r.stdout);
    expect(hs).toContain("find d1000031 sprocket --from d1000031:3 --all");
    expect(hs).toContain("find sprocket --since 1y --limit 0 --all");
    for (const h of hs) expect((await run(argv(h), opts)).exitCode, h).toBe(0);
  });

  it("an id bound without a session is VALIDATION_ERROR; zero hits is a definitive empty line", async () => {
    const bad = await run(["find", RECALL_PHRASE, "--from", "d1000031:2"], opts);
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    const none = await run(["find", "no such words here"], opts);
    expect(none.exitCode).toBe(0);
    expect(body(none.stdout).hits).toBe('0 events match phrase "no such words here" in /src/gadget (2 sessions, 0.6 KB scanned)'.replace("0.6 KB", String(body(none.stdout).scanned).split(", ")[1]!));
    expect(hints(none.stdout)).toContain("find 'no such words here' --all");
  });
});

describe("recall", () => {
  it("groups by session with hits and first, newest first; index: none, then fresh with identical results, and identical with the cache deleted", async () => {
    const box = sandbox("recall");
    const opts = { env: box.env, now: NOW };
    const first = await run(["recall", RECALL_PHRASE, "--since", "1y"], opts);
    expect(first.exitCode).toBe(0);
    const b1 = body(first.stdout);
    expect(b1.index).toBe("none");
    expect(b1.scanned).toMatch(/^3 sessions, [\d.]+ KB, [\d.]+s$/);
    // Human, assistant (any case) and call input count; the tool's output does not.
    expect(b1.sessions).toEqual([
      { id: "d1000031", project: "/src/gadget", last: "11-07 10:00", hits: 2, first: "d1000031:1" },
      { id: "d3000033", project: "/src/sprocket", last: "11-06 09:00", hits: 1, first: "d3000033:2" },
      { id: "d2000032", project: "/src/gadget", last: "06-01 09:00", hits: 1, first: "d2000032:1" },
    ]);
    const second = await run(["recall", RECALL_PHRASE, "--since", "1y"], opts);
    expect(body(second.stdout).index).toBe("fresh");
    expect(body(second.stdout).sessions).toEqual(b1.sessions);
    rmSync(box.cache, { recursive: true, force: true });
    const third = await run(["recall", RECALL_PHRASE, "--since", "1y"], opts);
    expect(body(third.stdout).index).toBe("none");
    expect(body(third.stdout).sessions).toEqual(b1.sessions);
    for (const h of hints(first.stdout)) expect((await run(argv(h), opts)).exitCode, h).toBe(0);
    expect(hints(first.stdout)[0]).toBe(`find d1000031 '${RECALL_PHRASE}' --all`);
  });

  it("the default window is 90 days; an appended session is read from its index's end (partial) with the same answer as a scan", async () => {
    const box = sandbox("append");
    const opts = { env: box.env, now: NOW };
    const r = await run(["recall", RECALL_PHRASE], opts);
    expect(body(r.stdout).since).toBe("90d (the default)");
    expect((body(r.stdout).sessions as Array<{ id: string }>).map((x) => x.id)).toEqual(["d1000031", "d3000033"]);
    const path = join(box.root, "projects", "-src-gadget", "d1000031-0000-4000-8000-000000000000.jsonl");
    appendFileSync(path, JSON.stringify({ type: "user", message: { role: "user", content: "one more sprocket rebalance pass" }, origin: { kind: "human" }, uuid: "u-extra", timestamp: "2026-11-07T10:05:00.000Z", sessionId: "d1000031-0000-4000-8000-000000000000" }) + "\n");
    const after = await run(["recall", RECALL_PHRASE], opts);
    expect(body(after.stdout).index).toBe("partial");
    const scan = await recall(RECALL_PHRASE, { scope: { env: { CLAUDE_CONFIG_DIR: box.root } }, from: new Date(NOW.getTime() - 90 * 86_400_000), cache: { dir: join(box.cache, "fresh") } });
    expect(scan.scanned.index).toBe("none");
    expect((body(after.stdout).sessions as Array<{ id: string; hits: number }>)[0]).toMatchObject({ id: "d1000031", hits: 3 });
    expect(scan.sessions.map((s) => [s.session.short, s.hits])).toEqual([["d1000031", 3], ["d3000033", 1]]);
  });

  it("matches every word run of the phrase inside the index's tokens (substrings, case), and a regex scans", async () => {
    const box = sandbox("tokens");
    const opts = { env: box.env, now: NOW };
    await run(["recall", "x", "--since", "1y"], opts);
    const sub = await run(["recall", "ROCKET REBAL", "--since", "1y"], opts);
    expect(body(sub.stdout).index).toBe("fresh");
    expect((body(sub.stdout).sessions as unknown[]).length).toBe(3);
    const re = await run(["recall", "sprocket\\s+rebalance", "--regex", "--since", "1y"], opts);
    expect(body(re.stdout).index).toBe("none");
    expect((body(re.stdout).sessions as unknown[]).length).toBe(3);
  });

  it("no match: the definitive empty line with the scanned count and a --since 1y hint", async () => {
    const box = sandbox("empty");
    const r = await run(["recall", OUTPUT_ONLY_PHRASE], { env: box.env, now: NOW });
    expect(r.exitCode).toBe(0);
    expect(body(r.stdout).sessions).toBe(`0 of 2 scanned mention "${OUTPUT_ONLY_PHRASE}" since 90d`);
    expect(hints(r.stdout)[0]).toBe(`recall '${OUTPUT_ONLY_PHRASE}' --since 1y`);
    expect(hints(r.stdout)[1]).toBe(`find '${OUTPUT_ONLY_PHRASE}' --all`);
  });

  it("validates before reading: a D kind, --since with --from, a bad regex", async () => {
    const box = sandbox("validate");
    for (const args of [["recall", "x", "--kind", "result"], ["recall", "x", "--since", "1d", "--from", "today"], ["recall", "(a+)+", "--regex"], ["recall"]]) {
      const r = await run(args, { env: box.env, now: NOW });
      expect(r.exitCode, args.join(" ")).toBe(2);
    }
  });
});

describe("--json-out", () => {
  const box = sandbox("json");
  const opts = { env: { ...box.env, TMPDIR: join(tmp, "json", "tmp") }, now: NOW, cwd: "/src/gadget" };
  mkdirSync(join(tmp, "json", "tmp"), { recursive: true });
  const target = (out: string) => /^json_out: (.+)$/m.exec(out)![1]!;

  it("writes the complete, uncapped result, owner-only, and names it last before help[]", async () => {
    const { statSync } = await import("node:fs");
    const cases: Array<[string[], string, number]> = [
      [["events", "d1000031", "--limit", "1"], "events", 4],
      [["turns", "d1000031", "--limit", "0"], "turns", 1],
      [["human", "d1000031", "--budget", "1"], "messages", 1],
      [["tools", "d1000031"], "tools", 1],
      [["find", "d1000031", "sprocket", "--limit", "1"], "hits", 2],
      [["find", "sprocket", "--all", "--since", "1y", "--limit", "1"], "hits", 4],
      [["recall", RECALL_PHRASE, "--since", "1y", "--limit", "1"], "sessions", 3],
      [["sessions", "--all", "--limit", "1"], "sessions", 3],
    ];
    for (const [args, key, n] of cases) {
      const r = await run([...args, "--json-out"], opts);
      expect(r.exitCode, args.join(" ")).toBe(0);
      const path = target(r.stdout);
      expect(r.stdout.indexOf("json_out:")).toBeLessThan(r.stdout.indexOf("help["));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
      const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown[]>;
      expect(doc[key], args.join(" ")).toHaveLength(n);
    }
  });

  it("ids print as listed and texts whole; =path writes there; a missing directory is VALIDATION_ERROR before any read", async () => {
    const path = join(tmp, "json", "out.json");
    const r = await run(["tools", "d1000031", `--json-out=${path}`], opts);
    expect(target(r.stdout)).toBe(path);
    const doc = JSON.parse(readFileSync(path, "utf8")) as { tools: Array<{ call: { id: string }; result: { text: string } }> };
    expect(doc.tools[0]!.call.id).toBe("d1000031:3");
    expect(doc.tools[0]!.result.text).toBe("torque table: 12 rows, all within bounds");
    const bad = await run(["events", "d1000031", "--json-out=/nonexistent-dir/x.json"], opts);
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    // The bare form never takes the next argument as its path.
    const bare = await run(["find", "--json-out", RECALL_PHRASE], opts);
    expect(bare.exitCode).toBe(0);
    expect(target(bare.stdout)).toMatch(/find\.json$/);
  });
});
