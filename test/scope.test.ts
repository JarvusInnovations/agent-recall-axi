import { describe, expect, it } from "vitest";
import { resolveScope } from "../src/lib/scope.js";
import { describeSession, openSession, sessionListing } from "../src/lib/session.js";
import { AgentSessionError } from "../src/lib/errors.js";
import { FIXTURE_ROOT } from "./fixtures/build.js";
import { fx } from "./helpers/run.js";

const env = { CLAUDE_CONFIG_DIR: FIXTURE_ROOT };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof AgentSessionError ? err.code : String(err);
  }
}

describe("scope", () => {
  it("cwd → project by the entries' cwd, nearest ancestor first", async () => {
    const s = await resolveScope({ env, cwd: "/src/widget" });
    expect(s.projects.map((p) => p.cwd)).toEqual(["/src/widget"]);
    expect(s.projects[0]!.cwdFromEntry).toBe(true);
    const deep = await resolveScope({ env, cwd: "/src/widget/lib/deep" });
    expect(deep.projects[0]!.cwd).toBe("/src/widget");
  });

  it("no project for the cwd → NO_SESSIONS", async () => {
    expect(await code(resolveScope({ env, cwd: "/elsewhere" }))).toBe("NO_SESSIONS");
  });

  it("--project accepts a path, an encoded name, or a unique substring", async () => {
    expect((await resolveScope({ env, project: "/src/gadget" })).projects[0]!.cwd).toBe("/src/gadget");
    expect((await resolveScope({ env, project: "-src-gadget" })).projects[0]!.cwd).toBe("/src/gadget");
    expect((await resolveScope({ env, project: "widg" })).projects[0]!.cwd).toBe("/src/widget");
    expect(await code(resolveScope({ env, project: "dget" }))).toBe("VALIDATION_ERROR");
    expect(await code(resolveScope({ env, project: "/nonexistent" }))).toBe("NO_SESSIONS");
  });

  it("--all spans every project", async () => {
    const s = await resolveScope({ env, project: "all" });
    expect(s.projects.map((p) => p.cwd)).toEqual(["/src/gadget", "/src/widget"]);
  });

  it("lists sessions newest first; subagents only on request; the stale index entry is ignored", async () => {
    const main = await sessionListing({ env, cwd: "/src/widget" }, { limit: 0 });
    expect(main.sessions.every((s) => s.kind === "main")).toBe(true);
    expect(main.sessions.some((s) => s.id.startsWith("deadbeef"))).toBe(false);
    expect(main.sessions[0]!.short).toBe("b1000011"); // the two-day fixture ends last
    const withSubs = await sessionListing({ env, cwd: "/src/widget", subagents: true }, { limit: 0 });
    const sub = withSubs.sessions.find((s) => s.kind === "subagent")!;
    expect(sub.short).toBe("ae0f1e2d");
    expect(sub.parent).toMatch(/^ae00000e-/);
    const windowed = await sessionListing({ env, project: "all" }, { from: new Date("2026-11-07T00:00:00Z"), to: new Date("2026-11-07T23:00:00Z"), limit: 0 });
    expect(windowed.sessions.some((s) => s.short === "c1000013")).toBe(false);
    expect(windowed.sessions.some((s) => s.short === "b1000011")).toBe(false);
  });

  it("started and last come from each entry's own timestamp, not one nested in its payload", async () => {
    // The first entry's attachment and the last entry's tool input carry their own `timestamp`
    // fields, written ahead of the entry's.
    const info = await describeSession(await openSession(fx("authority-edges")));
    expect(info.started).toBe("2026-11-07T13:40:02.000Z");
    expect(info.last).toBe("2026-11-07T13:40:24.000Z");
  });
});
