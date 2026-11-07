import { describe, expect, it } from "vitest";
import { run } from "./helpers/run.js";

/** Every `Run \`agent-session-axi …\`` hint in an output, as argv. */
function hints(out: string): string[][] {
  return [...out.matchAll(/Run `agent-session-axi ([^`]*)`/g)].map((m) => m[1]!.split(" "));
}

const cwd = "/src/sprocket";
const FULL = "c3b5d7e9-ffff-4000-8000-000000000000";

describe("hints when an <s8> is shared in scope", () => {
  it("events/tail hints name the session by its full id, and every hint runs", async () => {
    const tail = await run(["tail", "c3b5d7e9-ffff", "1"], { cwd });
    expect(tail.exitCode).toBe(0);
    const hs = hints(tail.stdout);
    expect(hs.length).toBeGreaterThan(0);
    expect(tail.stdout).toContain(`events ${FULL} --to c3b5d7e9:2`);
    expect(tail.stdout).toContain(`show c3b5d7e9:2 --session ${FULL}`);
    for (const h of hs) {
      const r = await run(h, { cwd });
      expect(r.exitCode, h.join(" ")).toBe(0);
    }
  });

  it("sessions and the home view hint `tail <uuid>` for a shared <s8>", async () => {
    for (const args of [["sessions"], []]) {
      const out = await run(args, { cwd });
      const tail = hints(out.stdout).find((h) => h[0] === "tail")!;
      expect(tail[1], args.join(" ")).toMatch(/^c3b5d7e9-(0000|ffff)-4000-8000-000000000000$/);
      expect((await run(tail, { cwd })).exitCode).toBe(0);
    }
  });

  it("an ambiguous id suggests --session <uuid> per candidate", async () => {
    const r = await run(["show", "c3b5d7e9:1"], { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^code: AMBIGUOUS_SESSION$/m);
    expect(r.stdout).not.toContain("more characters");
    for (const id of ["c3b5d7e9-0000-4000-8000-000000000000", FULL]) expect(r.stdout).toContain(`--session ${id}`);
  });

  it("a unique <s8> stays short", async () => {
    const r = await run(["tail", "c2a4e6f1", "1"], { cwd });
    expect(r.stdout).toContain("events c2a4e6f1 --to c2a4e6f1:2");
  });
});
