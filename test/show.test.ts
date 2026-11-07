import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FIXTURE_ROOT, LONG_URL } from "./fixtures/build.js";
import { fx, run } from "./helpers/run.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-show-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const field = (out: string, name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(out)?.[1];

describe("show", () => {
  it("a call: input, result, result_status, result_text, authority C", async () => {
    const { stdout, exitCode } = await run(["show", "a3000003:2"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^event: "a3000003:2"$/m);
    expect(stdout).toMatch(/^t: "2026-11-07 13:40:04 UTC"$/m);
    expect(stdout).toMatch(/^kind: call$/m);
    expect(stdout).toMatch(/^authority: C$/m);
    expect(stdout).toMatch(/^turn: "a3000003:1"$/m);
    expect(stdout).toMatch(/^window: 0$/m);
    expect(stdout).toMatch(/^input:\n {2}command: bun test src\/widget.test.ts\n {2}description: Run tests$/m);
    expect(stdout).toMatch(/^result: "a3000003:8"$/m);
    expect(stdout).toMatch(/^result_status: error 42$/m);
    expect(stdout).toContain('result_text: "FAIL src/widget.test.ts\\n  expected 2 got 3"');
    expect(stdout).toMatch(/^uuid: a3000003-0000-4000-8000-000000000002$/m);
    expect(stdout).not.toContain("help[");
  });

  it("a result prints its call; a compaction its trigger, tokens, summary and preserved count", async () => {
    const result = await run(["show", "a3000003:5"]);
    expect(result.stdout).toMatch(/^kind: result$/m);
    expect(result.stdout).toMatch(/^authority: D$/m);
    expect(result.stdout).toMatch(/^call: "a3000003:3"$/m);
    expect(result.stdout).toMatch(/^text: lint clean$/m);
    const c = await run(["show", "a6000006:3"]);
    expect(c.stdout).toMatch(/^kind: compaction$/m);
    expect(field(c.stdout, "trigger")).toBe("auto");
    expect(field(c.stdout, "pre_tokens")).toBe("998600");
    expect(field(c.stdout, "post_tokens")).toBe("25100");
    expect(field(c.stdout, "dropped_tokens")).toBe("973500");
    expect(field(c.stdout, "summary")).toBe('"a6000006:4"');
    expect(field(c.stdout, "preserved")).toBe("2 events");
    // The summary after a boundary opens the next window.
    const summary = await run(["show", "a6000006:4"]);
    expect(field(summary.stdout, "window")).toBe("1");
    expect(field(summary.stdout, "compaction")).toBe('"a6000006:3"');
    expect(field(summary.stdout, "authority")).toBe("C");
  });

  it("every kind prints its authority", async () => {
    const human = await run(["show", "a1000001:2"]);
    expect(field(human.stdout, "authority")).toBe("H");
    expect(field(human.stdout, "text")).toBe("the widget listing loops back to itself after the callback; can you look?");
    const queued = await run(["show", "a8000008:3"]);
    expect(field(queued.stdout, "kind")).toBe("human.queued");
    expect(field(queued.stdout, "authority")).toBe("H");
  });

  it("a bare id of a multi-event entry prints blocks[4] with .1..4; <id>.3 prints only the third", async () => {
    const all = await run(["show", "b4000015:3"]);
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toMatch(/^entry: "b4000015:3"$/m);
    expect(all.stdout).toMatch(/^blocks\[4\]:$/m);
    for (const n of [1, 2, 3, 4]) expect(all.stdout).toContain(`  - event: "b4000015:3.${n}"`);
    const third = await run(["show", "b4000015:3.3"]);
    expect(third.stdout).toMatch(/^event: "b4000015:3.3"$/m);
    expect(third.stdout).toMatch(/^tool: Grep$/m);
    expect(third.stdout).toMatch(/^result: "b4000015:4.1"$/m);
    expect(third.stdout).not.toContain("b4000015:3.2");
    expect(third.stdout).not.toContain("blocks[");
    const none = await run(["show", "b4000015:3.5"]);
    expect(none.exitCode).toBe(1);
    expect(none.stdout).toMatch(/^code: NOT_FOUND$/m);
    expect(none.stdout).toContain("b4000015:3.1, b4000015:3.2, b4000015:3.3, b4000015:3.4");
    const single = await run(["show", "a3000003:2.1"]);
    expect(single.exitCode).toBe(1);
    expect(single.stdout).toContain("is a single event; its id is a3000003:2");
  });

  it("a persisted result: pointer (exists) + preview; --full prints the file; deleted → (missing), exit 0", async () => {
    const p = await run(["show", "a4000004:3"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout).toMatch(/^pointer: ".*tool-results\/bfx0001\.txt \(42\.8k, exists\)"$/m);
    expect(p.stdout).toMatch(/^preview: "widget gadget sprocket/m);
    expect(p.stdout).toContain("Run `agent-session-axi show a4000004:3 --full` for the persisted output (42.8k)");
    const full = await run(["show", "a4000004:3", "--full"]);
    const text = JSON.parse(field(full.stdout, "text")!) as string;
    expect(text.length).toBe(42_800);
    expect(full.stdout).not.toMatch(/^preview:/m);
    expect(full.stdout).not.toContain("help[");
    // The call's result_text follows the same pointer.
    const call = await run(["show", "a4000004:2"]);
    expect(call.stdout).toMatch(/^result_status: persisted 42\.8k$/m);
    expect(call.stdout).toMatch(/^pointer: .*\(42\.8k, exists\)"$/m);

    // A copy whose persisted file is gone.
    const root = join(tmp, "missing");
    const dir = join(root, "projects", "-src-widget");
    cpSync(dirname(fx("persisted-output")), dir, { recursive: true });
    rmSync(join(dir, "a4000004-0000-4000-8000-000000000000", "tool-results"), { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: root };
    for (const args of [["show", "a4000004:3"], ["show", "a4000004:3", "--full"]]) {
      const gone = await run(args, { env });
      expect(gone.exitCode, args.join(" ")).toBe(0);
      expect(gone.stdout).toMatch(/^pointer: ".*bfx0001\.txt \(42\.8k, missing\)"$/m);
      expect(gone.stdout).toMatch(/^preview: "widget gadget/m);
      expect(gone.stdout).not.toContain("--full` for the persisted output");
    }
  });

  it("a silent seq prints kind: silent + raw and hints the nearest event ids", async () => {
    const { stdout, exitCode } = await run(["show", "b4000015:2"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^entry: "b4000015:2"$/m);
    expect(stdout).toMatch(/^kind: silent$/m);
    expect(stdout).toMatch(/^type: file-history-snapshot$/m);
    expect(stdout).toMatch(/^raw:\n {2}type: file-history-snapshot$/m);
    expect(stdout).toContain("Run `agent-session-axi show b4000015:1` for the nearest event before");
    expect(stdout).toContain("Run `agent-session-axi show b4000015:3.1` for the nearest event after");
    const malformed = await run(["show", "af00000f:21"]);
    expect(malformed.exitCode).toBe(0);
    expect(malformed.stdout).toMatch(/^malformed: true$/m);
    expect(malformed.stdout).toContain('raw: "{\\"type\\":\\"user\\"');
  });

  it("an id beyond the end → NOT_FOUND with the line count and a tail hint", async () => {
    const { stdout, exitCode } = await run(["show", "a3000003:9999"]);
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^error: "a3000003:9999 is beyond the end of the session \(10 lines\)"$/m);
    expect(stdout).toMatch(/^code: NOT_FOUND$/m);
    expect(stdout).toContain("Run `agent-session-axi tail a3000003` for the last rows of this session");
    const scoped = await run(["show", "c1000013:50", "--all"]);
    expect(scoped.stdout).toContain("Run `agent-session-axi tail c1000013 --all`");
  });

  it("--raw prints the stored line for any seq; --fields keeps only the named fields", async () => {
    const raw = await run(["show", "a3000003:2.1", "--raw"]);
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout).toMatch(/^entry: "a3000003:2"$/m);
    expect(raw.stdout).toMatch(/^raw:$/m);
    expect(raw.stdout).toContain("    stop_reason: tool_use");
    const some = await run(["show", "a3000003:2", "--fields", "authority,result_status"]);
    expect(some.stdout).toBe('event: "a3000003:2"\nauthority: C\nresult_status: error 42\n');
    const bad = await run(["show", "a3000003:2", "--fields", "bogus"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
  });

  it("text over 4,000 chars ends with the house marker and the --full hint; under the cap, no hint", async () => {
    const long = await run(["show", "b5000016:7"]);
    const text = JSON.parse(field(long.stdout, "text")!) as string;
    expect(text.endsWith(" … (truncated, 4500 chars total)")).toBe(true);
    expect(text.length).toBe(4000 + " … (truncated, 4500 chars total)".length);
    expect(long.stdout).toContain("Run `agent-session-axi show b5000016:7 --full` for the complete text (4.5k chars)");
    const whole = await run(["show", "b5000016:7", "--full"]);
    expect((JSON.parse(field(whole.stdout, "text")!) as string).length).toBe(4500);
    expect(whole.stdout).not.toContain("help[");
    const short = await run(["show", "b5000016:8"]);
    expect(field(short.stdout, "text")).toBe("Short reply.");
    expect(short.stdout).not.toContain("help[");
    // A call's linked result over the cap.
    const call = await run(["show", "b5000016:3"]);
    expect(call.stdout).toContain(" … (truncated, 5000 chars total)");
    expect(call.stdout).toContain("Run `agent-session-axi show b5000016:3 --full` for the complete result (5.0k chars)");
  });

  it("zoom output is byte-identical to show for the same arguments", async () => {
    for (const args of [["a3000003:2"], ["b4000015:3"], ["a4000004:3", "--full"], ["b4000015:2"], ["a3000003:2", "--raw"], ["a3000003:9999"], ["7a2f1c:1"], ["418"]]) {
      const a = await run(["show", ...args]);
      const b = await run(["zoom", ...args]);
      expect(b.stdout, args.join(" ")).toBe(a.stdout);
      expect(b.exitCode).toBe(a.exitCode);
    }
    const help = await run(["zoom", "--help"]);
    expect(help.stdout).toMatch(/^alias of: show$/m);
  });

  it("a bare seq works only with --session; bad ids are usage errors", async () => {
    const bare = await run(["show", "418"]);
    expect(bare.exitCode).toBe(2);
    expect(bare.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    const named = await run(["show", "2", "--session", "a3000003"]);
    expect(named.stdout).toMatch(/^event: "a3000003:2"$/m);
    const byPath = await run(["show", "2", "--session", fx("parallel-tools")], { cwd: "/elsewhere" });
    expect(byPath.stdout).toMatch(/^event: "a3000003:2"$/m);
    for (const id of ["7a2f1c:418", "7a2f1c3e:0", "7a2f1c3e:418.0"]) {
      const r = await run(["show", id]);
      expect(r.exitCode, id).toBe(2);
      expect(r.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    }
    const none = await run(["show"]);
    expect(none.exitCode).toBe(2);
    expect(none.stdout).toMatch(/^code: USAGE$/m);
  });
});

describe("rows: truncation and --fields", () => {
  const rows = (out: string, label: string) => {
    const lines = out.split("\n");
    const i = lines.findIndex((l) => l.startsWith(`${label}[`));
    return lines.slice(i + 1, i + 1 + Number(/\[(\d+)\]/.exec(lines[i]!)![1]));
  };

  it("a 300-char head ends with … and the footer counts it and names show <id>", async () => {
    const { stdout } = await run(["events", "b5000016"]);
    const first = rows(stdout, "events")[0]!;
    const text = first.slice(first.indexOf(",human,") + 7);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBe(201);
    expect(stdout).toContain("for the whole text of the 4 rows cut to 200 chars");
    expect(stdout).toContain("Run `agent-session-axi show b5000016:1` to see one cut row whole");
  });

  it("a URL spanning the cut is kept whole; a call's target path is never cut", async () => {
    const { stdout } = await run(["events", "b5000016"]);
    const r = rows(stdout, "events");
    expect(r[1]).toContain(`${LONG_URL}…`);
    // The Read target is a path over 120 chars: kept whole, not cut.
    expect(r[2]).toMatch(/,call,Read src\/widget\/.*\/on-click-handler\.ts → ok 5\.0k$/);
    // Inside a shell command the path is kept whole and the rest of the target is cut.
    expect(r[3]).toMatch(/cat src\/widget\/.*\/on-click-handler\.ts… → ok 28$/);
  });

  it("--fields authority adds H|C|D per authority.md", async () => {
    const { stdout } = await run(["events", "a3000003", "--kind", "all", "--fields", "authority"]);
    expect(stdout).toContain("events[10]{id,t,kind,text,authority}:");
    const byKind = new Map(rows(stdout, "events").map((r) => [r.split(",")[2], r.split(",").at(-1)]));
    expect(byKind.get("human")).toBe("H");
    expect(byKind.get("call")).toBe("C");
    expect(byKind.get("assistant")).toBe("C");
    expect(byKind.get("result")).toBe("D");
    expect(byKind.get("hook")).toBe("D");
    const tail = await run(["tail", "a3000003", "2", "--fields", "authority,result"]);
    expect(tail.stdout).toContain("tail[2]{id,t,kind,text,authority,result}:");
    const bad = await run(["events", "a3000003", "--fields", "authorty"]);
    expect(bad.exitCode).toBe(2);
  });
});

void FIXTURE_ROOT;
