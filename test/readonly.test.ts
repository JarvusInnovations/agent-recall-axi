import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listEvents } from "../src/lib/events.js";
import { allProjects } from "../src/lib/scope.js";
import { describeSession, sessionListing, openSession } from "../src/lib/session.js";
import { claudeCode } from "../src/lib/adapters/claude-code/index.js";
import { FIXTURE_ROOT } from "./fixtures/build.js";
import { run } from "./helpers/run.js";

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        out.set(`${p}/`, `${st.mtimeMs}`);
        walk(p);
      } else {
        out.set(p, `${st.mtimeMs}:${st.size}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
      }
    }
  };
  walk(dir);
  return out;
}

describe("privacy: read-only", () => {
  it("opening every fixture through the adapter and the CLI changes nothing under the log root", async () => {
    const before = snapshot(FIXTURE_ROOT);
    const env = { CLAUDE_CONFIG_DIR: FIXTURE_ROOT };
    for (const project of await allProjects(join(FIXTURE_ROOT, "projects"))) {
      for await (const s of claudeCode.listSessions(project, { subagents: true })) {
        const session = await openSession(s.path);
        await describeSession(session);
        await listEvents(session, { kinds: "all", limit: 0 });
        await listEvents(session, { limit: 3 });
        await run(["events", s.path, "--kind", "all"]);
        await run(["tail", s.path]);
        for (const seq of ["1", "2", "3"]) {
          await run(["show", seq, "--session", s.path, "--full"]);
          await run(["show", seq, "--session", s.path, "--raw"]);
        }
      }
    }
    await sessionListing({ env, project: "all", subagents: true }, { limit: 0 });
    await run(["sessions", "--all", "--subagents"]);
    await run([]);
    await run(["tail", "latest"]);
    expect(snapshot(FIXTURE_ROOT)).toEqual(before);
  });
});
