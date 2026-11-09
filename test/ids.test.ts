import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { AgentSessionError } from "../src/lib/errors.js";
import { formatId, parseBareSeq, parseId, resolveId, resolveSession } from "../src/lib/ids.js";
import { openSession } from "../src/lib/session.js";
import { FIXTURE_ROOT, SUBAGENT_ID, fixtureIndex } from "./fixtures/build.js";
import { fx, run } from "./helpers/run.js";

const env = { CLAUDE_CONFIG_DIR: FIXTURE_ROOT };
const widget = { env, cwd: "/src/widget" };
const sprocket = { env, cwd: "/src/sprocket" };

async function failure(p: Promise<unknown>): Promise<AgentSessionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AgentSessionError) return err;
    throw err;
  }
  throw new Error("expected a failure");
}

describe("parseId / formatId", () => {
  it("accepts the printed forms and round-trips them", () => {
    expect(parseId("7a2f1c3e:418")).toEqual({ session: "7a2f1c3e", seq: 418 });
    expect(parseId("7a2f1c3e:418.2")).toEqual({ session: "7a2f1c3e", seq: 418, block: 2 });
    for (const t of ["7a2f1c3e:418", "7a2f1c3e:418.2", "00000000:1"]) expect(formatId(parseId(t)!)).toBe(t);
  });

  it("rejects short sessions, bare seqs, zero seqs and zero blocks", () => {
    for (const t of ["7a2f1c:418", "418", "7a2f1c3e:0", "7a2f1c3e:418.0", "7a2f1c3e9:418", "7a2f1c3e:", "7a2f1c3e:01", "7A2F1C3E:418"]) {
      expect(parseId(t), t).toBeNull();
    }
  });

  it("a bare seq is accepted only when the session is named", async () => {
    expect(parseBareSeq("418")).toEqual({ seq: 418 });
    expect(parseBareSeq("418.2")).toEqual({ seq: 418, block: 2 });
    expect(parseBareSeq("0")).toBeNull();
    const bare = await failure(resolveId("2", widget));
    expect(bare.code).toBe("VALIDATION_ERROR");
    expect(bare.suggestions.join(" ")).toContain("--session");
    const named = await resolveId("2", widget, { session: "a3000003" });
    expect(formatId(named.id)).toBe("a3000003:2");
    expect(named.session.id).toBe("a3000003-0000-4000-8000-000000000000");
    const block = await resolveId("2.3", widget, { session: fx("array-content") });
    expect(formatId(block.id)).toBe("a2000002:2.3");
    // A full id with a session that is not its own.
    expect((await failure(resolveId("a3000003:2", widget, { session: "a6000006" }))).code).toBe("VALIDATION_ERROR");
  });

  it("a short session part is a VALIDATION_ERROR that says why", async () => {
    const e = await failure(resolveId("7a2f1c:418", widget));
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.message).toContain("8 hex characters");
  });
});

describe("ids in --from/--to", () => {
  it("an uppercase id is still an id, not a time", async () => {
    const lower = await run(["events", "a3000003", "--from", "a3000003:3", "--to", "a3000003:9"]);
    const upper = await run(["events", "a3000003", "--from", "A3000003:3", "--to", "A3000003:9"]);
    expect(upper.exitCode).toBe(0);
    expect(upper.stdout.replace(/A3000003/g, "a3000003")).toBe(lower.stdout);
  });
});

describe("resolveSession", () => {
  it("resolves a path (ignoring scope), a full uuid, an agentId and prefixes", async () => {
    const byPath = await resolveSession(fx("hooks"), { env, cwd: "/elsewhere" });
    expect(byPath.short).toBe("aa00000a");
    expect((await resolveSession("aa00000a-0000-4000-8000-000000000000", widget)).short).toBe("aa00000a");
    expect((await resolveSession("aa00000a", widget)).short).toBe("aa00000a");
    expect((await resolveSession("AA00000A", widget)).short).toBe("aa00000a");
    const sub = await resolveSession(SUBAGENT_ID, widget);
    expect(sub.kind).toBe("subagent");
    expect(sub.parent).toBe("ae00000e-0000-4000-8000-000000000000");
    expect((await resolveSession(SUBAGENT_ID.slice(0, 8), widget)).id).toBe(SUBAGENT_ID);
  });

  it("an 8-char prefix separates two sessions that share 7", async () => {
    expect((await resolveSession("c2a4e6f1", sprocket)).id).toBe("c2a4e6f1-0000-4000-8000-000000000000");
    expect((await resolveSession("c2a4e6f9", sprocket)).id).toBe("c2a4e6f9-0000-4000-8000-000000000000");
    expect((await failure(resolveSession("c2a4e6f", sprocket))).code).toBe("VALIDATION_ERROR");
  });

  it("two sessions sharing 8 chars → AMBIGUOUS_SESSION with both candidates; a longer prefix resolves", async () => {
    const e = await failure(resolveSession("c3b5d7e9", sprocket));
    expect(e.code).toBe("AMBIGUOUS_SESSION");
    const ids = (e.details!.candidates as Array<{ id: string }>).map((c) => c.id).sort();
    expect(ids).toEqual(["c3b5d7e9-0000-4000-8000-000000000000", "c3b5d7e9-ffff-4000-8000-000000000000"]);
    expect((e.details!.candidates as Array<{ title: string }>)[0]!.title).toBeDefined();
    expect((await resolveSession("c3b5d7e9-ffff", sprocket)).id).toBe("c3b5d7e9-ffff-4000-8000-000000000000");
    // An id in that namespace is ambiguous too: reported, never resolved by preference.
    expect((await failure(resolveId("c3b5d7e9:1", sprocket))).code).toBe("AMBIGUOUS_SESSION");
  });

  it("scope bounds resolution: another project's session needs --project or --all", async () => {
    expect((await failure(resolveSession("c1000013", widget))).code).toBe("NOT_FOUND");
    expect((await resolveSession("c1000013", { ...widget, project: "all" })).short).toBe("c1000013");
    expect((await resolveSession("c1000013", { ...widget, project: "/src/gadget" })).short).toBe("c1000013");
    expect((await failure(resolveSession("c1000013", { env, cwd: "/elsewhere" }))).code).toBe("NO_SESSIONS");
  });

  it("rejects what is not a reference, and a missing path is NOT_FOUND", async () => {
    expect((await failure(resolveSession("not-a-session", widget))).code).toBe("VALIDATION_ERROR");
    expect((await failure(resolveSession("/does/not/exist.jsonl", widget))).code).toBe("NOT_FOUND");
    expect((await failure(resolveSession("", widget))).code).toBe("VALIDATION_ERROR");
  });
});

describe("latest", () => {
  const tmp = mkdtempSync(join(tmpdir(), "asa-latest-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  cpSync(FIXTURE_ROOT, tmp, { recursive: true });
  const index = fixtureIndex();
  const at = (name: string, iso: string) => {
    const t = new Date(iso);
    utimesSync(join(tmp, index[name]!), t, t);
  };
  for (const name of Object.keys(index)) at(name, "2026-11-01T00:00:00Z");
  at("hooks", "2026-11-05T00:00:00Z");
  at("question", "2026-11-06T00:00:00Z");
  // A subagent file touched later still is not `latest`: it is reached by its agentId.
  at("subagent", "2026-11-07T00:00:00Z");
  const tenv = { CLAUDE_CONFIG_DIR: tmp };

  it("a log not named by a uuid resolves by the short id it prints", async () => {
    cpSync(fx("parallel-tools"), join(tmp, "projects", "-src-widget", "copied-log.jsonl"));
    const listed = await run(["events", join(tmp, "projects", "-src-widget", "copied-log.jsonl"), "--limit", "1"], { env: tenv });
    const s8 = /^session: "?([0-9a-f]{8}) /m.exec(listed.stdout)![1]!;
    expect(s8).not.toBe("a3000003");
    const resolved = await resolveSession(s8, { env: tenv, cwd: "/src/widget" });
    expect(resolved.id).toBe("copied-log");
    const shown = await run(["show", `${s8}:2`], { env: tenv });
    expect(shown.stdout).toMatch(/^kind: call$/m);
    rmSync(join(tmp, "projects", "-src-widget", "copied-log.jsonl"));
  });

  it("a directory named like a reference is not a path; only a regular file is", async () => {
    const cwdDir = join(tmp, "work");
    mkdirSync(join(cwdDir, "latest"), { recursive: true });
    mkdirSync(join(cwdDir, "aa00000a"), { recursive: true });
    const scope = { env: tenv, cwd: cwdDir, project: "/src/widget" };
    expect((await resolveSession("latest", scope)).short).toBe("b2000012");
    expect((await resolveSession("aa00000a", scope)).short).toBe("aa00000a");
  });

  it("an uppercase uuid filename gets a lowercase <s8> that resolves", async () => {
    const upper = join(tmp, "projects", "-src-widget", "AB00000B-0000-4000-8000-0000000000AA.jsonl");
    cpSync(fx("skill"), upper);
    onTestFinished(() => rmSync(upper, { force: true }));
    const s = await openSession(upper);
    expect(s.short).toBe("ab00000b");
    const listed = await run(["events", upper, "--limit", "1"], { env: tenv });
    const id = /^ {2}"([^"]+)"/m.exec(listed.stdout)![1]!;
    expect(id.startsWith("ab00000b:")).toBe(true);
    const shown = await run(["show", id, "--session", "ab00000b-0000-4000-8000-0000000000aa"], { env: tenv });
    expect(shown.exitCode).toBe(0);
  });

  it("is the main session with the newest mtime", async () => {
    expect((await resolveSession("latest", { env: tenv, cwd: "/src/widget" })).short).toBe("b2000012");
  });

  it("tail latest, tail <8-hex prefix> and events <uuid> resolve through resolveSession", async () => {
    const latest = await run(["tail", "latest"], { env: tenv });
    expect(latest.exitCode).toBe(0);
    expect(latest.stdout).toMatch(/^session: "?b2000012 /m);
    const prefix = await run(["tail", "aa00000a", "2"], { env: tenv });
    expect(prefix.stdout).toMatch(/^session: "?aa00000a /m);
    expect(prefix.stdout).toContain("Run `agent-recall-axi prev aa00000a:");
    const uuid = await run(["events", "a3000003-0000-4000-8000-000000000000"], { env: tenv });
    expect(uuid.stdout).toMatch(/^session: "?a3000003 /m);
    const both = await run(["tail", "latest", "--all", "--project", "/src/widget"], { env: tenv });
    expect(both.exitCode).toBe(2);
    expect(both.stdout).toContain("usage: agent-recall-axi tail <session>");
    const sub = await run(["tail", SUBAGENT_ID.slice(0, 8)], { env: tenv });
    expect(sub.stdout).toMatch(/^kind: subagent$/m);
    expect(sub.stdout).toMatch(/^parent: ae00000e$/m);
  });
});
