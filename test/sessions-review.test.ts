/**
 * PR #16 review round (plan sessions-and-recall): one test per finding a test can observe.
 */
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { homeListing } from "../src/lib/home.js";
import { FIXTURE_ROOT, recallSessions, writeGenerated } from "./fixtures/build.js";
import { run } from "./helpers/run.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-review16-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const NOW = new Date("2026-11-07T14:00:00.000Z");

function sandbox(name: string): { root: string; cache: string; dir: string; env: Record<string, string> } {
  const root = join(tmp, name, "claude");
  const cache = join(tmp, name, "cache");
  const dir = join(root, "projects", "-src-widget");
  mkdirSync(dir, { recursive: true });
  return { root, cache, dir, env: { CLAUDE_CONFIG_DIR: root, XDG_CACHE_HOME: cache, TMPDIR: join(tmp, name) } };
}

const line = (o: Record<string, unknown>) => JSON.stringify({ cwd: "/src/widget", sessionId: "s", ...o }) + "\n";
const human = (text: string, n: number, ts = `2026-11-07T13:${String(10 + n).padStart(2, "0")}:00.000Z`) =>
  line({ type: "user", message: { role: "user", content: text }, origin: { kind: "human" }, uuid: `h${n}`, timestamp: ts });
const body = (out: string) => decode(out.split(/^(help\[|json_out:)/m)[0]!) as Record<string, unknown>;

describe("1. the term index keeps no word order", () => {
  it("its tokens are stored sorted, whatever order the text wrote them in", async () => {
    const box = sandbox("terms-order");
    writeFileSync(join(box.dir, "d9000039-0000-4000-8000-000000000000.jsonl"), human("my zeta password is hunter2 alpha", 1));
    await run(["recall", "zeta", "--since", "1y"], { env: box.env, now: NOW });
    const dir = join(box.cache, "agent-session-axi", "terms");
    const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")) as { terms: Array<[string, number[]]> };
    const toks = rec.terms.map(([t]) => t);
    expect(toks).toEqual([...toks].sort());
  });
});

describe("2. --json-out=path never follows a symlink and refuses what is not the user's regular file", () => {
  it("a symlink is VALIDATION_ERROR, checked before any log is read, and its target is untouched", async () => {
    const box = sandbox("json-link");
    const target = join(box.root, "precious.txt");
    writeFileSync(target, "keep me\n");
    const link = join(box.root, "out.json");
    symlinkSync(target, link);
    // A session that does not exist: the export path must fail first (no read happened).
    const r = await run(["events", "deadbeef", `--json-out=${link}`], { env: box.env, now: NOW });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    expect(readFileSync(target, "utf8")).toBe("keep me\n");
    expect(statSync(target).mode & 0o777).not.toBe(0o600);
    const asDir = await run(["events", "deadbeef", `--json-out=${box.root}`], { env: box.env, now: NOW });
    expect(asDir.exitCode).toBe(2);
    expect(asDir.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
  });
});

describe("3. the cold home view never counts a file from its start", () => {
  it("without cached line numbers last_human has no id and the tail hint says it gives ids; with them, the id is back", async () => {
    const box = sandbox("home-cold");
    writeFileSync(join(box.dir, "d9100039-0000-4000-8000-000000000000.jsonl"), human("first", 1) + human("the last prompt", 2));
    const cold = await run([], { env: box.env, now: NOW });
    expect(body(cold.stdout).last_human).toBe('13:12:00 "the last prompt"');
    expect(cold.stdout).toContain("Run `agent-session-axi tail d9100039` for the last 20 rows with their ids");
    await run(["sessions"], { env: box.env, now: NOW });
    const warm = await run([], { env: box.env, now: NOW });
    expect(body(warm.stdout).last_human).toBe('d9100039:2 13:12:00 "the last prompt"');
  });

  it("extending cached stats spends at most 8 MB of appended lines across the whole listing", async () => {
    const box = sandbox("home-budget");
    const ids = ["d9200001", "d9200002", "d9200003", "d9200004"];
    for (const [i, id] of ids.entries()) writeFileSync(join(box.dir, `${id}-0000-4000-8000-000000000000.jsonl`), human(`session ${i}`, i));
    await run(["sessions"], { env: box.env, now: NOW });
    const filler = human(`pad ${"x".repeat(1 << 20)}`, 9);
    for (const id of ids) for (let k = 0; k < 3; k++) appendFileSync(join(box.dir, `${id}-0000-4000-8000-000000000000.jsonl`), filler);
    const l = await homeListing({ env: box.env, cwd: "/src/widget" }, { cache: { env: box.env } });
    // 3 MB per session: two fit in 8 MB, the others fall back to the cheap sources.
    expect(l.sessions.filter((s) => s.source === "stats")).toHaveLength(2);
  });
});

describe("4. the term index survives another command extending the table", () => {
  it("append, then sessions, then recall: partial, and the new hit is found", async () => {
    const box = sandbox("terms-extend");
    // One session, so the header's index state is that session's own.
    writeGenerated(box.root, recallSessions().slice(0, 1));
    const opts = { env: box.env, now: NOW };
    expect(body((await run(["recall", "sprocket rebalance", "--since", "1y"], opts)).stdout).index).toBe("none");
    const path = join(box.root, "projects", "-src-gadget", "d1000031-0000-4000-8000-000000000000.jsonl");
    appendFileSync(path, human("another sprocket rebalance", 30, "2026-11-07T10:05:00.000Z"));
    await run(["sessions", "--all"], opts);
    const r = await run(["recall", "sprocket rebalance", "--since", "1y"], opts);
    expect(body(r.stdout).index).toBe("partial");
    expect((body(r.stdout).sessions as Array<{ id: string; hits: number }>)[0]).toMatchObject({ id: "d1000031", hits: 3 });
    // Extended, not rebuilt: the record still holds the tokens it had and gained the new line's.
    const dir = join(box.cache, "agent-session-axi", "terms");
    const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")) as { terms: Array<[string, number[]]> };
    expect(new Map(rec.terms).get("another")).toEqual([6]);
  });
});

describe("6. --json-out converts only id fields", () => {
  it("a call input shaped like an id stays an object", async () => {
    const box = sandbox("json-shape");
    const id = "d9300039-0000-4000-8000-000000000000";
    const call = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x1", name: "Probe", input: { session: "abcdef12", seq: 3 } }] }, uuid: "a1", timestamp: "2026-11-07T13:00:01.000Z" });
    writeFileSync(join(box.dir, `${id}.jsonl`), human("probe it", 1) + call);
    const r = await run(["events", "d9300039", "--json-out"], { env: box.env, now: NOW });
    const path = /^json_out: (.+)$/m.exec(r.stdout)![1]!;
    const doc = JSON.parse(readFileSync(path, "utf8")) as { events: Array<{ kind: string; input?: unknown }> };
    expect(doc.events.find((e) => e.kind === "call")!.input).toEqual({ session: "abcdef12", seq: 3 });
  });
});

describe("7. single-session headers carry the cheap, deterministic title", () => {
  it("custom-title.json, else the first human prompt, else (untitled); cold and warm print the same", async () => {
    const box = sandbox("headers");
    cpSync(join(FIXTURE_ROOT, "projects", "-src-widget"), box.dir, { recursive: true });
    const opts = { env: box.env, now: NOW };
    for (const [args, re] of [
      [["events", "e1000018"], /^session: e1000018 the deploy keeps hitting the old redirect after login$/m],
      [["tail", "ae00000e"], /^session: ae00000e gadget survey$/m],
      [["turns", "e1000018"], /^session: e1000018 the deploy/m],
      [["find", "e1000018", "redirect"], /^scope: e1000018 the deploy/m],
      [["around", "e1000018:4"], /^session: e1000018 the deploy/m],
      [["tail", "af00000f"], /^session: af00000f \(untitled\)$/m],
    ] as Array<[string[], RegExp]>) {
      const cold = await run(args, opts);
      expect(cold.stdout, args.join(" ")).toMatch(re);
      expect(cold.stdout).not.toContain("title pending");
      expect((await run(args, opts)).stdout, args.join(" ")).toBe(cold.stdout);
    }
  });
});

describe("10. cross-session find widens even with an explicit window", () => {
  it("--all --since 30d with no hits hints --since 1y", async () => {
    const box = sandbox("widen");
    writeGenerated(box.root, recallSessions());
    const r = await run(["find", "nothing like this", "--all", "--since", "30d"], { env: box.env, now: NOW });
    expect(r.stdout).toContain("Run `agent-session-axi find 'nothing like this' --all --since 1y`");
  });
});

describe("13. --json-out <file>.json in the space form", () => {
  it("says to write --json-out=<file>.json", async () => {
    const r = await run(["events", "e1000018", "--json-out", "out.json"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("--json-out=out.json");
  });
});

describe("15. titles and record hygiene", () => {
  it("an empty last ai-title or custom-title falls through to the next source", async () => {
    const box = sandbox("empty-title");
    const silent = (o: Record<string, unknown>) => JSON.stringify({ sessionId: "s", ...o }) + "\n";
    writeFileSync(join(box.dir, "d9400001-0000-4000-8000-000000000000.jsonl"), silent({ type: "ai-title", aiTitle: "old ai title" }) + human("the prompt", 1) + silent({ type: "ai-title", aiTitle: "" }));
    writeFileSync(join(box.dir, "d9400002-0000-4000-8000-000000000000.jsonl"), silent({ type: "ai-title", aiTitle: "ai title" }) + silent({ type: "custom-title", customTitle: "mine" }) + human("p", 1) + silent({ type: "custom-title", customTitle: "" }));
    const r = await run(["sessions"], { env: box.env, now: NOW });
    const rows = Object.fromEntries((body(r.stdout).sessions as Array<{ id: string; title: string }>).map((x) => [x.id, x.title]));
    expect(rows).toEqual({ d9400001: "the prompt", d9400002: "ai title" });
  });

  it("a --regex recall over an unchanged, indexed session rewrites no record", async () => {
    const box = sandbox("regex-norewrite");
    writeGenerated(box.root, recallSessions());
    const opts = { env: box.env, now: NOW };
    await run(["recall", "sprocket", "--since", "1y"], opts);
    const base = join(box.cache, "agent-session-axi");
    const stamp = () => ["index", "terms"].flatMap((d) => readdirSync(join(base, d)).map((f) => `${d}/${f}:${statSync(join(base, d, f)).mtimeMs}`)).sort();
    const before = stamp();
    await new Promise((r) => setTimeout(r, 20));
    const re = await run(["recall", "sprocket\\s+rebalance", "--regex", "--since", "1y"], opts);
    expect((body(re.stdout).sessions as unknown[]).length).toBe(3);
    expect(stamp()).toEqual(before);
  });
});
