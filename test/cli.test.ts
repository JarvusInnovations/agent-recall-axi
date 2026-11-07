import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLarge } from "./fixtures/build.js";
import { fx, run } from "./helpers/run.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-cli-"));
const long = join(tmp, "f0000099-0000-4000-8000-000000000000.jsonl");
beforeAll(async () => {
  await buildLarge(long, 200_000);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const rowLines = (out: string, label: string) => {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${label}[`));
  if (i === -1) return [];
  const n = Number(/\[(\d+)\]/.exec(lines[i]!)![1]);
  return lines.slice(i + 1, i + 1 + n);
};

describe("events", () => {
  it("prints events[N]{id,t,kind,text} with full ids and a day: header for a one-day session", async () => {
    const { stdout, exitCode } = await run(["events", fx("parallel-tools")]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("events[7]{id,t,kind,text}:");
    expect(stdout).toMatch(/^session: a3000003/m);
    expect(stdout).toMatch(/^day: 2026-11-07$/m);
    expect(stdout).toMatch(/^tz: UTC$/m);
    expect(stdout).toMatch(/^count: 7 of 7$/m);
    const rows = rowLines(stdout, "events");
    expect(rows[0]).toMatch(/^ {2}"a3000003:1","13:40:02",human,/);
    expect(stdout).toContain("Bash bun test src/widget.test.ts → error 42");
    expect(stdout).toContain("Read config/staging.env → ok 77");
    expect(stdout).toContain("Edit src/widget.ts → pending");
    // thinking and result rows are hidden by default
    expect(rows.some((r) => r.includes(",result,"))).toBe(false);
  });

  it("uses MM-DD HH:MM:SS and days: for a two-day session", async () => {
    const { stdout } = await run(["events", fx("two-day")]);
    expect(stdout).toMatch(/^days: 2026-11-07\.\.2026-11-08$/m);
    expect(stdout).toContain('"b1000011:3","11-08 00:05:02",human,');
    expect(stdout).not.toMatch(/^day:/m);
  });

  it("--kind all shows thinking and result rows", async () => {
    const def = await run(["events", fx("thinking")]);
    expect(def.stdout).not.toContain(",thinking,");
    const all = await run(["events", fx("thinking"), "--kind", "all"]);
    expect(all.stdout).toContain(",thinking,The flange loop allocates on every pass.");
    const res = await run(["events", fx("parallel-tools"), "--kind=all"]);
    expect(res.stdout).toContain(',result,"error: FAIL src/widget.test.ts expected 2 got 3"');
    const only = await run(["events", fx("parallel-tools"), "--kind", "result"]);
    expect(rowLines(only.stdout, "events")).toHaveLength(3);
  });

  it("selects by position with ids (inclusive start, exclusive end) and by time", async () => {
    const byId = await run(["events", fx("parallel-tools"), "--from", "a3000003:3", "--to", "a3000003:9"]);
    const ids = rowLines(byId.stdout, "events").map((r) => r.split(",")[0]);
    expect(ids).toEqual(['  "a3000003:3"', '  "a3000003:4"', '  "a3000003:6"']);
    const byTime = await run(["events", fx("two-day"), "--from", "2026-11-08"]);
    expect(rowLines(byTime.stdout, "events")).toHaveLength(2);
    const since = await run(["events", fx("two-day"), "--since", "30m"], { now: new Date("2026-11-08T00:30:00Z") });
    expect(rowLines(since.stdout, "events")).toHaveLength(2);
  });

  it("an empty session says so, with the malformed count in the header, exit 0", async () => {
    const { stdout, exitCode } = await run(["events", fx("silent")]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^malformed: 1 line$/m);
    expect(stdout).toMatch(/^events: 0 events in af00000f/m);
  });

  it("unknown flags fail with the valid set inline (exit 2)", async () => {
    const { stdout, exitCode } = await run(["events", fx("thinking"), "--bogus"]);
    expect(exitCode).toBe(2);
    expect(stdout).toMatch(/^error: unknown flag --bogus for `events`$/m);
    expect(stdout).toMatch(/^code: UNKNOWN_FLAG$/m);
    expect(stdout).toContain("valid flags for `events`: --from, --to, --since, --kind, --limit, --head, --full");
    const renamed = await run(["events", fx("thinking"), "--until", "now"]);
    expect(renamed.stdout).toContain("use --to");
  });

  it("a leading flag gets the SDK's error", async () => {
    const { stdout, exitCode } = await run(["--kind", "all", "events"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Flags must come after the command");
  });

  it("validates values before opening files", async () => {
    const bad = await run(["events", "/does/not/exist.jsonl", "--from", "whenever"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    const missing = await run(["events", "/does/not/exist.jsonl"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toMatch(/^code: NOT_FOUND$/m);
    const kind = await run(["events", fx("thinking"), "--kind", "humans"]);
    expect(kind.exitCode).toBe(2);
  });

  it("--tz changes rendered times and the tz header; TZ is honored without the flag", async () => {
    const tokyo = await run(["events", fx("two-day"), "--tz", "Asia/Tokyo"]);
    expect(tokyo.stdout).toMatch(/^tz: Asia\/Tokyo$/m);
    expect(tokyo.stdout).toMatch(/^day: 2026-11-08$/m); // both days fall on 11-08 in Tokyo
    expect(tokyo.stdout).toContain('"b1000011:1","08:50:02"');
    const env = await run(["events", fx("two-day")], { env: { TZ: "Asia/Tokyo" } });
    expect(env.stdout).toBe(tokyo.stdout.replace(/ --tz Asia\/Tokyo/g, ""));
    const ny = await run(["events", fx("parallel-tools"), "--tz", "America/New_York"]);
    expect(ny.stdout).toContain('"a3000003:1","08:40:02"');
  });

  it("output is deterministic for the same file and arguments", async () => {
    const a = await run(["events", fx("compaction"), "--kind", "all"]);
    const b = await run(["events", fx("compaction"), "--kind", "all"], { now: new Date("2030-01-01T00:00:00Z") });
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain('compaction,"compacted auto 998.6k→25.1k, summary a6000006:4"');
  });
});

describe("tail", () => {
  it("prints the last 20 visible rows by default", async () => {
    const { stdout, exitCode } = await run(["tail", long]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tail[20]{id,t,kind,text}:");
    expect(stdout).toMatch(/^count: 20 \(newest; earlier rows exist\)$/m);
    expect(stdout).toMatch(/Run `agent-session-axi events .* --to f0000099:\d+` for earlier rows/);
  });

  it("`tail <s> 5` and `--limit 5` agree", async () => {
    const a = await run(["tail", long, "5"]);
    const b = await run(["tail", long, "--limit", "5"]);
    expect(a.stdout).toBe(b.stdout);
    expect(rowLines(a.stdout, "tail")).toHaveLength(5);
    const clash = await run(["tail", long, "5", "--limit", "6"]);
    expect(clash.exitCode).toBe(2);
  });

  it("tail rows equal the last rows of a full forward listing", async () => {
    const t = rowLines((await run(["tail", long, "30", "--kind", "all"])).stdout, "tail");
    const e = rowLines((await run(["events", long, "--kind", "all", "--limit", "0"])).stdout, "events");
    expect(t).toEqual(e.slice(-30));
  });

  it("a session shorter than n shows everything with an exact count", async () => {
    const { stdout } = await run(["tail", fx("hooks")]);
    expect(stdout).toMatch(/^count: 7 of 7$/m);
  });
});

describe("sessions and home", () => {
  it("lists the current project's sessions with the minimal schema", async () => {
    const { stdout, exitCode } = await run(["sessions", "--limit", "3"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^project: \/src\/widget \(19 sessions\)$/m);
    expect(stdout).toMatch(/^count: 3 of 19$/m);
    expect(stdout).toContain("sessions[3]{id,started,last,title}:");
    expect(stdout).toContain('b1000011,"11-07 23:50","11-08 00:05 (0s ago)",(pending)');
  });

  it("--subagents adds kind and parent; --fields adds columns", async () => {
    const { stdout } = await run(["sessions", "--subagents", "--limit", "0", "--fields", "uuid"]);
    expect(stdout).toContain("{id,started,last,title,kind,parent,uuid}");
    expect(stdout).toMatch(/ae0f1e2d,.*,subagent,ae00000e,ae0f1e2d3c4b5a697/);
    const bad = await run(["sessions", "--fields", "turns"]);
    expect(bad.exitCode).toBe(2);
  });

  it("--project /nonexistent → NO_SESSIONS naming --project and --all, no stack trace", async () => {
    const { stdout, exitCode } = await run(["sessions", "--project", "/nonexistent"]);
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^code: NO_SESSIONS$/m);
    expect(stdout).toContain("--project <path>");
    expect(stdout).toContain("--all");
    expect(stdout).not.toMatch(/\n\s+at /);
  });

  it("the home view lists the project's sessions, or every project's when the cwd has none", async () => {
    const here = await run([]);
    expect(here.stdout).toMatch(/^description: /m);
    expect(here.stdout).toMatch(/^project: \/src\/widget \(19 sessions\)$/m);
    expect(here.stdout).toContain("sessions[5]{id,last,title}:");
    expect(here.stdout).toMatch(/^latest: b1000011$/m);
    const none = await run([], { cwd: "/elsewhere" });
    expect(none.stdout).toMatch(/^project: none for \/elsewhere$/m);
    expect(none.stdout).toContain("sessions[5]{id,last,title}:");
  });
});

describe("help, planned commands, update", () => {
  it("--help lists commands, marks planned ones, and shows no SDK built-in block", async () => {
    const { stdout } = await run(["--help"]);
    expect(stdout).toContain("events <session>");
    expect(stdout).toContain("(planned: ids-and-show)");
    expect(stdout).not.toContain("built-in");
    const cmd = await run(["events", "--help"]);
    expect(cmd.stdout).toMatch(/^command: events$/m);
    expect(cmd.stdout).toContain("--window <k|last|all>");
    const short = await run(["tail", "-h"]);
    expect(short.stdout).toMatch(/^command: tail$/m);
  });

  it("a planned command says so instead of failing obscurely", async () => {
    const { stdout, exitCode } = await run(["find", "x"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("planned: find");
    const flag = await run(["events", fx("thinking"), "--window", "last"]);
    expect(flag.exitCode).toBe(2);
    expect(flag.stdout).toContain("planned: views");
  });

  it("update and update --check print the version and both update commands", async () => {
    const npm = await run(["update"], { entrypoint: "/usr/lib/node_modules/agent-session-axi/dist/bin/agent-session-axi.js" });
    expect(npm.exitCode).toBe(0);
    expect(npm.stdout).toMatch(/^update: agent-session-axi \S+ \(npm install\)$/m);
    expect(npm.stdout.indexOf("npm i -g")).toBeLessThan(npm.stdout.indexOf("npx skills update"));
    const skill = await run(["update", "--check"], { entrypoint: "/opt/agents/skills/agent-session-axi/scripts/agent-session-axi.mjs" });
    expect(skill.exitCode).toBe(0);
    expect(skill.stdout).toMatch(/\(skill install\)/);
    expect(skill.stdout.indexOf("npx skills update")).toBeLessThan(skill.stdout.indexOf("npm i -g"));
  });
});
