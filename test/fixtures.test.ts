import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildFixtures, FIXTURE_ROOT, fixtures } from "./fixtures/build.js";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), "asa-fixtures-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("fixtures", () => {
  it("regenerating them yields identical bytes and no extra files", () => {
    buildFixtures(tmp);
    const fresh = walk(join(tmp, "projects")).map((p) => relative(tmp, p)).sort();
    const committed = walk(join(FIXTURE_ROOT, "projects")).map((p) => relative(FIXTURE_ROOT, p)).sort();
    expect(fresh).toEqual(committed);
    for (const rel of fresh) {
      expect(readFileSync(join(tmp, rel)).equals(readFileSync(join(FIXTURE_ROOT, rel))), rel).toBe(true);
    }
  });

  it("has one file per shape in architecture.md#fixtures", () => {
    const names = fixtures().map((f) => f.name);
    for (const shape of [
      "string-content",
      "array-content",
      "parallel-tools",
      "persisted-output",
      "persisted-missing",
      "compaction",
      "compaction-legacy",
      "queued-command",
      "slash-command",
      "hooks",
      "skill",
      "notices",
      "thinking",
      "subagent",
      "silent",
      "out-of-order",
      "two-day",
      "question",
      "gadget",
      "multi-block",
      "long-text",
      "seven-a",
      "eight-b",
    ]) {
      expect(names).toContain(shape);
    }
    expect(statSync(join(FIXTURE_ROOT, "projects", "-src-widget", "sessions-index.json")).isFile()).toBe(true);
    expect(statSync(join(FIXTURE_ROOT, "projects", "-src-gadget")).isDirectory()).toBe(true);
  });

  it("contain no real-world markers", () => {
    const deny = [
      /\/home\/[a-z]/i, // home paths with usernames
      /\/Users\/[a-z]/i,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email addresses
      /claude-\d+\//, // per-user temp dirs
      /msg_01|toolu_01|req_01/, // ids in the shape real logs mint
    ];
    for (const file of walk(FIXTURE_ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const re of deny) expect(re.test(text), `${relative(FIXTURE_ROOT, file)} matches ${re}`).toBe(false);
    }
  });
});
