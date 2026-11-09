import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsePointer } from "../src/lib/adapters/claude-code/classify.js";
import { readPointer } from "../src/lib/events.js";
import { openSession } from "../src/lib/session.js";
import { run } from "./helpers/run.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-pointer-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const S8 = "d1000017";
const ID = `${S8}-0000-4000-8000-000000000000`;
const root = join(tmp, "root");
const dir = join(root, "projects", "-src-widget");
const sidecar = join(dir, ID);
const outside = join(tmp, "outside");
mkdirSync(join(sidecar, "tool-results"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET-CONTENT\n");
writeFileSync(join(sidecar, "tool-results", "inside.txt"), "INSIDE-CONTENT\n");
symlinkSync(join(outside, "secret.txt"), join(sidecar, "tool-results", "link.txt"));

let n = 0;
const line = (type: string, body: Record<string, unknown>) =>
  JSON.stringify({ type, ...body, uuid: `${S8}-0000-4000-8000-${String(++n).padStart(12, "0")}`, timestamp: `2026-11-07T13:40:${String(n).padStart(2, "0")}.000Z`, cwd: "/src/widget", sessionId: ID });
const call = (i: number) => line("assistant", { message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_fxptr${i}`, name: "Bash", input: { command: `cat f${i}` } }] } });
const result = (i: number, text: string) => line("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_fxptr${i}`, content: text, is_error: false }] } });
const wrapped = (path: string) => `<persisted-output>\nOutput too large (1.0KB). Full output saved to: ${path}\n\nPreview (first 2KB):\npreview text\n...\n</persisted-output>`;
const lines = [
  line("user", { message: { role: "user", content: "read some files" }, origin: { kind: "human" } }),
  call(1),
  // seq 3: the sentence quoted in the middle of an ordinary result: not a notice.
  result(1, `the docs say: Output too large (1KB). Full output saved to: ${join(outside, "secret.txt")}\nand more`),
  call(2),
  result(2, wrapped(join(outside, "secret.txt"))), // seq 5: wrapped, but outside the sidecar
  call(3),
  result(3, wrapped(join(sidecar, "tool-results", "link.txt"))), // seq 7: a symlink out of tool-results
  call(4),
  result(4, wrapped("/dev/zero")), // seq 9: a device, never read
  call(5),
  result(5, wrapped(join(sidecar, "tool-results", "inside.txt"))), // seq 11: contained
];
const file = join(dir, `${ID}.jsonl`);
writeFileSync(file, `${lines.join("\n")}\n`);
const env = { CLAUDE_CONFIG_DIR: root };

describe("persisted-output pointers", () => {
  it("an unwrapped notice counts only when it opens the text", () => {
    expect(parsePointer(`see: Output too large (1KB). Full output saved to: /x/y.txt`)).toBeUndefined();
    expect(parsePointer(`Output too large (1KB). Full output saved to: /x/y.txt\n\nPreview (first 2KB):\nabc`)?.stored).toBe("/x/y.txt");
    expect(parsePointer(wrapped("/x/y.txt"))?.stored).toBe("/x/y.txt");
  });

  it("a quoted notice in a result is plain text", async () => {
    const r = await run(["show", `${S8}:3`], { env });
    expect(r.stdout).not.toMatch(/^pointer:/m);
    expect(r.stdout).toMatch(/^text: "the docs say:/m);
  });

  it("--full follows only a regular file inside <sidecar>/tool-results/", async () => {
    for (const seq of [5, 7, 9]) {
      const r = await run(["show", `${S8}:${seq}`, "--full"], { env });
      expect(r.exitCode, `seq ${seq}`).toBe(0);
      expect(r.stdout).not.toContain("OUTSIDE-SECRET-CONTENT");
      expect(r.stdout).toMatch(/^followed: false$/m);
      expect(r.stdout).toMatch(/^reason: /m);
      expect(r.stdout).toMatch(/^preview: preview text$/m);
      const plain = await run(["show", `${S8}:${seq}`], { env });
      expect(plain.stdout).not.toContain("for the persisted output");
      expect(plain.stdout).toMatch(/^followed: false$/m);
    }
    const ok = await run(["show", `${S8}:11`, "--full"], { env });
    expect(ok.stdout).toMatch(/^text: "INSIDE-CONTENT\\n"$/m);
    expect(ok.stdout).not.toMatch(/^followed:/m);
  });

  it("readPointer refuses what is not contained", async () => {
    const session = await openSession(file);
    const p = parsePointer(wrapped(join(outside, "secret.txt")), session.sidecar)!;
    const r = await readPointer(p, session);
    expect(r.followed).toBe(false);
    expect(r.text).toBe("preview text");
    const dev = await readPointer(parsePointer(wrapped("/dev/zero"), session.sidecar)!, session);
    expect(dev.followed).toBe(false);
  });
});
