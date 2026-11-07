import { describe, expect, it } from "vitest";
import { listEvents } from "../src/lib/events.js";
import { formatId } from "../src/lib/ids.js";
import { AUTHORITY, KINDS, type Event, type Kind } from "../src/lib/model.js";
import { openSession } from "../src/lib/session.js";
import { fixtures, QUEUED_PROMPT, SUBAGENT_ID } from "./fixtures/build.js";
import { fx } from "./helpers/run.js";

async function all(name: string) {
  const session = await openSession(fx(name));
  return listEvents(session, { kinds: "all", limit: 0 });
}
async function eventsOf(name: string): Promise<Event[]> {
  return (await all(name)).rows;
}
const byKind = (evs: Event[], k: Kind) => evs.filter((e) => e.kind === k);

describe("classify: kinds and authority", () => {
  it("produces every kind in data-model.md#kinds at least once, with its authority", async () => {
    const seen = new Map<Kind, Event>();
    for (const f of fixtures()) for (const ev of await eventsOf(f.name)) if (!seen.has(ev.kind)) seen.set(ev.kind, ev);
    for (const k of KINDS) {
      expect(seen.has(k), `kind ${k}`).toBe(true);
      expect(seen.get(k)!.authority).toBe(AUTHORITY[k]);
    }
    expect(AUTHORITY.human).toBe("H");
    expect(AUTHORITY["human.answer"]).toBe("H");
    expect(AUTHORITY.summary).toBe("C");
    expect(AUTHORITY.call).toBe("C");
    expect(AUTHORITY.result).toBe("D");
    expect(AUTHORITY.compaction).toBe("D");
  });

  it("string and array content both yield human and assistant", async () => {
    const s = await eventsOf("string-content");
    expect(s.map((e) => e.kind)).toEqual(["human", "assistant", "human", "assistant"]);
    expect(s[2]!.text).toBe("also\n\nkeep the old redirect for staging");
    const a = await eventsOf("array-content");
    expect(a[0]!.kind).toBe("human");
    // Two contiguous text blocks merge; the call keeps its own block index.
    expect(formatId(a[1]!.id)).toBe("a2000002:2.1");
    expect(a[1]!.text).toBe("Two parts to this.\n\nFirst the table, then the pager.");
    expect(formatId(a[2]!.id)).toBe("a2000002:2.3");
    expect(a[2]!.kind).toBe("call");
    expect(a[2]!.files).toContain("src/gadget/list.ts");
  });

  it("an entry that yields one event gets the entry id form", async () => {
    const s = await eventsOf("string-content");
    expect(s.every((e) => e.id.block === undefined)).toBe(true);
  });
});

describe("classify: tool-call linkage", () => {
  it("links results to calls by id, not adjacency (parallel, out of order)", async () => {
    const evs = await eventsOf("parallel-tools");
    const calls = byKind(evs, "call");
    const results = byKind(evs, "result");
    const [test, lint, read, edit] = calls;
    // The Read call's result lands three entries after the call, after the lint result and a hook.
    expect(formatId(read!.id)).toBe("a3000003:4");
    expect(formatId(read!.result!)).toBe("a3000003:7");
    const readResult = results.find((r) => formatId(r.id) === "a3000003:7")!;
    expect(formatId(readResult.call!)).toBe("a3000003:4");
    expect(readResult.tool).toBe("Read");
    // Interleaved: lint's result arrives first and links to lint, not to the first call.
    expect(formatId(lint!.result!)).toBe("a3000003:5");
    expect(formatId(results[0]!.call!)).toBe("a3000003:3");
    // The test call's result arrives last and is an error.
    expect(formatId(test!.result!)).toBe("a3000003:8");
    expect(test!.status).toEqual({ state: "error", size: results[2]!.size });
    expect(results[2]!.error).toBe(true);
    // No result in the file yet.
    expect(edit!.status).toEqual({ state: "pending" });
    expect(edit!.result).toBeUndefined();
    // Files touched join the call's input paths and the result's toolUseResult paths.
    expect(read!.files).toEqual(["config/staging.env"]);
    expect(test!.target).toBe("bun test src/widget.test.ts");
    expect(test!.files).toEqual(["src/widget.test.ts"]);
  });

  it("a question tool's result is human.answer", async () => {
    const evs = await eventsOf("question");
    const answer = byKind(evs, "human.answer")[0]!;
    expect(answer.authority).toBe("H");
    expect(answer.text).toContain('"Which channel?"="beta"');
    expect(formatId(answer.call!)).toBe("b2000012:2");
  });

  it("a subagent call learns its agent id from the result", async () => {
    const evs = await eventsOf("subagent-parent");
    const call = byKind(evs, "call")[0]!;
    expect(call.tool).toBe("Agent");
    expect(call.target).toBe("Survey gadgets");
    expect(call.agent).toBe(SUBAGENT_ID);
  });

  it("a subagent's prompt from its parent is not human", async () => {
    const session = await openSession(fx("subagent"));
    expect(session.kind).toBe("subagent");
    expect(session.short).toBe(SUBAGENT_ID.slice(0, 8));
    expect(session.parent).toMatch(/^ae00000e-/);
    const evs = (await listEvents(session, { kinds: "all", limit: 0 })).rows;
    expect(evs[0]!.kind).toBe("notice");
    expect(evs.filter((e) => e.authority === "H")).toHaveLength(0);
  });
});

describe("classify: pointers", () => {
  it("parses a <persisted-output> pointer whose file exists", async () => {
    const evs = await eventsOf("persisted-output");
    const result = byKind(evs, "result")[0]!;
    expect(result.pointer).toBeDefined();
    expect(result.pointer!.bytes).toBe(42_800);
    expect(result.pointer!.exists).toBe(true);
    expect(result.pointer!.path).toMatch(/tool-results\/bfx0001\.txt$/);
    expect(result.pointer!.stored).toMatch(/^\/fixture-root\//);
    expect(result.pointer!.preview.length).toBeGreaterThan(1000);
    const call = byKind(evs, "call")[0]!;
    expect(call.status).toEqual({ state: "persisted", size: 42_800 });
  });

  it("a pointer to a missing file (unwrapped older notice) is exists: false, no error", async () => {
    const listing = await all("persisted-missing");
    const result = byKind(listing.rows, "result")[0]!;
    expect(result.pointer!.exists).toBe(false);
    expect(result.pointer!.bytes).toBe(12_500);
    expect(result.error).toBe(false);
  });
});

describe("classify: compaction", () => {
  it("structured boundary → compaction with meta, followed by its summary", async () => {
    const evs = await eventsOf("compaction");
    const i = evs.findIndex((e) => e.kind === "compaction");
    const c = evs[i]!;
    expect(c.meta).toMatchObject({ trigger: "auto", pre_tokens: 998_600, post_tokens: 25_100, dropped_tokens: 973_500 });
    expect((c.meta!.preserved as string[]).length).toBe(2);
    const summary = evs[i + 1]!;
    expect(summary.kind).toBe("summary");
    expect(summary.authority).toBe("C");
    expect(formatId(c.meta!.summary as never)).toBe(formatId(summary.id));
  });

  it("the summary-only legacy form still yields summary", async () => {
    const evs = await eventsOf("compaction-legacy");
    expect(evs[0]!.kind).toBe("summary");
    expect(byKind(evs, "compaction")).toHaveLength(0);
  });
});

describe("classify: human variants", () => {
  it("human.queued text is attachment.prompt exactly", async () => {
    const evs = await eventsOf("queued-command");
    const queued = byKind(evs, "human.queued");
    expect(queued[0]!.text).toBe(QUEUED_PROMPT);
    expect(queued[0]!.text).not.toContain("system-reminder");
    // promptSource == "queued" on a user entry is human.queued too.
    expect(queued[1]!.text).toBe("and bump the version afterwards");
    // A queued_command with a non-human origin is never human.queued.
    const task = byKind(evs, "notice.task")[0]!;
    expect(task.agent).toBe("b0c0d0e0f0a0b0c0d");
    expect(task.meta).toMatchObject({ status: "completed" });
  });

  it("a slash command yields /name args", async () => {
    const evs = await eventsOf("slash-command");
    const slash = byKind(evs, "human.slash");
    expect(slash[0]!.text).toBe("/review src/widget.ts --strict");
    expect(slash[0]!.meta).toMatchObject({ command: "/review", message: "review" });
    expect(slash[1]!.text).toBe("/compact");
  });

  it("hooks, skills and notices", async () => {
    const hooks = byKind(await eventsOf("hooks"), "hook");
    expect(hooks.map((h) => h.meta!.hook)).toEqual(["SessionStart", "PreToolUse", "Stop"]);
    expect(hooks[0]!.meta!.exit).toBe(0);
    const skill = byKind(await eventsOf("skill"), "skill")[0]!;
    expect(skill.meta).toMatchObject({ skill: "release", path: "/src/widget/.skills/release" });
    const notices = await eventsOf("notices");
    expect(notices[0]).toMatchObject({ kind: "notice", text: "The date has changed." });
    expect(byKind(notices, "human").map((e) => e.text)).toEqual(["what does this screenshot show?"]);
    expect(byKind(notices, "notice.task")).toHaveLength(1);
  });
});

describe("classify: silent, unknown, malformed", () => {
  it("yields zero events and counts one malformed line", async () => {
    const listing = await all("silent");
    expect(listing.rows).toHaveLength(0);
    expect(listing.malformed).toBe(1);
  });
});
