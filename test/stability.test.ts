import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatId, resolveId } from "../src/lib/ids.js";
import { show } from "../src/lib/events.js";
import { checkRewrite } from "../src/lib/cache/store.js";
import { FIXTURE_ROOT, fixtureUuid } from "./fixtures/build.js";
import { run } from "./helpers/run.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-stability-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const root = join(tmp, "root");
cpSync(FIXTURE_ROOT, root, { recursive: true });
const dir = join(root, "projects", "-src-widget");
const file = join(dir, "a3000003-0000-4000-8000-000000000000.jsonl");
const env = { CLAUDE_CONFIG_DIR: root, XDG_CACHE_HOME: join(tmp, "cache") };
const scope = { env, cwd: "/src/widget" };

/** 500 synthetic lines: prompts, replies, calls and results, a result for the pending call, and a compaction. */
function appended(): string {
  const lines: string[] = [];
  let n = 1000;
  let clock = Date.parse("2026-11-07T15:00:00.000Z");
  const env = (type: string, body: Record<string, unknown>) => {
    clock += 1000;
    return JSON.stringify({ type, ...body, uuid: fixtureUuid("a3000003", ++n), timestamp: new Date(clock).toISOString(), cwd: "/src/widget", sessionId: fixtureUuid("a3000003", 0) });
  };
  // The call that was pending gets its result now.
  lines.push(env("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fxa30000030004", content: "edited", is_error: false }] } }));
  let t = 0;
  while (lines.length < 497) {
    t++;
    const tid = `toolu_fxappend${String(t).padStart(6, "0")}`;
    lines.push(env("user", { message: { role: "user", content: `appended prompt ${t}` }, origin: { kind: "human" } }));
    lines.push(env("assistant", { message: { role: "assistant", content: [{ type: "tool_use", id: tid, name: "Bash", input: { command: `echo ${t}` } }] } }));
    lines.push(env("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: `${t}`, is_error: false }] } }));
    lines.push(env("assistant", { message: { role: "assistant", content: [{ type: "text", text: `step ${t} done` }] } }));
  }
  lines.length = 497;
  lines.push(env("system", { subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: 500_000, postTokens: 20_000 } }));
  lines.push(env("user", { message: { role: "user", content: "This session is being continued from a previous conversation. Summary: appended steps." }, isCompactSummary: true }));
  lines.push(JSON.stringify({ type: "last-prompt", lastPrompt: "appended", sessionId: fixtureUuid("a3000003", 0) }));
  expect(lines).toHaveLength(500);
  return `${lines.join("\n")}\n`;
}

async function snapshot(ids: string[]) {
  const out = new Map<string, string>();
  for (const text of ids) {
    const { session, id } = await resolveId(text, scope);
    const shown = await show(session, id);
    out.set(text, JSON.stringify({ seq: shown.entry.seq, raw: shown.entry.raw, line: shown.line, events: shown.events.map((e) => [formatId(e.event.id), e.event.kind, e.event.text]) }));
  }
  return out;
}

describe("id stability", () => {
  it("every printed id resolves to the same entry after 500 appended lines and a rewritten index", async () => {
    const listed = await run(["events", "a3000003", "--kind", "all", "--limit", "0"], { env });
    const ids = [...listed.stdout.matchAll(/^ {2}"(a3000003:[0-9.]+)"/gm)].map((m) => m[1]!);
    expect(ids.length).toBe(10);
    // Silent and entry-form ids too: every seq of the file.
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    for (let seq = 1; seq <= lines; seq++) ids.push(`a3000003:${seq}`);
    const before = await snapshot(ids);

    appendFileSync(file, appended());
    writeFileSync(join(dir, "sessions-index.json"), JSON.stringify({ version: 1, entries: [], originalPath: "/src/widget" }) + "\n");

    const after = await snapshot(ids);
    for (const id of ids) expect(after.get(id), id).toBe(before.get(id));
    const relisted = await run(["events", "a3000003", "--kind", "all", "--to", "a3000003:11", "--limit", "0"], { env });
    expect([...relisted.stdout.matchAll(/^ {2}"(a3000003:[0-9.]+)"/gm)].map((m) => m[1]!)).toEqual(ids.slice(0, 10));
    // An append is not a rewrite.
    expect(relisted.stdout).not.toMatch(/^notice:/m);
    // The new compaction is addressable at its seq.
    const c = await run(["show", `a3000003:${lines + 498}`], { env });
    expect(c.stdout).toMatch(/^kind: compaction$/m);
  });

  it("a file shortened in place prints the rewrite notice exactly once", async () => {
    const first = await run(["tail", "a3000003", "3"], { env });
    expect(first.stdout).not.toMatch(/^notice:/m);
    const size = readFileSync(file).length;
    const text = readFileSync(file, "utf8");
    const lastLine = text.slice(text.lastIndexOf("\n", text.length - 2) + 1);
    truncateSync(file, size - Buffer.byteLength(lastLine));
    const second = await run(["tail", "a3000003", "3"], { env });
    expect(second.stdout).toMatch(/^notice: "session file was rewritten since 2026-11-07 14:00:00; ids printed earlier may have moved"$/m);
    expect(second.stdout.match(/^notice:/gm)).toHaveLength(1);
    const third = await run(["tail", "a3000003", "3"], { env });
    expect(third.stdout).not.toMatch(/^notice:/m);
    const shown = await run(["show", "a3000003:1"], { env });
    expect(shown.stdout).not.toMatch(/^notice:/m);
    // A NOT_FOUND after a rewrite still carries the notice.
    const lastSeq = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    truncateSync(file, readFileSync(file).length - Buffer.byteLength(readFileSync(file, "utf8").split("\n").filter(Boolean).at(-1)! + "\n"));
    const gone = await run(["show", `a3000003:${lastSeq}`], { env });
    expect(gone.exitCode).toBe(1);
    expect(gone.stdout).toMatch(/^code: NOT_FOUND$/m);
    expect(gone.stdout).toContain("session file was rewritten since");
  });

  it("a same-length rewrite of the last read line is caught too; a missing cache dir is no error", async () => {
    const cache = { dir: join(tmp, "cache2") };
    const f = join(tmp, "rewrite.jsonl");
    writeFileSync(f, '{"type":"user","n":1}\n{"type":"user","n":2}\n');
    expect(await checkRewrite(f, cache)).toEqual({ rewritten: false });
    writeFileSync(f, '{"type":"user","n":1}\n{"type":"user","n":3}\n');
    expect((await checkRewrite(f, cache)).rewritten).toBe(true);
    expect((await checkRewrite(f, cache)).rewritten).toBe(false);
    appendFileSync(f, '{"type":"user","n":4}\n');
    expect((await checkRewrite(f, cache)).rewritten).toBe(false);
    // An empty file that gains its first line, and a partial first line that completes, are appends.
    const g = join(tmp, "growing.jsonl");
    writeFileSync(g, "");
    expect((await checkRewrite(g, cache)).rewritten).toBe(false);
    appendFileSync(g, '{"type":"user",');
    expect((await checkRewrite(g, cache)).rewritten).toBe(false);
    appendFileSync(g, '"n":1}\n');
    expect((await checkRewrite(g, cache)).rewritten).toBe(false);
    appendFileSync(g, '{"type":"user","n":2}\n');
    expect((await checkRewrite(g, cache)).rewritten).toBe(false);
    // …but once the first line is complete, changing it is a rewrite.
    writeFileSync(g, '{"type":"user","n":9}\n{"type":"user","n":2}\n');
    expect((await checkRewrite(g, cache)).rewritten).toBe(true);
    // An unwritable cache location behaves like no cache.
    writeFileSync(join(tmp, "not-a-dir"), "");
    expect(await checkRewrite(f, { dir: join(tmp, "not-a-dir", "cache") })).toEqual({ rewritten: false });
  });
});
