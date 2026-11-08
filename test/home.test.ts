/** The home view (plan sessions-and-recall; specs/cli.md#home-view-no-arguments), non-hook mode. */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { manySessions, writeGenerated } from "./fixtures/build.js";
import { run } from "./helpers/run.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-home-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function sandbox(name: string): { root: string; env: Record<string, string> } {
  const root = join(tmp, name, "claude");
  mkdirSync(join(root, "projects"), { recursive: true });
  return { root, env: { CLAUDE_CONFIG_DIR: root, XDG_CACHE_HOME: join(tmp, name, "cache") } };
}

const body = (out: string) => decode(out.split(/^help\[/m)[0]!) as Record<string, unknown>;
const helpLines = (out: string) => out.split(/^help\[\d+\]:\n/m)[1]!.trimEnd().split("\n");

describe("home view", () => {
  const box = sandbox("project");
  const files = manySessions(8);
  writeGenerated(box.root, files);
  const NOW = new Date("2026-11-01T08:30:00.000Z");

  it("prints project:, five sessions newest first, latest, last_human with id and time, and five help lines", async () => {
    const r = await run([], { env: box.env, now: NOW });
    expect(r.exitCode).toBe(0);
    const b = body(r.stdout);
    expect(b.project).toBe("/src/widget (8 sessions)");
    const rows = b.sessions as Array<Record<string, unknown>>;
    expect(rows.map((x) => x.id)).toEqual(["dd000007", "dd000006", "dd000005", "dd000004", "dd000003"]);
    expect(r.stdout).toContain("sessions[5]{id,last,turns,title}:");
    expect(b.latest).toBe("dd000007");
    // The newest human prompt of the latest file, its time on today's date; cold, the cache cannot
    // number its line, so no id (the home view never counts a whole file) and tail is offered for ids.
    expect(b.last_human).toMatch(/^07:00:3\d "session 7 step 4: widget gadget/);
    expect(r.stdout).toContain("tail dd000007` for the last 20 rows with their ids");
    expect(helpLines(r.stdout)).toHaveLength(5);
    // Cold: no cached stats, so turns is empty and the title comes from the file's head.
    expect(rows[0]).toMatchObject({ turns: "", title: expect.stringMatching(/^session 7 step 0: /) });
    for (const h of helpLines(r.stdout).map((l) => /`agent-session-axi ([^`]*)`/.exec(l)![1]!)) {
      if (h.includes("<")) continue;
      expect((await run(h.split(" "), { env: box.env, now: NOW })).exitCode, h).toBe(0);
    }
  });

  it("once sessions has run, rows carry the exact turns and last from the cached stats", async () => {
    await run(["sessions"], { env: box.env, now: NOW });
    const rows = body((await run([], { env: box.env, now: NOW })).stdout).sessions as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ id: "dd000007", turns: 5 });
    // With the cache's line numbers, last_human carries its id.
    expect(body((await run([], { env: box.env, now: NOW })).stdout).last_human).toMatch(/^dd000007:17 07:00:3\d "session 7 step 4: /);
    expect(String(rows[0]!.last)).toMatch(/^11-01 07:00 /);
  });

  it("uses sessions-index.json for title and last only while its fileMtime matches", async () => {
    const b2 = sandbox("indexed");
    const files2 = manySessions(2);
    writeGenerated(b2.root, files2);
    const dir = join(b2.root, "projects", "-src-widget");
    const id = "dd000001-0000-4000-8000-000000000000";
    const mtime = statSync(join(dir, `${id}.jsonl`)).mtimeMs;
    const index = (fileMtime: number) =>
      writeFileSync(join(dir, "sessions-index.json"), JSON.stringify({ version: 1, entries: [{ sessionId: id, fileMtime, summary: "indexed widget title", modified: "2026-11-01T01:05:00.000Z", messageCount: 99 }] }));
    index(mtime);
    let rows = body((await run([], { env: b2.env, now: NOW })).stdout).sessions as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ id: "dd000001", title: "indexed widget title", turns: "" });
    expect(String(rows[0]!.last)).toMatch(/^11-01 01:05 /);
    index(mtime - 5000);
    rows = body((await run([], { env: b2.env, now: NOW })).stdout).sessions as Array<Record<string, unknown>>;
    expect(rows[0]!.title).toMatch(/^session 1 step 0: /);
  });

  it("with no project for the cwd: project: none and five sessions across projects", async () => {
    const r = await run([], { env: box.env, now: NOW, cwd: "/elsewhere" });
    const b = body(r.stdout);
    expect(b.project).toBe("none for /elsewhere");
    expect((b.sessions as unknown[]).length).toBe(5);
    expect(helpLines(r.stdout)).toHaveLength(5);
    expect(r.stdout).toContain("sessions --project <path>");
    expect(r.stdout).toContain("tail dd000007 --all");
  });

  it("last_human says none when the session has no human message, and names the bound when it stops at 4 MB", async () => {
    const b3 = sandbox("no-human");
    const dir = join(b3.root, "projects", "-src-widget");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "dd00ffff-0000-4000-8000-000000000000.jsonl");
    const line = (n: number) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `filler ${n} ${"x".repeat(2000)}` }] }, uuid: `u${n}`, timestamp: "2026-11-01T01:00:00.000Z", cwd: "/src/widget" }) + "\n";
    writeFileSync(path, line(0));
    expect(body((await run([], { env: b3.env, now: NOW })).stdout).last_human).toBe("none");
    writeFileSync(path, JSON.stringify({ type: "user", message: { role: "user", content: "an early prompt" }, origin: { kind: "human" }, uuid: "h", timestamp: "2026-11-01T00:59:00.000Z", cwd: "/src/widget" }) + "\n");
    let chunk = "";
    for (let i = 0; i < 2200; i++) chunk += line(i);
    appendFileSync(path, chunk);
    expect(body((await run([], { env: b3.env, now: NOW })).stdout).last_human).toBe("none in the last 4M");
  });
});
